import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import * as crypto from 'crypto';
import {
  IdempotencyKey,
  IdempotencyScope,
  IdempotencyStatus,
} from 'src/common/entities/idempotency-key.entity';

/** PostgreSQL unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const IDEMPOTENCY_REQUEST_IN_PROGRESS =
  'IDEMPOTENCY_REQUEST_IN_PROGRESS';

export interface IdempotentReplay<T> {
  replayed: true;
  responseStatus: number | null;
  responseBody: T;
}

export interface IdempotentFresh {
  replayed: false;
  /** Row id, needed to complete the record once the business effect succeeds. */
  recordId: number;
}

export type IdempotencyClaim<T> = IdempotentReplay<T> | IdempotentFresh;

/**
 * Request-level replay protection (see IdempotencyKey entity for the protocol).
 *
 * WHY THE UNIQUE CONSTRAINT IS THE PRIMITIVE. The obvious implementation —
 * "SELECT, and INSERT if absent" — has a window between the two statements in
 * which a duplicate request also finds nothing and also inserts. A POS sale
 * retried by a flaky terminal would then be charged twice. Letting the INSERT
 * itself fail with 23505 collapses check and claim into one atomic operation,
 * so exactly one caller can ever win a given (scope, key).
 *
 * WHY THE SAVEPOINT IS NOT OPTIONAL. In PostgreSQL *any* error aborts the
 * enclosing transaction: every subsequent statement fails with
 * `25P02 current transaction is aborted`. Catching the 23505 and then running
 * the follow-up SELECT on the same manager therefore does not work — the
 * lookup itself throws, the caller gets a 500, and the entire
 * reuse/in-progress/replay branch below is dead code. Wrapping just the INSERT
 * in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` rewinds only the failed statement
 * and leaves the transaction usable, which is what makes the 409 and the replay
 * reachable at all.
 *
 * WHY IT MUST SHARE THE CALLER'S TRANSACTION. Every method takes an
 * EntityManager and never opens a transaction of its own. The key row and the
 * business effect commit together: if the sale rolls back, so does its key, and
 * the client is free to retry. If the key were written in a separate
 * transaction, a rolled-back sale would leave a key behind that permanently
 * blocks the retry of a sale that never happened.
 *
 * CALL IT AS THE FIRST WRITE of the business transaction, before any row locks
 * are taken: a concurrent request with the same key then blocks on the unique
 * index (the serialisation we want) while holding no other locks, so it cannot
 * deadlock against a POS sale's `FOR UPDATE` ordering.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Canonical sha256 of a request payload. Object keys are sorted recursively
   * so that two semantically identical bodies that differ only in key order
   * hash the same — otherwise a client library that reorders JSON keys would
   * look like a key-reuse attack.
   */
  hashRequest(payload: unknown): string {
    return crypto
      .createHash('sha256')
      .update(canonicalize(payload))
      .digest('hex');
  }

  /**
   * Read-only fast path, safe to run OUTSIDE the business transaction: returns
   * the stored response for an already-completed request so a plain retry never
   * opens a write transaction at all. Returns null when the caller must proceed
   * to `claim()`, which remains the authoritative check.
   */
  async peek<T = unknown>(
    manager: EntityManager,
    scope: IdempotencyScope,
    key: string,
    requestHash: string,
  ): Promise<IdempotentReplay<T> | null> {
    const existing = await manager
      .getRepository(IdempotencyKey)
      .findOne({ where: { scope, key } });

    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw keyReused();
    if (existing.status !== IdempotencyStatus.COMPLETED) return null;

    return {
      replayed: true,
      responseStatus: existing.responseStatus,
      responseBody: existing.responseBody as T,
    };
  }

  /**
   * Claims `(scope, key)` for this request.
   *
   * - fresh claim              -> `{ replayed: false, recordId }`, caller proceeds
   * - completed earlier        -> `{ replayed: true, responseBody }`, caller returns it verbatim
   * - same key, different body -> 409 IDEMPOTENCY_KEY_REUSED
   * - still running elsewhere  -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
   *
   * The transaction stays usable in every branch.
   */
  async claim<T = unknown>(
    manager: EntityManager,
    scope: IdempotencyScope,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyClaim<T>> {
    // Savepoint names are identifiers, not parameters, so they cannot be bound.
    // A random hex suffix keeps them unique under nesting and makes the name
    // un-injectable regardless of caller input.
    const savepoint = `sp_idem_${crypto.randomBytes(8).toString('hex')}`;
    await manager.query(`SAVEPOINT ${savepoint}`);

    try {
      const inserted = await manager.getRepository(IdempotencyKey).insert({
        scope,
        key,
        requestHash,
        status: IdempotencyStatus.IN_PROGRESS,
      });
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);

      const recordId = (
        inserted.identifiers?.[0] as { id?: number } | undefined
      )?.id;
      if (recordId === undefined) {
        throw new Error('idempotency insert returned no id');
      }
      return { replayed: false, recordId };
    } catch (error) {
      // Rewind ONLY the failed INSERT. Without this the transaction is aborted
      // and the lookup below raises 25P02 instead of answering the question.
      await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!isUniqueViolation(error)) throw error;

      const existing = await manager
        .getRepository(IdempotencyKey)
        .findOne({ where: { scope, key } });

      if (!existing) {
        // Lost the race and the winner then rolled back. Telling the client to
        // retry is honest and safe.
        throw inProgress();
      }

      if (existing.requestHash !== requestHash) throw keyReused();
      if (existing.status === IdempotencyStatus.IN_PROGRESS) throw inProgress();

      return {
        replayed: true,
        responseStatus: existing.responseStatus,
        responseBody: existing.responseBody as T,
      };
    }
  }

  /**
   * Records the response for a claimed key. Call inside the SAME transaction as
   * the business effect, immediately before it commits.
   */
  async complete(
    manager: EntityManager,
    recordId: number,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: IdempotencyStatus.COMPLETED,
        responseStatus,
        // `responseBody` is declared `unknown` on the entity, which TypeORM's
        // QueryDeepPartialEntity will not accept directly. Passing it as an
        // explicitly cast bound parameter keeps it a real jsonb value (and
        // keeps it parameterised).
        responseBody: () => ':body::jsonb',
        completedAt: new Date(),
      })
      .setParameter('body', JSON.stringify(responseBody ?? null))
      .where('id = :id', { id: recordId })
      .execute();
  }
}

function keyReused(): ConflictException {
  return new ConflictException({
    code: IDEMPOTENCY_KEY_REUSED,
    message:
      'This idempotency key was already used with a different request body.',
  });
}

function inProgress(): ConflictException {
  return new ConflictException({
    code: IDEMPOTENCY_REQUEST_IN_PROGRESS,
    message: 'A request with this idempotency key is being processed.',
  });
}

function isUniqueViolation(error: unknown): boolean {
  const driverError =
    error instanceof QueryFailedError
      ? (error as QueryFailedError & { driverError?: { code?: string } })
          .driverError
      : undefined;
  const code =
    driverError?.code ?? (error as { code?: string } | undefined)?.code;
  return code === PG_UNIQUE_VIOLATION;
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

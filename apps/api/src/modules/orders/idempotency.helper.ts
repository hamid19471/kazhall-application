import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { EntityManager } from 'typeorm';
import {
  IdempotencyKey,
  IdempotencyScope,
  IdempotencyStatus,
} from 'src/common/entities/idempotency-key.entity';
import { OrderMessages } from 'src/common/constants/order.messages';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_REQUEST_IN_PROGRESS,
} from 'src/common/services/idempotency.service';

/**
 * Transaction-local implementation of the replay protocol documented on
 * `IdempotencyKey`.
 *
 * NOTE FOR THE LEAD / WORKSTREAM A: `src/common/services/idempotency.service.ts`
 * did not exist when this was written, so the protocol is implemented here
 * against the entity's doc comment verbatim:
 *
 *   1. INSERT (scope, key, requestHash, IN_PROGRESS) in the SAME transaction as
 *      the business effect, so a rolled-back sale rolls back its key too.
 *   2. On 23505 load the existing row:
 *        requestHash differs -> 409 IDEMPOTENCY_KEY_REUSED
 *        IN_PROGRESS         -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
 *        COMPLETED           -> replay the stored response verbatim
 *   3. On success UPDATE to COMPLETED with the response snapshot.
 *
 * When A's service lands, delete this file and delegate to it; the call sites
 * in `OrdersService` are two lines. The `code` strings below are imported from
 * A's service on purpose, so the two implementations cannot drift into
 * answering the same situation with two different machine-readable codes while
 * both are alive.
 *
 * The INSERT is wrapped in a SAVEPOINT because a unique-violation aborts the
 * whole PostgreSQL transaction otherwise, which would make step 2 impossible.
 */

// ===========================================================================
// The POS `Idempotency-Key` contract
// ===========================================================================

/** Canonical spelling of the header. HTTP header names are case-insensitive. */
export const POS_IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED';
export const IDEMPOTENCY_KEY_INVALID = 'IDEMPOTENCY_KEY_INVALID';
export const IDEMPOTENCY_KEY_FOREIGN_CASHIER =
  'IDEMPOTENCY_KEY_FOREIGN_CASHIER';

/**
 * Length bounds.
 *
 * The floor exists because a short key is not a key: `"1"`, `"a"` or a counter
 * that resets when the terminal reboots collides across cashiers and days, and
 * a collision here does not merely fail — it REPLAYS somebody else's receipt.
 * 8 characters is the smallest value that rules out hand-typed and per-boot
 * counters while still admitting every sane generated identifier.
 *
 * The ceiling is 200 rather than the column's 255 so that an over-long key is
 * answered with a 400 that names the limit, instead of a driver-level
 * `value too long for type character varying(255)` surfacing as a 500.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Deliberately narrow: unreserved URL/token characters only.
 *
 * Comma is excluded, which matters more than it looks — Node joins a REPEATED
 * `Idempotency-Key:` header into one comma-separated string, so a client that
 * accidentally sends the header twice with different values is rejected here
 * rather than silently claiming a key that is neither of the two it sent.
 * Whitespace is excluded for the same reason: `"abc "` and `"abc"` must not be
 * two different sales.
 */
const IDEMPOTENCY_KEY_CHARSET = /^[A-Za-z0-9._:-]+$/;

/**
 * Validates and normalises the `Idempotency-Key` header of a POS sale.
 *
 * WHY THIS IS MANDATORY AND NOT "ACCEPTED IF PRESENT". The previous contract
 * typed the key `idempotencyKey?: string` and guarded every claim with
 * `if (idempotencyKey)`. That makes retry protection opt-in, which means it is
 * absent in exactly the situations it exists for: a cashier double-tapping
 * "Charge", or a terminal that timed out and retried a request the server had
 * in fact already committed. Both rang the sale up twice and decremented stock
 * twice. A protocol that a broken client can silently opt out of does not
 * protect anyone, so the header is now part of the request contract and its
 * absence is a 400.
 *
 * WHO GENERATES IT: the POS FRONTEND, once per sale attempt, and resends the
 * same value verbatim on every retry of that attempt. Cashiers never see it
 * and never type it — a UI that prompts a human for a UUID is a bug.
 */
export function requirePosIdempotencyKey(raw: string | undefined): string {
  // The POS envelope is UNCHANGED: `code` under `details`, no top-level
  // `error`. POS terminal vendors have already integrated against it, and
  // moving the code would be a silent breaking change for them.
  return validateIdempotencyKey(raw, {
    missing: {
      code: IDEMPOTENCY_KEY_REQUIRED,
      message: OrderMessages.IDEMPOTENCY_KEY_REQUIRED,
    },
    invalid: {
      code: IDEMPOTENCY_KEY_INVALID,
      message: OrderMessages.IDEMPOTENCY_KEY_INVALID,
    },
  });
}

/**
 * The same contract, for a NON-POS caller that needs its own wording.
 *
 * The rules — mandatory, 8..200 characters, the narrow charset above — are
 * deliberately shared rather than re-stated per endpoint: a second copy is a
 * second place for the comma exclusion (which is what makes a doubled header
 * fail loudly instead of claiming a third value nobody sent) to be forgotten.
 * Only the human sentences differ, because a POS vendor and a back-office
 * operator need to be told different things to do.
 *
 * The machine-readable codes are `IDEMPOTENCY_KEY_REQUIRED` /
 * `IDEMPOTENCY_KEY_INVALID` for every caller, on the top-level `error` key.
 */
export function requireIdempotencyKey(
  raw: string | undefined,
  messages: { missing: string; invalid: string },
): string {
  return validateIdempotencyKey(raw, {
    missing: { error: IDEMPOTENCY_KEY_REQUIRED, message: messages.missing },
    invalid: { error: IDEMPOTENCY_KEY_INVALID, message: messages.invalid },
  });
}

/** The shared rules. Only the exception PAYLOAD differs between callers. */
function validateIdempotencyKey(
  raw: string | undefined,
  payloads: {
    missing: Record<string, unknown>;
    invalid: Record<string, unknown>;
  },
): string {
  const key = (raw ?? '').trim();

  if (key.length === 0) {
    throw new BadRequestException(payloads.missing);
  }

  if (
    key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_CHARSET.test(key)
  ) {
    throw new BadRequestException(payloads.invalid);
  }

  return key;
}

/**
 * Refuses a replay attempted by a cashier who is not the one the key was
 * claimed by.
 *
 * WHY IT IS REFUSED RATHER THAN REPLAYED. The stored response carries the
 * ORIGINAL cashier and branch, so handing it back to a different cashier would
 * answer "here is your sale" with somebody else's receipt: on the terminal it
 * looks like a completed sale, in the ledger it belongs to another person, and
 * a till that is short at close of day has no trace of why. It is also the only
 * shape a key-guessing probe can take, and one that leaks another cashier's
 * sale total. There is no legitimate client behaviour behind it: keys are
 * generated per sale attempt by the terminal that is making the sale.
 *
 * WHY IT NEEDS ITS OWN CODE even though `requestHashOf` already includes
 * `cashierUserId` (so a foreign replay ALWAYS fails the hash comparison and
 * would 409 anyway): that 409 says "you sent a different request body", which
 * is false and unactionable when the body was byte-identical. A vendor
 * debugging it would go looking for a serialisation bug that does not exist.
 *
 * Runs OUTSIDE the business transaction, as a read. It is a diagnostics
 * refinement, not the security boundary — the hash comparison inside
 * `claimIdempotencyKey` is, and it still refuses the request (with the generic
 * reuse code) in the narrow window where the first attempt is IN_PROGRESS and
 * has no stored response to attribute yet.
 */
export async function assertPosSaleKeyOwnedBy(
  manager: EntityManager,
  key: string,
  cashierUserId: number,
): Promise<void> {
  const existing = await manager.getRepository(IdempotencyKey).findOne({
    where: { scope: IdempotencyScope.POS_SALE, key },
  });
  if (!existing || existing.status !== IdempotencyStatus.COMPLETED) return;

  const body = existing.responseBody as { cashierUserId?: unknown } | null;
  const owner = body?.cashierUserId;
  if (typeof owner === 'number' && owner !== cashierUserId) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_FOREIGN_CASHIER,
      message: OrderMessages.IDEMPOTENCY_KEY_FOREIGN_CASHIER,
    });
  }
}

// ===========================================================================
// The replay protocol
// ===========================================================================

/** Thrown to unwind the (empty) business transaction when replaying. */
export class IdempotentReplayError extends Error {
  constructor(
    readonly responseStatus: number,
    readonly responseBody: unknown,
  ) {
    super('Idempotent replay');
    this.name = 'IdempotentReplayError';
  }
}

/** Deterministic JSON: object keys sorted, so key order cannot change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

export function requestHashOf(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * TypeORM copies the driver's own properties onto `QueryFailedError`, so
 * `err.code` is usually the PostgreSQL SQLSTATE directly — but that copy is a
 * TypeORM implementation detail, and if a future version stops doing it every
 * duplicate key would stop being recognised and start returning 500 instead of
 * replaying. Checking `driverError.code` too costs nothing and removes the
 * dependency on that behaviour.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    code?: string;
    driverError?: { code?: string };
  };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}

export interface IdempotencyClaim {
  /** id of the `idempotency_keys` row to complete once the work succeeds. */
  rowId: number;
}

function keyReused(): ConflictException {
  return new ConflictException({
    code: IDEMPOTENCY_KEY_REUSED,
    message: OrderMessages.IDEMPOTENCY_KEY_REUSED,
  });
}

function requestInProgress(): ConflictException {
  return new ConflictException({
    code: IDEMPOTENCY_REQUEST_IN_PROGRESS,
    message: OrderMessages.IDEMPOTENCY_IN_PROGRESS,
  });
}

/**
 * Read-only fast path, executed OUTSIDE the business transaction. Returns the
 * stored response for an already-completed request so a retry never even opens
 * a write transaction. Still safe against a racing first attempt, because the
 * authoritative check is `claimIdempotencyKey` inside the transaction.
 */
export async function peekIdempotencyKey(
  manager: EntityManager,
  scope: IdempotencyScope,
  key: string,
  requestHash: string,
): Promise<IdempotentReplayError | null> {
  const existing = await manager.getRepository(IdempotencyKey).findOne({
    where: { scope, key },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw keyReused();
  if (existing.status !== IdempotencyStatus.COMPLETED) return null;
  return new IdempotentReplayError(
    existing.responseStatus ?? 200,
    existing.responseBody,
  );
}

/**
 * How many times to re-attempt the INSERT when the winner of the race rolled
 * back and left no row behind. Bounded so a pathological loop cannot hold a
 * connection open; three attempts is far more than a real terminal ever needs.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * Step 1 + 2. Must be called as the FIRST write of the business transaction,
 * before any row locks are taken: a second concurrent request with the same key
 * blocks here on the unique index, which is exactly the serialisation we want,
 * and blocking before holding variant locks cannot deadlock.
 *
 * The blocking is the whole point and is worth spelling out, because it is what
 * makes N simultaneous double-taps produce ONE sale: PostgreSQL makes the
 * duplicate INSERT wait until the first transaction commits or aborts. If it
 * committed, the row is COMPLETED by then and every loser replays the winner's
 * response — nobody errors out, nobody sells twice.
 *
 * WHY THE RETRY LOOP. The one case that is NOT settled by waiting is the winner
 * ABORTING: its row disappears with its transaction, so the loser wakes up to a
 * 23505 for a row that no longer exists. The previous code answered that with
 * 409 "already in progress; retry shortly", which was doubly wrong — nothing was
 * in progress, and the sale the caller asked for had not happened. Under a
 * genuine double-tap where the first attempt failed on stock, the cashier saw a
 * 409 that told them to wait instead of the real reason. Re-attempting the
 * INSERT is correct precisely because the winner rolled back: there is no
 * business effect to be idempotent about, so this request is simply the first
 * one, and it goes on to do the work and report the true outcome.
 */
export async function claimIdempotencyKey(
  manager: EntityManager,
  scope: IdempotencyScope,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  for (let attempt = 1; ; attempt++) {
    const savepoint = `sp_idem_${randomBytes(6).toString('hex')}`;
    await manager.query(`SAVEPOINT ${savepoint}`);
    try {
      const inserted = await manager.getRepository(IdempotencyKey).insert({
        scope,
        key,
        requestHash,
        status: IdempotencyStatus.IN_PROGRESS,
      });
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { rowId: (inserted.identifiers[0] as { id: number }).id };
    } catch (err) {
      // Rewind ONLY the failed INSERT. Without this the whole transaction is
      // aborted and every branch below raises 25P02 instead of answering.
      await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!isUniqueViolation(err)) throw err;

      const existing = await manager
        .getRepository(IdempotencyKey)
        .findOne({ where: { scope, key } });

      if (!existing) {
        // Winner rolled back; the key is free again. Take it.
        if (attempt < CLAIM_ATTEMPTS) continue;
        throw requestInProgress();
      }
      if (existing.requestHash !== requestHash) throw keyReused();
      if (existing.status === IdempotencyStatus.COMPLETED) {
        throw new IdempotentReplayError(
          existing.responseStatus ?? 200,
          existing.responseBody,
        );
      }
      // Committed but not completed: another process claimed the key and died,
      // or is mid-flight on a different connection. Not ours to take.
      throw requestInProgress();
    }
  }
}

/** Step 3. Same transaction as the business effect. */
export async function completeIdempotencyKey(
  manager: EntityManager,
  claim: IdempotencyClaim,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await manager
    .getRepository(IdempotencyKey)
    .createQueryBuilder()
    .update(IdempotencyKey)
    .set({
      status: IdempotencyStatus.COMPLETED,
      responseStatus,
      responseBody: () => ':body::jsonb',
      completedAt: new Date(),
    })
    .setParameter('body', JSON.stringify(responseBody))
    .where('id = :id', { id: claim.rowId })
    .execute();
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditActionCode, AuditTargetType } from './audit.actions';
import { SessionAudience } from 'src/modules/auth/audience';

/**
 * Who performed the act. Built from `req.user` — never from the body.
 */
export interface AuditActor {
  userId: number | null;
  /** `req.user.identifier`; frozen into the row so a rename cannot rewrite it. */
  display: string;
  audience?: SessionAudience | null;
  requestId?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: AuditActionCode;
  targetType: AuditTargetType;
  targetId?: number | string | null;
  /** The target's human label AS IT WAS at the time of the act. */
  targetLabel?: string | null;
  /**
   * A SAFE, ALREADY-REDACTED summary. See `redact` — anything resembling a
   * credential is dropped even if a caller passes it, because "we remembered
   * not to" is not a control.
   */
  summary?: Record<string, unknown> | null;
}

/**
 * Keys that must never reach `admin_audit_log.summary`, matched
 * case-insensitively as substrings.
 *
 * This is belt AND braces. Every caller is supposed to build its summary from
 * an explicit allow-list of scalar fields; this exists because the failure mode
 * of forgetting once — a plaintext password permanently written into an
 * append-only table that cannot be edited or deleted — is not recoverable.
 */
/**
 * Key names that are EXEMPT from the substring blocklist below.
 *
 * The blocklist matches `code` as a substring so that an OTP can never be
 * written here, and that is the right default. But it also catches
 * `productCode` and `variantCode`, which are BUSINESS IDENTIFIERS: they are
 * printed on customer receipts, read down a telephone, and typed into the POS
 * search box. Redacting them made `product.code_changed` — an entry whose
 * entire purpose is to record which code became which — write "[redacted]"
 * where the answer should be.
 *
 * This list is deliberately:
 *   • EXACT-MATCH, not substring, so `otpCode` and `resetCode` stay blocked;
 *   • two entries long, and additions need the same justification as these:
 *     the value must already be visible to the customer it concerns.
 *
 * It is consulted BEFORE the blocklist, so an exempt key is kept and everything
 * else still falls through to the credential heuristic unchanged.
 */
const ALLOWED_SUMMARY_KEYS = new Set(['productcode', 'variantcode']);

const FORBIDDEN_SUMMARY_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'otp',
  'code',
  'hash',
  'authorization',
  'credential',
  'apikey',
  'api_key',
];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Writes one audit row.
   *
   * ALWAYS PASS THE CALLER'S `manager` when there is one. The row then commits
   * with the change it describes, so "the branch was deactivated but nobody
   * knows who did it" is not a representable state. Called without a manager
   * it uses its own connection, which is correct only for acts that are not
   * part of a wider transaction.
   *
   * It does not swallow errors: a failed audit write must roll the act back.
   * An administrative change that could not be recorded has not, for the
   * owner's purposes, happened.
   */
  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    const scope = manager ?? this.dataSource.manager;
    const summary = redact(entry.summary ?? null);

    // A PARAMETERISED INSERT rather than the repository, deliberately. The
    // table is append-only at the database level, so the only operation it
    // ever needs is this one, and writing it out keeps the `jsonb` column
    // honest: the repository's deep-partial typing does not model an arbitrary
    // JSON object, and working around that with a cast would hide the shape
    // rather than state it.
    await scope.query(
      `INSERT INTO "admin_audit_log"
         ("actorUserId", "actorDisplaySnapshot", "actorAudience", "action",
          "targetType", "targetId", "targetLabel", "summary", "requestId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        entry.actor.userId,
        truncate(entry.actor.display || 'unknown', 160),
        entry.actor.audience ?? null,
        entry.action,
        entry.targetType,
        entry.targetId === null || entry.targetId === undefined
          ? null
          : truncate(String(entry.targetId), 64),
        entry.targetLabel ? truncate(entry.targetLabel, 200) : null,
        summary === null ? null : JSON.stringify(summary),
        entry.actor.requestId ?? null,
      ],
    );
  }

  /**
   * Best-effort variant for acts that have already committed and must not be
   * undone by a logging failure — currently only used where the underlying
   * service owns its own transaction and does not expose it.
   */
  async recordDetached(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (error) {
      this.logger.error(
        `Audit write failed for ${entry.action} on ${entry.targetType}#${String(entry.targetId)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Drops any key whose name suggests a credential, at any depth. */
function redact(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (
      !ALLOWED_SUMMARY_KEYS.has(lowered) &&
      FORBIDDEN_SUMMARY_KEYS.some((needle) => lowered.includes(needle))
    ) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? redact(raw as Record<string, unknown>)
        : raw;
  }
  return out;
}

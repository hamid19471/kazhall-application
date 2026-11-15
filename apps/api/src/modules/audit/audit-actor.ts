import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { AuditActor } from './audit.service';

/**
 * Builds the acting principal from the AUTHENTICATED request, never from the
 * body.
 *
 * Trivial, and deliberately the only way controllers construct an actor: the
 * moment one of them accepts an `actorUserId` field "for convenience", the
 * audit trail records whatever the caller claimed rather than who they are.
 */
export function auditActorFrom(request: UserRequest): AuditActor {
  return {
    userId: request.user.sub,
    display: request.user.identifier,
    audience: request.user.audience,
    requestId: readRequestId(request),
  };
}

/**
 * Correlation id, if a proxy supplied one. Bounded and character-restricted
 * because it is client-controlled and lands in a column: an unbounded header
 * value would otherwise be stored verbatim.
 */
function readRequestId(request: UserRequest): string | null {
  const raw = request.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 64);
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

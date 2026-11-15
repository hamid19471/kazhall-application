import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_PENDING_KEY =
  'allow_password_change_pending';

/**
 * Marks a route as reachable while `users.mustChangePassword` is set.
 *
 * A forced password change that blocked EVERY route would include the
 * change-password route, which is a lockout with no way out.
 *
 * EXACTLY THREE AUTHENTICATED ROUTES CARRY THIS, per audience, and the set is
 * asserted by `auth-password-change.int-spec.ts` so it cannot grow by accident:
 *
 *   GET  /auth/<aud>/me            introspection — the ONLY way the frontend
 *                                  can learn it must show the change form, and
 *                                  what username to show on it
 *   POST /auth/<aud>/change-password   the change itself; the only thing that
 *                                  clears the flag
 *   POST /auth/<aud>/logout-all    the authenticated sign-out lever, for
 *                                  somebody who suspects the temporary
 *                                  password was seen by the wrong person
 *
 * NOT ON THIS LIST, and deliberately: `login`, `refresh` and `logout` are
 * `@Public()`. They read a cookie and never resolve a principal, so the flag is
 * never consulted on them — rotation and ordinary sign-out therefore keep
 * working while the flag is set, without this decorator and without a route
 * that could be reached with a pending principal's privileges.
 *
 * Everything else answers 403 `PASSWORD_CHANGE_REQUIRED`, enforced in
 * `JwtAuthGuard` — server-side, because a flag the frontend is merely asked to
 * respect is not a control.
 */
export const AllowPasswordChangePending = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING_KEY, true);

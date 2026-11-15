export const AuthMessages = {
  LOGIN_SUCCESS: 'Login successful',
  LOGOUT_SUCCESS: 'Logout successful',
  OTP_SENT: 'OTP sent successfully',
  /**
   * THE ONLY verification-failure message.
   *
   * Deliberately covers all four failure modes — no challenge for this number,
   * wrong code, expired code, and attempt bound exhausted — because a message
   * that distinguished them would tell an attacker whether a challenge exists
   * for a number they do not control, and (via a "no such user" variant, which
   * is what the old code threw) whether the number is registered at all.
   */
  INVALID_OTP: 'Invalid or expired OTP.',
  /** Resend attempted inside the per-mobile cooldown window. Paired with `retryAfterSeconds`. */
  OTP_COOLDOWN: 'A code was just sent. Please wait before requesting another.',
  /**
   * The per-mobile or per-IP hourly send budget is spent. One message for both
   * so the response does not tell a caller which of the two buckets they are
   * in. Paired with `retryAfterSeconds`.
   */
  OTP_RATE_LIMITED: 'Too many code requests. Please try again later.',
  /**
   * The mobile number could not be normalized to `09XXXXXXXXX`. Practically
   * unreachable over HTTP — the DTOs validate the normalized form — and kept
   * only so a non-HTTP caller of the service gets a named 400 rather than a 500.
   */
  INVALID_MOBILE: 'A valid mobile number is required.',
  REGISTER_SUCCESS: 'User registered successfully',
  TOKEN_REFRESHED: 'Token refreshed successfully',
  INVALID_CREDENTIALS: 'Invalid username or password.',
  INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token.',
  INVALID_TOKEN_PAYLOAD: 'Invalid token payload.',
  USER_NOT_FOUND: 'User not found.',
  USER_ALREADY_EXISTS: 'User already exists.',
  TOKEN_EXPIRED: ' Token has expired.',
  INVALID_ACCESS_TOKEN: ' Invalid or expired access token.',
  ACCESS_DENIED: 'You do not have permission to access this path.',

  /**
   * A token of the wrong purpose was presented (a refresh token used as an
   * access token, or vice versa). Deliberately indistinguishable from the
   * generic invalid-token messages so the wire response does not tell an
   * attacker which half of the pair they hold.
   */
  WRONG_TOKEN_TYPE: ' Invalid or expired access token.',
  /**
   * A session belonging to another application was presented — a till cookie on
   * a storefront route, or a storefront cookie on an admin route. Worded exactly
   * like the generic failures above: telling the caller "this is a valid POS
   * token, but you are on the admin API" confirms both that the token is
   * genuine and which surface it opens.
   */
  WRONG_TOKEN_AUDIENCE: 'Invalid or expired access token.',
  /**
   * The account is real and the password correct, but this user may not open a
   * session on THIS application (a cashier at the admin door, a customer at the
   * till). Distinct from INVALID_CREDENTIALS because it says nothing about
   * whether a username exists — it is only ever returned after the password has
   * already been verified.
   */
  AUDIENCE_NOT_PERMITTED: 'This account cannot sign in to this application.',
  /**
   * The storefront password form was posted while review logins are switched
   * off. Production customer sign-in is OTP; this door is for reviewing the
   * application without an SMS provider and is not a second way in.
   */
  REVIEW_LOGIN_DISABLED:
    'Password sign-in is not available. Please sign in with a one-time code.',
  /** Refresh token was already used or revoked (rotation replay). */
  REFRESH_TOKEN_ALREADY_USED: 'Invalid or expired refresh token.',
  /** Access token predates users.passwordChangedAt. */
  SESSION_INVALIDATED: 'Your session is no longer valid. Please sign in again.',
  /** users.deactivatedAt is set. */
  ACCOUNT_DEACTIVATED: 'This account has been deactivated.',
  SESSIONS_REVOKED: 'All sessions revoked successfully',
  NO_ACTIVE_SESSION: 'No active session to revoke.',

  /**
   * The principal is authenticated, is on a surface this route serves, and
   * still holds none of the capabilities the route declares. Worded separately
   * from ACCESS_DENIED because the response carries `requiredPermissions` and
   * `missingPermissions`, which is what lets the console explain *which*
   * delegation is missing instead of showing a bare 403.
   */
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  /**
   * `users.mustChangePassword` is set. Every route except introspection,
   * rotation, sign-out and the change itself answers this until the user
   * replaces the temporary password an administrator issued.
   */
  PASSWORD_CHANGE_REQUIRED: 'You must change your password before continuing.',
  PASSWORD_CHANGED: 'Password changed successfully',
  /** Self-service change: the supplied current password did not match. */
  CURRENT_PASSWORD_INVALID: 'The current password is incorrect.',
  /** Self-service change: the new password is the same as the current one. */
  PASSWORD_UNCHANGED: 'The new password must differ from the current one.',
  /** Administrator reset: the target has no password login (customer account). */
  PASSWORD_LOGIN_NOT_AVAILABLE:
    'This account signs in with a one-time code and has no password.',
  TEMPORARY_PASSWORD_SET:
    'A temporary password was set. The user must change it at next sign-in.',
} as const;

/**
 * Machine-readable codes placed on the error envelope's top-level `error` key.
 *
 * They exist because a frontend must be able to tell "you are signed out" from
 * "you are signed in but may not do this" from "you must change your password
 * first" WITHOUT parsing a human sentence — the three need three completely
 * different screens, and two of them are 403s.
 */
export const AuthErrorCodes = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /**
   * Refused because of the ROLE the principal holds, not a capability.
   *
   * A distinct code because it needs a distinct screen and a distinct
   * sentence. `PERMISSION_DENIED` means "ask for this capability" and the
   * console can name the missing codes; `ROLE_REQUIRED` means "there is no
   * capability to ask for" — sales reporting and the financial dashboard
   * belong to the built-in `super_admin` role and are not delegable, so
   * telling the operator to request a permission would send them to their
   * administrator with an impossible request.
   *
   * `details.requiredRoles` names the roles, mirroring
   * `details.missingPermissions` on the capability refusal.
   */
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  CURRENT_PASSWORD_INVALID: 'CURRENT_PASSWORD_INVALID',
  PASSWORD_UNCHANGED: 'PASSWORD_UNCHANGED',
  PASSWORD_LOGIN_NOT_AVAILABLE: 'PASSWORD_LOGIN_NOT_AVAILABLE',
  AUDIENCE_NOT_PERMITTED: 'AUDIENCE_NOT_PERMITTED',
} as const;

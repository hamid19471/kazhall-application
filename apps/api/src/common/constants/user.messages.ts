export const UserMessages = {
  USER_CREATED: 'User created successfully',
  USER_UPDATED: 'User updated successfully',
  USER_DELETED: 'User deleted successfully',
  USER_DEACTIVATED:
    'User deactivated. Their sales history is retained and stays attributed to them',
  USER_REACTIVATED: 'User reactivated successfully',
  USER_ALREADY_DEACTIVATED: 'User is already deactivated',
  USER_NOT_FOUND: 'User not found',
  USER_ALREADY_EXISTS: 'User already exists',
  USER_ROLE_REQUIRED: 'User role is required',

  // --- admin staff management --------------------------------------------
  USERNAME_TAKEN: 'This username is already in use',
  MOBILE_TAKEN: 'This mobile number is already in use',
  SESSIONS_REVOKED: 'Every session of this user has been revoked',
  PASSWORD_RESET:
    'A temporary password was set. Every session was revoked and the user must change it at next sign-in',
  /**
   * A customer account (mobile + OTP, no username) was sent to a STAFF route.
   * Staff management and customer accounts are deliberately different things:
   * a customer has no password to reset and no branch to assign.
   */
  NOT_A_STAFF_ACCOUNT:
    'This is a customer account. It has no password and cannot be managed as staff',
  CASHIER_BRANCH_REQUIRED:
    'A cashier needs a branch: a POS sale is attributed to one and is refused without it',
} as const;

/** Stable machine codes on the error envelope's top-level `error` key. */
export const UserErrorCodes = {
  /** 409 — `users.username` is unique. */
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  /** 409 — `users.mobile` is unique. */
  MOBILE_TAKEN: 'MOBILE_TAKEN',
  /** 400 — the target signs in with an OTP and has no password. */
  NOT_A_STAFF_ACCOUNT: 'NOT_A_STAFF_ACCOUNT',
} as const;

export const BranchMessages = {
  BRANCH_NOT_FOUND: 'Branch not found',
  BRANCH_CREATED: 'Branch created successfully',
  BRANCH_UPDATED: 'Branch updated successfully',
  BRANCH_ACTIVATED: 'Branch activated successfully',
  BRANCH_DEACTIVATED: 'Branch deactivated successfully',
  BRANCH_DELETED: 'Branch deleted successfully',
  BRANCH_NAME_TAKEN: 'A branch with this name already exists',
  /**
   * A hard delete was attempted against a branch that history points at.
   * `users.branchId` and `orders.branchId` are real foreign keys, so the
   * alternative to this refusal is not a clean delete — it is a 500 from the
   * driver, or (worse) a schema where past sales no longer know which shop
   * made them.
   */
  BRANCH_IN_USE:
    'This branch is referenced by staff or orders and cannot be deleted. Deactivate it instead.',
  /**
   * A cashier tried to ring up a sale from a branch that has been retired.
   * Enforced server-side at sale time, not merely hidden in the till UI.
   */
  BRANCH_INACTIVE: 'This branch is deactivated and cannot record new sales.',
} as const;

/**
 * Stable machine codes on the error envelope's top-level `error` key. A client
 * branches on these, never on the human-readable message.
 */
export const BranchErrorCodes = {
  /** 409 — staff or orders still reference the branch. */
  BRANCH_IN_USE: 'BRANCH_IN_USE',
  /** 409 — `branches.name` is unique. */
  BRANCH_NAME_TAKEN: 'BRANCH_NAME_TAKEN',
  /** 409 — the cashier's branch is deactivated. */
  BRANCH_INACTIVE: 'BRANCH_INACTIVE',
} as const;

export const RoleMessages = {
  // `ROLE_CREATED` was removed with `POST /roles`: the role model is fixed to
  // `super_admin` / `sale` / `site` and no route creates a role. See the note
  // on `RoleController`.
  ROLE_DELETED: 'Role deleted successfully',
  ROLE_ASSIGNED: 'Role assigned successfully',
  ROLE_REMOVED: 'Role removed successfully',
  ROLE_ALREADY_EXISTS: 'This role already exists',
  ROLE_NOT_FOUND: 'Role not found',
  USER_ROLE_INVALID: 'The user role is invalid',
  ROLE_BUILTIN_PROTECTED:
    'This is a built-in system role and can never be deleted',
  ROLE_IN_USE:
    'This role is still assigned to at least one user and cannot be deleted',
  LAST_SUPER_ADMIN:
    'The last super_admin cannot lose that role: the system would be left with no administrator',

  // --- permission-based RBAC (migration 0020) -----------------------------
  ROLE_CREATED: 'Role created successfully',
  ROLE_UPDATED: 'Role updated successfully',
  ROLE_ACTIVATED: 'Role activated successfully',
  ROLE_DEACTIVATED: 'Role deactivated successfully',
  ROLE_PERMISSIONS_UPDATED: 'Role permissions updated successfully',
  USER_ROLES_UPDATED: 'User roles updated successfully',
  /** A system role's capability set is owned by code, not by this API. */
  SYSTEM_ROLE_IMMUTABLE:
    'Built-in roles cannot be renamed, deactivated, or have their permissions changed',
  /** A permission code that the catalogue does not define. */
  UNKNOWN_PERMISSION: 'One or more permission codes do not exist',
  /**
   * The actor tried to grant a capability it does not itself hold. Privilege
   * escalation by proxy: without this, anyone with `rbac.manage` could mint a
   * role carrying every permission in the system and assign it to themselves.
   */
  PERMISSION_ESCALATION:
    'You cannot grant a permission you do not hold yourself',
  ROLE_NAME_TAKEN: 'A role with this name already exists',
  /**
   * A DEACTIVATED role confers nothing (`PermissionService.resolveEffective`
   * skips it), so assigning one hands somebody an account that silently has no
   * capabilities at all. Refused explicitly rather than accepted and made
   * meaningless.
   */
  ROLE_INACTIVE: 'A deactivated role cannot be assigned to a user',
} as const;

/**
 * Stable machine-readable codes for the role-safety refusals.
 *
 * `GlobalExceptionFilter` promotes a payload's string `error` property to the
 * TOP level of the error envelope, so throwing
 *
 *   new ConflictException({ error: RoleErrorCodes.ROLE_IN_USE, message, ... })
 *
 * yields `{ statusCode: 409, message, error: 'ROLE_IN_USE', details: { ... } }`.
 * A client branches on `error`, never on the human-readable `message`.
 */
export const RoleErrorCodes = {
  /** 409 — `super_admin` / `sale` / `site` are structural and never deletable. */
  ROLE_BUILTIN_PROTECTED: 'ROLE_BUILTIN_PROTECTED',
  /** 409 — the role still has `user_roles` rows pointing at it. */
  ROLE_IN_USE: 'ROLE_IN_USE',
  /** 409 — the change would leave nobody able to administer the system. */
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  /** 409 — rename / deactivate / re-permission attempted on a built-in role. */
  SYSTEM_ROLE_IMMUTABLE: 'SYSTEM_ROLE_IMMUTABLE',
  /** 400 — a code that is not in the permission catalogue. */
  UNKNOWN_PERMISSION: 'UNKNOWN_PERMISSION',
  /** 403 — the actor does not hold a capability it is trying to confer. */
  PERMISSION_ESCALATION: 'PERMISSION_ESCALATION',
  /** 409 — `roles.name` is unique. */
  ROLE_NAME_TAKEN: 'ROLE_NAME_TAKEN',
  /** 400 — the role exists but is deactivated, so it would confer nothing. */
  ROLE_INACTIVE: 'ROLE_INACTIVE',
} as const;

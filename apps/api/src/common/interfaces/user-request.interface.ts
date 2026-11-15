import { Request } from 'express';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { SessionAudience } from 'src/modules/auth/audience';

/**
 * What `JwtStrategy.validate` attaches. Every field is derived from the
 * database row read on THIS request; none of it is taken from the token's
 * claims or from anything the caller sent.
 */
export interface UserRequest extends Request {
  user: {
    sub: number;
    identifier: string;
    roles: UserRoleEnum[];
    branch: number | null;
    /** The surface this session belongs to. */
    audience: SessionAudience;
    /**
     * Effective capability codes. Read this to SHAPE a response (hide a
     * column, pick a view); never to authorise — that is `PermissionsGuard`'s
     * job, declared at the route with `@RequirePermissions(...)`.
     */
    permissions: string[];
    mustChangePassword: boolean;
  };
}

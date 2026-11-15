import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthMessages } from 'src/common/constants/auth.messages';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import { Roles } from '../decorators/role.decorator';
import { RolesGuard } from './roles.guard';

/**
 * ===========================================================================
 * RolesGuard — metadata PRECEDENCE
 * ===========================================================================
 *
 * `Reflector.getAllAndOverride` returns the first DEFINED value in the array
 * it is given, so the array order is the precedence rule and nothing else is.
 * The guard used to pass `[getClass(), getHandler()]`, which meant a
 * handler-level `@Roles(...)` on a controller that already carried a
 * class-level `@Roles(...)` was silently discarded: the route enforced the
 * class's roles while its own decorator (and its generated Swagger) advertised
 * different ones. Nothing throws in that situation, which is precisely why it
 * would only ever surface as a production authorisation bug.
 *
 * These cases use the REAL `Reflector` against REAL `@Roles` decorators on
 * real classes — a mocked reflector would just replay whatever precedence the
 * mock was written with and could not detect the inversion at all. Only the
 * `ExecutionContext` is a double, because the guard uses exactly three things
 * from it.
 */

@Roles(UserRoleEnum.superAdmin)
class ClassOnlyController {
  handler(): void {
    /* route target; the guard never invokes it */
  }
}

class HandlerOnlyController {
  @Roles(UserRoleEnum.sale)
  handler(): void {
    /* route target; the guard never invokes it */
  }
}

@Roles(UserRoleEnum.superAdmin)
class BothController {
  @Roles(UserRoleEnum.sale)
  handler(): void {
    /* route target; the guard never invokes it */
  }
}

class UndecoratedController {
  handler(): void {
    /* route target; the guard never invokes it */
  }
}

type ControllerClass = new (...args: never[]) => { handler: () => void };

/**
 * Minimal `ExecutionContext`. `getClass`/`getHandler` hand back the genuine
 * constructor and the genuine prototype method, so the Reflector reads the
 * metadata the decorators actually wrote.
 */
function makeContext(
  controller: ControllerClass,
  handler: () => void,
  userRoles?: UserRoleEnum[],
): ExecutionContext {
  const request = userRoles === undefined ? {} : { user: { roles: userRoles } };

  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let guard: RolesGuard;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
  });

  describe('roles declared on the CLASS only', () => {
    const ctx = (roles?: UserRoleEnum[]) =>
      makeContext(
        ClassOnlyController,
        ClassOnlyController.prototype.handler,
        roles,
      );

    it('enforces the class roles', () => {
      expect(guard.canActivate(ctx([UserRoleEnum.superAdmin]))).toBe(true);
    });

    it('rejects a principal without them', () => {
      expect(() => guard.canActivate(ctx([UserRoleEnum.sale]))).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('roles declared on the HANDLER only', () => {
    const ctx = (roles?: UserRoleEnum[]) =>
      makeContext(
        HandlerOnlyController,
        HandlerOnlyController.prototype.handler,
        roles,
      );

    it('enforces the handler roles', () => {
      expect(guard.canActivate(ctx([UserRoleEnum.sale]))).toBe(true);
    });

    it('rejects a principal without them', () => {
      expect(() => guard.canActivate(ctx([UserRoleEnum.superAdmin]))).toThrow(
        ForbiddenException,
      );
    });
  });

  /**
   * THE REGRESSION TEST.
   *
   * Class says `super_admin`, handler says `sale`. Both assertions below fail
   * against the previous `[getClass(), getHandler()]` order — the first would
   * throw ForbiddenException and the second would return true — which is what
   * makes them evidence rather than decoration.
   */
  describe('roles declared on BOTH the class and the handler', () => {
    const ctx = (roles?: UserRoleEnum[]) =>
      makeContext(BothController, BothController.prototype.handler, roles);

    it('lets the HANDLER roles win', () => {
      expect(guard.canActivate(ctx([UserRoleEnum.sale]))).toBe(true);
    });

    it('does not fall back to the class roles', () => {
      expect(() => guard.canActivate(ctx([UserRoleEnum.superAdmin]))).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('no role metadata anywhere', () => {
    const ctx = (roles?: UserRoleEnum[]) =>
      makeContext(
        UndecoratedController,
        UndecoratedController.prototype.handler,
        roles,
      );

    it('allows the request through', () => {
      expect(guard.canActivate(ctx([UserRoleEnum.site]))).toBe(true);
    });

    it('allows it even with no authenticated principal at all', () => {
      // Authentication is JwtAuthGuard's job; RolesGuard only decides
      // authorisation, and an undecorated route authorises everyone.
      expect(guard.canActivate(ctx())).toBe(true);
    });
  });

  describe('a principal lacking the required role', () => {
    it('is refused with the API-wide ACCESS_DENIED message', () => {
      const context = makeContext(
        ClassOnlyController,
        ClassOnlyController.prototype.handler,
        [UserRoleEnum.site],
      );

      expect(() => guard.canActivate(context)).toThrow(
        new ForbiddenException(AuthMessages.ACCESS_DENIED),
      );
    });

    it('is refused when the request carries no roles array', () => {
      const context = makeContext(
        ClassOnlyController,
        ClassOnlyController.prototype.handler,
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});

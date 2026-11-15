import { Reflector } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import {
  CONSULTED_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from 'src/modules/auth/permissions/permission.decorator';
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
} from 'src/modules/auth/permissions/permission.catalog';
import { AUDIENCE_ACCESS_PERMISSION } from 'src/modules/auth/audience';
import { TestApp, createTestApp } from './setup/test-app';

/**
 * ===========================================================================
 * CATALOGUE COVERAGE — every code must actually authorise something
 * ===========================================================================
 *
 * THE DEFECT THIS EXISTS BECAUSE OF. `products.activate` and
 * `products.deactivate` sat in the catalogue, were seeded by migration 0020,
 * and were rendered on the access-control screen as two separate tick boxes
 * with Persian descriptions promising they controlled whether a variant could
 * be sold. Nothing checked either one. Variant activation rides inside
 * `PATCH /products/:id`, which was guarded by `products.update` alone — so an
 * owner could build a "catalogue editor" role, deliberately withhold
 * `products.deactivate`, and the editor could still pull any product off the
 * storefront and the till.
 *
 * A capability that authorises nothing is WORSE than a missing one. A missing
 * one is discovered the first time somebody needs it; a decorative one is
 * granted, withheld, audited and reasoned about as though it were real.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS COVERAGE — ALL THREE READ FROM THE LIVE CONTAINER
 * ---------------------------------------------------------------------------
 *
 *  1. `@RequirePermissions(...)` on a route or controller. The normal case,
 *     enforced by `PermissionsGuard`, and the only one visible to a reader of
 *     the route.
 *  2. `@ConsultsPermissions(...)` on a handler that decides the code ITSELF,
 *     because the requirement depends on the request body or on the caller's
 *     own set (`PATCH .../active`, `PATCH /products/:id`, the two OR-routes).
 *  3. An AUDIENCE ACCESS code, which is checked by `AuthService.assertEligible`
 *     when the token is MINTED rather than per route — issuing a valid admin
 *     cookie and then refusing every request one at a time is not the same
 *     control.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO LONGER A SOURCE SCAN
 * ---------------------------------------------------------------------------
 *
 * (2) used to be discovered by REGEX-SCANNING every `.ts` file under `src/` for
 * `assertPermission(...)` / `hasPermission(...)` / `permissions.includes('…')`
 * and pulling string literals out of the match. That was the weakest part of
 * this file, in four separate ways:
 *
 *   - IT COULD NOT TELL LIVE CODE FROM DEAD CODE. A commented-out call, a call
 *     inside an `if (false)`, or a helper that is never invoked all counted as
 *     coverage.
 *   - IT WAS DEFEATED BY ORDINARY REFACTORING. A code held in a constant, built
 *     by template literal, or passed through a variable vanished from the scan
 *     while the check itself still worked — so tightening the code could break
 *     the test, which teaches people to weaken the test.
 *   - IT WENT STALE SILENTLY. The pattern named three helpers by name; renaming
 *     one, or adding a fourth, would have left the scan matching nothing and
 *     the suite still green.
 *   - IT MATCHED THE WRONG FILES. Any `.ts` under `src/` counted, including
 *     ones that merely MENTION a code in prose.
 *
 * `@ConsultsPermissions(...)` replaces it with metadata read from the running
 * application, exactly like (1). The decorator enforces nothing — it is a
 * declaration, and it is a lie unless the handler really does decide the code
 * — so every route carrying it also has a BEHAVIOURAL spec asserting the
 * refusal (`permission-enforcement-gaps.int-spec.ts`,
 * `assignable-roles.int-spec.ts`, `pos-catalog-and-report-authz.int-spec.ts`).
 * This file answers "is this capability wired to anything at all"; those answer
 * "does it actually refuse".
 *
 * A CODE THAT EXISTS ONLY IN THE CATALOGUE, ONLY IN A MIGRATION, ONLY IN
 * FRONTEND GATING OR ONLY IN DOCUMENTATION FAILS THIS TEST. None of those four
 * places is reachable from the container, and that is the point: they are all
 * places a permission can LOOK real while authorising nothing.
 */

/** A capability and where the container says it is enforced. */
interface Coverage {
  declared: Set<string>;
  consulted: Set<string>;
}

describe('permission catalogue coverage', () => {
  let app: TestApp;
  let declaredOnRoutes: Set<string>;
  let consultedInHandlers: Set<string>;

  beforeAll(async () => {
    app = await createTestApp();
    const { declared, consulted } = readCoverage(app);
    declaredOnRoutes = declared;
    consultedInHandlers = consulted;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Walks every controller Nest actually instantiated and reads both
   * permission metadata keys off the class and off each route handler.
   *
   * The class-level read matters as much as the handler-level one:
   * `RoleController` declares `rbac.read` once for the whole controller, and a
   * handler-only walk would report it as uncovered.
   */
  function readCoverage(testApp: TestApp): Coverage {
    const reflector = testApp.app.get(Reflector);
    const declared = new Set<string>();
    const consulted = new Set<string>();

    const modules = (
      testApp.app as unknown as {
        container: {
          getModules(): Map<
            string,
            {
              controllers: Map<
                unknown,
                {
                  metatype?: new (...args: never[]) => unknown;
                  instance?: object;
                }
              >;
            }
          >;
        };
      }
    ).container.getModules();

    // `Reflector.get` is typed for a class or a function, which is exactly what
    // a controller metatype and a route handler are; the cast is on the way IN
    // (the container hands them back loosely typed), never on the result.
    const collect = (
      target: Type<unknown> | ((...args: never[]) => unknown),
      into: Set<string>,
      key: string,
    ): void => {
      const codes = reflector.get<string[] | undefined>(key, target);
      for (const code of codes ?? []) into.add(code);
    };

    for (const module of modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype;
        const instance = wrapper.instance;
        if (!metatype || !instance) continue;

        collect(metatype as Type<unknown>, declared, PERMISSIONS_KEY);
        collect(
          metatype as Type<unknown>,
          consulted,
          CONSULTED_PERMISSIONS_KEY,
        );

        const proto = Object.getPrototypeOf(instance) as object;
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name === 'constructor') continue;
          const handler = (proto as Record<string, unknown>)[name] as
            | ((...args: never[]) => unknown)
            | undefined;
          if (typeof handler !== 'function') continue;
          // Only real ROUTE handlers. A private method carrying no path
          // metadata is not a place a permission can be enforced.
          if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) {
            continue;
          }
          collect(handler, declared, PERMISSIONS_KEY);
          collect(handler, consulted, CONSULTED_PERMISSIONS_KEY);
        }
      }
    }

    return { declared, consulted };
  }

  const enforcedSomewhere = (code: string): boolean =>
    declaredOnRoutes.has(code) || consultedInHandlers.has(code);

  it('enforces EVERY catalogue code somewhere', () => {
    const audienceCodes = new Set<string>(
      Object.values(AUDIENCE_ACCESS_PERMISSION),
    );

    const uncovered = PERMISSION_CATALOG.filter(
      (spec) => !enforcedSomewhere(spec.code) && !audienceCodes.has(spec.code),
    ).map((spec) => `${spec.code} (${spec.groupKey}, ${spec.risk})`);

    if (uncovered.length > 0) {
      // Printed rather than only asserted: the failure message is the whole
      // value of this test, and a bare `toEqual([])` diff on 45 codes is not
      // something anybody reads correctly at speed.
      console.error(
        [
          '',
          `${uncovered.length} catalogue permission(s) authorise NOTHING:`,
          ...uncovered.map((line) => `  - ${line}`),
          '',
          'Each of these can be granted and withheld on the access-control',
          'screen while changing nothing at all. Guard a route with',
          '@RequirePermissions, declare @ConsultsPermissions on the handler',
          'that decides it, or retire the code with a migration. A code that',
          'exists only in the catalogue, only in a migration, only in frontend',
          'gating or only in documentation is NOT enforcement.',
          '',
        ].join('\n'),
      );
    }

    expect(uncovered).toEqual([]);
  });

  /**
   * The named capabilities, asserted ONE BY ONE.
   *
   * These are covered by the sweep above too. They are restated individually
   * because each was a specific reported defect or a specific delegated-role
   * requirement, and a future refactor that drops one should fail with a
   * message naming it rather than with a 45-line diff.
   */
  describe('the capabilities this file was opened for, individually', () => {
    const NAMED = [
      // The original defect: two decorative tick boxes.
      'products.activate',
      'products.deactivate',
      // The create/edit split, and the image-upload OR that broke a
      // create-only role's form.
      'products.create',
      'products.update',
      // Reader versus actor on the money-moving queue.
      'reconciliation.read',
      'reconciliation.act',
      // The cashier's own receipt, which used to be gated on the `sale` ROLE
      // and therefore refused a delegated order manager.
      'pos.receipt.read_own',
    ] as const;

    for (const code of NAMED) {
      it(`enforces ${code}`, () => {
        expect(enforcedSomewhere(code)).toBe(true);
      });
    }
  });

  describe('the three audience-access codes', () => {
    /**
     * These are NOT route permissions and must not be asserted as if they
     * were. `AuthService.assertEligible` consults them when the token is
     * minted: refusing at the door rather than at each room is the whole
     * control, because minting a valid admin cookie for somebody who may not
     * administer and then refusing each request one at a time still puts a
     * working admin session in their browser.
     */
    for (const [audience, code] of Object.entries(AUDIENCE_ACCESS_PERMISSION)) {
      it(`keeps ${code} in the catalogue for the ${audience} surface`, () => {
        expect(PERMISSION_CODES.has(code)).toBe(true);
      });
    }
  });

  it('declares no permission that the catalogue does not define', () => {
    // A second line of defence rather than the only one: `PermissionCode` is
    // now a literal union derived from the catalogue, so `@RequirePermissions`
    // and `@ConsultsPermissions` reject an unknown code AT COMPILE TIME. This
    // still catches a code that reached the metadata some other way — a cast,
    // a dynamically built decorator, a stale compiled artefact.
    const unknown = [...declaredOnRoutes, ...consultedInHandlers].filter(
      (code) => !PERMISSION_CODES.has(code),
    );
    expect(unknown).toEqual([]);
  });

  it('declares @ConsultsPermissions only where a decorator genuinely cannot state the rule', () => {
    /*
     * A GUARD ON THE ESCAPE HATCH.
     *
     * `@ConsultsPermissions` enforces nothing, so it is the one way to make
     * this file report coverage that does not exist. Keeping the set SMALL and
     * ENUMERATED is what stops it becoming the default: adding a code here is
     * a deliberate edit to this list, with a reason, rather than something
     * that happens quietly.
     *
     * Every code below is additionally proven to REFUSE by a behavioural spec;
     * the comment on each says which question it answers.
     */
    expect([...consultedInHandlers].sort()).toEqual([
      // PATCH /branch/:id/active — direction chosen by `dto.isActive`.
      'branches.activate',
      'branches.deactivate',
      // POST /products — only when `initialStock` is above zero, which a
      // decorator cannot express (it depends on a value in the body).
      // Listed here because this array is compared against a SORTED set.
      'inventory.adjust',
      // GET /orders/:id — administrator record vs cashier's own receipt.
      'orders.read',
      'pos.receipt.read_own',
      // PATCH /products/:id — only when a variant's state actually CHANGES.
      'products.activate',
      // POST /products/uploadImage — create OR update.
      'products.create',
      'products.deactivate',
      'products.update',
      // PATCH /admin/users/:id/active — direction chosen by `dto.isActive`.
      'users.activate',
      // GET /admin/users/assignable-roles — create OR update.
      'users.create',
      'users.deactivate',
      'users.update',
    ]);
  });
});

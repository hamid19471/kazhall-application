import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { AUDIENCES_KEY } from 'src/modules/auth/decorators/audience.decorator';
import { IS_PUBLIC_KEY } from 'src/modules/auth/decorators/public.decorator';
import { PERMISSIONS_KEY } from 'src/modules/auth/permissions/permission.decorator';
import { ROLES_KEY } from 'src/modules/auth/decorators/role.decorator';
import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';

import { TestApp, createTestApp } from './setup/test-app';

interface Row {
  method: string;
  path: string;
  audiences: string;
  permissions: string;
  roles: string;
  isPublic: boolean;
  controller: string;
}

/**
 * ===========================================================================
 * THE ROUTE MAP — asserted, not described
 * ===========================================================================
 *
 * The delivery report claims a particular authorisation surface. A claim about
 * guards that nothing checks is a claim that quietly stops being true, so this
 * reads the metadata out of the REAL application container — exactly as
 * `audience-coverage.int-spec.ts` does for audiences — and asserts the
 * properties the owner was promised:
 *
 *  - every ADMIN-audience route that MUTATES declares a permission;
 *  - no route declares a permission that is not in the catalogue;
 *  - no admin-audience route is still gated on `super_admin` ALONE, which was
 *    the whole point of replacing role names with capabilities.
 *
 * It also prints the map, so the report's table is generated rather than
 * transcribed.
 */
describe('admin route map', () => {
  let app: TestApp;
  let rows: Row[];

  beforeAll(async () => {
    app = await createTestApp();
    const reflector = app.app.get(Reflector);
    const modules = (
      app.app as unknown as {
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

    rows = [];
    for (const module of modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype;
        const instance = wrapper.instance;
        if (!metatype || !instance) continue;

        const base =
          (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';
        const classAud = reflector.get<string[]>(AUDIENCES_KEY, metatype);
        const classPerm = reflector.get<string[]>(PERMISSIONS_KEY, metatype);
        const classRoles = reflector.get<string[]>(ROLES_KEY, metatype);
        const classPublic = reflector.get<boolean>(IS_PUBLIC_KEY, metatype);

        for (const name of Object.getOwnPropertyNames(
          Object.getPrototypeOf(instance),
        )) {
          if (name === 'constructor') continue;
          const handler = (instance as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as
            | string
            | undefined;
          if (methodPath === undefined) continue;

          const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number;
          rows.push({
            controller: metatype.name,
            method: RequestMethod[verb] ?? String(verb),
            path:
              `/${base}/${methodPath}`
                .replace(/\/+/g, '/')
                .replace(/\/$/, '') || '/',
            audiences: (
              reflector.get<string[]>(AUDIENCES_KEY, handler) ??
              classAud ??
              []
            ).join('|'),
            permissions: (
              reflector.get<string[]>(PERMISSIONS_KEY, handler) ??
              classPerm ??
              []
            ).join(','),
            roles: (
              reflector.get<string[]>(ROLES_KEY, handler) ??
              classRoles ??
              []
            ).join(','),
            isPublic:
              (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ??
                classPublic) === true,
          });
        }
      }
    }
    rows.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('prints the authoritative route map', () => {
    const lines = rows.map(
      (r) =>
        `${r.method.padEnd(6)} ${r.path.padEnd(56)} aud=${(r.audiences || '-').padEnd(18)} perm=${r.permissions || '-'}${r.roles ? ` roles=${r.roles}` : ''}${r.isPublic ? ' PUBLIC' : ''}`,
    );

    console.log(`\nROUTE MAP (${rows.length} routes)\n${lines.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(80);
  });

  it('declares only permissions that exist in the catalogue', () => {
    const bogus = rows.flatMap((r) =>
      r.permissions
        .split(',')
        .filter((code) => code !== '' && !PERMISSION_CODES.has(code))
        .map((code) => `${r.method} ${r.path} -> ${code}`),
    );
    expect(bogus).toEqual([]);
  });

  /**
   * The point of the whole model: a route an administrator can reach must say
   * WHICH capability it needs, so the owner can delegate it. A mutation that
   * declares nothing is reachable by anyone who can open the console.
   */
  it('requires a permission on every admin-audience mutation', () => {
    const mutations = rows.filter(
      (r) =>
        !r.isPublic &&
        r.audiences.split('|').includes('admin') &&
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method),
    );
    const undeclared = mutations
      .filter((r) => r.permissions === '')
      .map((r) => `${r.method} ${r.path} (${r.controller})`);

    /*
     * THE ALLOW-LIST, and why each one is on it.
     *
     * `/auth/admin/logout` and `/auth/admin/logout-all` end the CALLER'S OWN
     * session. Requiring a capability to sign yourself out would mean a
     * principal whose permissions were just revoked could not leave.
     * `/auth/admin/change-password` is the only route that clears
     * `mustChangePassword`; gating it is a lockout with no exit.
     * `/payment/start` and `/payment/verify` are the CUSTOMER's checkout,
     * reachable from the admin audience only so an operator can complete a
     * payment on a customer's behalf; they authorise on order ownership.
     * `/products/admin/codes/product` and `/products/admin/codes/variant`
     * only draw the next value from a PostgreSQL sequence — they write no
     * row, reserve nothing and reveal nothing about the catalogue. They are
     * gated on the `super_admin` ROLE instead, for the same reason sales
     * reporting is: the owner's rule is that the code scheme is not delegable,
     * and a capability is by definition a thing that CAN be delegated.
     */
    const allowed = new Set([
      'POST /auth/admin/logout',
      'POST /auth/admin/logout-all',
      'POST /auth/admin/change-password',
      'POST /auth/admin/refresh',
      'POST /payment/start',
      'POST /payment/verify',
      'POST /products/admin/codes/product',
      'POST /products/admin/codes/variant',
      // Purchase cost, inventory valuation and line-level returns/refunds
      // (docs/PURCHASE-COST-ACCOUNTING.md §8): the third NON-delegable class,
      // gated on the super_admin ROLE exactly like sales reporting.
      'POST /admin/costing/variants/:variantId/receipts',
      'POST /admin/costing/variants/:variantId/corrections',
      'POST /admin/costing/variants/:variantId/valuation',
      'PUT /admin/costing/variants/:variantId/purchase-price',
      'POST /admin/orders/:orderId/line-adjustments',
      // Monthly cost-recovery pricing plans (docs/MONTHLY-PRICING.md): the
      // fourth non-delegable class — the owner's costs, targets and margin,
      // and every selling price.
      'POST /admin/pricing-plans',
      'PATCH /admin/pricing-plans/:planId',
      'DELETE /admin/pricing-plans/:planId',
      'POST /admin/pricing-plans/:planId/costs',
      'PATCH /admin/pricing-plans/:planId/costs/:entryId',
      'DELETE /admin/pricing-plans/:planId/costs/:entryId',
      'PUT /admin/pricing-plans/:planId/costs/order',
      'POST /admin/pricing-plans/:planId/calculate',
      'PATCH /admin/pricing-plans/:planId/items/:itemId',
      'POST /admin/pricing-plans/:planId/items/bulk',
      'POST /admin/pricing-plans/:planId/approve',
      'POST /admin/pricing-plans/:planId/unapprove',
      'POST /admin/pricing-plans/:planId/apply',
      'POST /admin/pricing-plans/:planId/rollback',
    ]);
    expect(undeclared.filter((r) => !allowed.has(r.split(' (')[0]))).toEqual(
      [],
    );
  });

  /**
   * ROLE-ONLY GATING IS AN EXCEPTION, AND THE EXCEPTIONS ARE LISTED HERE.
   *
   * The rule this case was written for still stands: gating an admin route on
   * the `super_admin` ROLE instead of a capability is what made delegation
   * impossible, and it must not be the default.
   *
   * But the owner named one class of data that is NOT delegable:
   *
   *   "Sales reports must be available only to the main administrator,
   *    represented by the built-in `super_admin` role."
   *
   * For that class, a capability would be exactly wrong — a capability is a
   * thing that CAN be granted, and the requirement is that this one cannot be.
   * There is deliberately no reports capability in `PERMISSION_CATALOG`; the
   * former `reports.read` was removed from it and retired in the database by
   * migration 0028. So these five routes carry `@Roles(super_admin)` and no
   * permission, on purpose.
   *
   * The list is CLOSED rather than the check being deleted. A sixth route
   * gated this way — the likely accident, someone reaching for `@Roles`
   * because it is quicker than adding a catalogue entry — still fails here and
   * has to be argued for explicitly.
   */
  const ROLE_ONLY_BY_DESIGN = new Set([
    'GET /reports/sales/summary',
    'GET /reports/sales',
    'GET /reports/sales/by-cashier',
    'GET /reports/sales/:id',
    'GET /admin/dashboard/financial',
    // «تولید خودکار کد» — code allocation, the second NON-delegable class.
    // Owning the «کد محصول»/«کد گونه» scheme is the main administrator's job,
    // so like sales reporting these carry `@Roles(super_admin)` and there is
    // deliberately no capability in PERMISSION_CATALOG that could grant them.
    'POST /products/admin/codes/product',
    'POST /products/admin/codes/variant',
    // Purchase cost and gross profit — the third non-delegable class
    // (docs/PURCHASE-COST-ACCOUNTING.md §8). The owner's rule for sales
    // reports extends to what the stock COST and what a sale EARNED: only the
    // main administrator sees or changes them, so there is deliberately no
    // cost capability in PERMISSION_CATALOG either.
    'GET /reports/profit/summary',
    'GET /reports/profit/breakdown',
    'GET /reports/profit/orders',
    'GET /reports/profit/orders/:orderId',
    'GET /admin/costing/variants/:variantId',
    'GET /admin/costing/products/:productId',
    'GET /admin/costing/unvalued',
    'POST /admin/costing/variants/:variantId/receipts',
    'POST /admin/costing/variants/:variantId/corrections',
    'POST /admin/costing/variants/:variantId/valuation',
    'PUT /admin/costing/variants/:variantId/purchase-price',
    'POST /admin/orders/:orderId/line-adjustments',
    // Monthly cost-recovery pricing plans (docs/MONTHLY-PRICING.md §7) — the
    // fourth non-delegable class. A plan holds the owner's monthly costs,
    // revenue target and profit margin and rewrites every selling price, so
    // like cost and profit it is the main administrator's alone.
    'GET /admin/pricing-plans',
    'GET /admin/pricing-plans/:planId',
    'GET /admin/pricing-plans/:planId/summary',
    'GET /admin/pricing-plans/:planId/items',
    'GET /admin/pricing-plans/:planId/rollback-preview',
    'GET /admin/pricing-plans/:planId/runs',
    'GET /admin/pricing-plans/:planId/runs/:runId',
    'GET /admin/pricing-plans/:planId/changes',
    'POST /admin/pricing-plans',
    'PATCH /admin/pricing-plans/:planId',
    'DELETE /admin/pricing-plans/:planId',
    'POST /admin/pricing-plans/:planId/costs',
    'PATCH /admin/pricing-plans/:planId/costs/:entryId',
    'DELETE /admin/pricing-plans/:planId/costs/:entryId',
    'PUT /admin/pricing-plans/:planId/costs/order',
    'POST /admin/pricing-plans/:planId/calculate',
    'PATCH /admin/pricing-plans/:planId/items/:itemId',
    'POST /admin/pricing-plans/:planId/items/bulk',
    'POST /admin/pricing-plans/:planId/approve',
    'POST /admin/pricing-plans/:planId/unapprove',
    'POST /admin/pricing-plans/:planId/apply',
    'POST /admin/pricing-plans/:planId/rollback',
  ]);

  it('leaves no admin route gated on super_admin alone, beyond sales reporting', () => {
    const roleOnly = rows
      .filter(
        (r) =>
          !r.isPublic &&
          r.audiences.split('|').includes('admin') &&
          r.roles.includes('super_admin') &&
          r.permissions === '',
      )
      .map((r) => `${r.method} ${r.path}`);

    expect(roleOnly.filter((r) => !ROLE_ONLY_BY_DESIGN.has(r))).toEqual([]);

    // And every route on the list is really still there — so deleting one
    // without deleting its entry is caught too.
    expect([...roleOnly].sort()).toEqual([...ROLE_ONLY_BY_DESIGN].sort());
  });

  /**
   * THE OTHER HALF: no sales-reporting route may be reachable by a CAPABILITY.
   *
   * If someone adds `@RequirePermissions(...)` to a reporting route, the case
   * above stops flagging it (it is no longer "role alone") and the owner's
   * rule is quietly broken. This asserts the inverse directly.
   */
  it('gates every reporting route on the role and on NO capability', () => {
    const reporting = rows.filter(
      (r) =>
        r.path.startsWith('/reports/') ||
        r.path === '/admin/dashboard/financial',
    );
    expect(reporting.length).toBeGreaterThan(0);
    for (const route of reporting) {
      expect({
        route: `${route.method} ${route.path}`,
        roles: route.roles,
        permissions: route.permissions,
        audiences: route.audiences,
      }).toEqual({
        route: `${route.method} ${route.path}`,
        roles: 'super_admin',
        permissions: '',
        audiences: 'admin',
      });
    }
  });
});

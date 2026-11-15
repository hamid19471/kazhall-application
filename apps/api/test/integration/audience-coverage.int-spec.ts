/**
 * EVERY PROTECTED ROUTE NAMES ITS APPLICATION.
 *
 * `JwtAuthGuard` falls back to a fixed audience order for a route that declares
 * none, so a forgotten `@Audiences(...)` fails open onto whichever surface the
 * caller happens to hold a cookie for — quietly recreating the shared session
 * this work removed. That fallback exists so a route in flight cannot 500; this
 * case is what stops it becoming the norm.
 *
 * A new route is added with `@Audiences(...)` or with `@Public()`. There is no
 * third option, and this test is where that is enforced rather than in review.
 */
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AUDIENCES_KEY } from 'src/modules/auth/decorators/audience.decorator';
import { IS_PUBLIC_KEY } from 'src/modules/auth/decorators/public.decorator';
import { SESSION_AUDIENCES } from 'src/modules/auth/audience';
import { createTestApp, TestApp } from './support/catalog.harness';

interface RouteRecord {
  controller: string;
  handler: string;
  method: string;
  path: string;
  audiences: string[] | undefined;
  isPublic: boolean;
}

function collectRoutes(app: INestApplication): RouteRecord[] {
  const reflector = app.get(Reflector);
  const modules = (
    app as unknown as {
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

  const routes: RouteRecord[] = [];
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype;
      const instance = wrapper.instance;
      if (!metatype || !instance) continue;

      const basePath =
        (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';
      const classAudiences = reflector.get<string[]>(AUDIENCES_KEY, metatype);
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
        routes.push({
          controller: metatype.name,
          handler: name,
          method: RequestMethod[verb] ?? String(verb),
          path:
            `/${basePath}/${methodPath}`
              .replace(/\/+/g, '/')
              .replace(/\/$/, '') || '/',
          audiences:
            reflector.get<string[]>(AUDIENCES_KEY, handler) ?? classAudiences,
          isPublic:
            (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ?? classPublic) ===
            true,
        });
      }
    }
  }
  return routes;
}

describe('audience coverage (int)', () => {
  let ctx: TestApp;
  let routes: RouteRecord[];

  beforeAll(async () => {
    ctx = await createTestApp();
    routes = collectRoutes(ctx.app);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('finds the routes at all, guarding against a vacuous pass', () => {
    expect(routes.length).toBeGreaterThan(60);
  });

  it('declares an audience on every route that is not public', () => {
    const undeclared = routes
      .filter((r) => !r.isPublic)
      .filter((r) => !r.audiences || r.audiences.length === 0)
      .map((r) => `${r.controller}.${r.handler}  ${r.path}`);

    expect(undeclared).toEqual([]);
  });

  it('declares only real audiences', () => {
    const bogus = routes
      .filter((r) => r.audiences)
      .flatMap((r) =>
        (r.audiences ?? [])
          .filter((a) => !(SESSION_AUDIENCES as readonly string[]).includes(a))
          .map((a) => `${r.controller}.${r.handler}: ${a}`),
      );
    expect(bogus).toEqual([]);
  });

  it('keeps the surfaces the owner named to their own audience', () => {
    const find = (method: string, path: string) =>
      routes.find((r) => r.method === method && r.path === path);

    // The management order list is the Admin console's, not the till's.
    expect(find('GET', '/orders')?.audiences).toEqual(['admin']);
    /*
     * REPORTS ARE THE ADMIN CONSOLE'S, AND ONLY THE ADMIN CONSOLE'S.
     *
     * This used to expect `['admin', 'pos']`, on the reasoning that an
     * administrator might read the figures at the till. That is precisely the
     * hole: the same person holding `super_admin` who signs in at the till
     * gets a POS-cookie session, and a shared workstation then puts the shop's
     * takings one tab away from the shop floor. The audience is checked before
     * the role, so declaring `pos` at all means a POS session reaches the
     * handler and is turned away only by the role check — whereas declaring
     * `admin` alone means it is never admitted.
     *
     * A POS-audience `super_admin` now receives 401, not 403, and that
     * difference is asserted in `pos-catalog-and-report-authz.int-spec.ts`.
     */
    expect(find('GET', '/reports/sales/summary')?.audiences).toEqual(['admin']);
    // The till sells; nothing else does.
    expect(find('POST', '/orders/pos')?.audiences).toEqual(['pos']);
    // The basket belongs to the shop.
    expect(find('GET', '/cart')?.audiences).toEqual(['storefront']);
    // Online checkout is the shop's even though it lives beside the till's sale.
    expect(find('POST', '/orders')?.audiences).toEqual(['storefront']);
  });
});

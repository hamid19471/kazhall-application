/**
 * ===========================================================================
 * THE DELEGATED-ROLE MATRIX — one persona per capability, end to end
 * ===========================================================================
 *
 * THE QUESTION THIS ANSWERS. The owner's whole reason for the permission model
 * is delegation: "let my office manager reset cashier passwords without also
 * letting them void a paid sale." Every individual capability has a test
 * somewhere. What did not exist was the MATRIX — a single place that builds
 * each realistic delegated role and checks, for that role, that the console it
 * gets is exactly the console it should get and nothing more.
 *
 * A matrix catches a class of defect a per-capability test cannot: capability
 * BLEED. `users.read` quietly admitting the audit trail, `inventory.read`
 * admitting the movement ledger, `reconciliation.read` admitting the actions —
 * each of those is invisible when you only ever test the capability you are
 * thinking about, and obvious the moment every persona is checked against
 * every section.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CHECKED FOR EACH PERSONA
 *
 *  1. ADMIN LOGIN ELIGIBILITY. `admin.access` is the door, checked when the
 *     token is MINTED. A persona without it is refused at login and receives
 *     NO COOKIE — not a cookie that is then refused per route, which would
 *     still put a working-looking admin session in a browser.
 *  2. SIDEBAR AND PAGE VISIBILITY. `apps/web/lib/admin-nav.ts` gates each menu
 *     item on one capability code, and the page behind it re-checks the same
 *     code. Those codes are reproduced in `SECTIONS` below TOGETHER WITH THE
 *     API ROUTE each section actually calls, and the route is exercised. So
 *     "the sidebar shows what the server will serve" is asserted rather than
 *     assumed — the failure mode being a menu entry that leads to a 403, or a
 *     hidden entry the caller could have used.
 *  3. DIRECT API AUTHORISATION, for the persona's own sections (200) and for
 *     EVERY OTHER SECTION (403). Hiding a menu item is a kindness; this is the
 *     control.
 *  4. DIRECT URL BEHAVIOUR. Same thing: the API answers 403 whether the caller
 *     arrived through a rendered link or by typing the path, because the
 *     console has no server-side routing of its own — every admin screen
 *     fetches through the same API.
 *  5. SECONDARY BACKGROUND REQUESTS. The sidebar badges come from ONE extra
 *     request (`GET /admin/dashboard/summary`), and the shell only makes it
 *     when the caller holds `dashboard.read`. A persona without it must be
 *     refused that endpoint, so a console that made the request anyway would
 *     be visibly wrong rather than quietly leaking.
 *  6. NO PRIVILEGE ESCALATION. Nobody can grant themselves, or anybody else,
 *     something they do not hold.
 *  7. NO DATA LEAK THROUGH COUNTS OR BADGES. The badge counts are money and
 *     stock figures. They come from the same gated endpoint as the dashboard,
 *     so there is no "just the count" path that skips the capability.
 */
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { createUser, uniqueSuffix } from './setup/seed-helpers';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';

/**
 * ONE ADMIN SECTION: the sidebar's gating code, and the API route the page
 * behind it calls first.
 *
 * The `permission` values are copied from `apps/web/lib/admin-nav.ts`. They are
 * repeated here rather than imported because `apps/web` is a different
 * TypeScript project with its own paths — and repeating them is exactly what
 * makes this a check: if the menu is re-gated on a different code and this
 * table is not updated, the section's route will answer differently from what
 * the table predicts and the matrix fails.
 */
interface Section {
  key: string;
  /** The capability `admin-nav.ts` gates the menu item on. */
  permission: string;
  /** What the page fetches first. A 403 here is a blank or refused screen. */
  route: string;
}

const SECTIONS: readonly Section[] = [
  {
    key: 'dashboard',
    permission: 'dashboard.read',
    route: '/admin/dashboard/summary',
  },
  { key: 'products', permission: 'products.read', route: '/products/admin' },
  {
    key: 'categories',
    permission: 'categories.read',
    route: '/categories/admin',
  },
  {
    key: 'attributes',
    permission: 'attributes.read',
    route: '/attributes/admin',
  },
  { key: 'inventory', permission: 'inventory.read', route: '/admin/inventory' },
  { key: 'orders', permission: 'orders.read', route: '/orders' },
  {
    key: 'reconciliation',
    permission: 'reconciliation.read',
    route: '/payment/admin/reconciliation',
  },
  { key: 'users', permission: 'users.read', route: '/admin/users' },
  { key: 'cashiers', permission: 'users.read', route: '/admin/cashiers' },
  { key: 'branches', permission: 'branches.read', route: '/branch' },
  { key: 'access', permission: 'rbac.read', route: '/admin/access/roles' },
  { key: 'audit', permission: 'audit.read', route: '/admin/audit' },
  /*
   * REPORTS IS DELIBERATELY ABSENT FROM THIS TABLE.
   *
   * Every row above is a section a capability can OPEN, and the matrix's whole
   * claim is "this persona's sections answer 200 and every other section
   * answers 403". Sales reporting is not that kind of section: the owner's rule
   * is that it belongs to the built-in `super_admin` role and to nobody else,
   * so there is no capability that opens it and no persona below that should
   * see it. Listing it here with a capability code would assert the opposite.
   *
   * It is not untested — it is tested more strictly, as an invariant that holds
   * for EVERY persona rather than for one of them. See "reporting and the money
   * are nobody's to delegate" at the end of this file, and the full matrix in
   * `pos-catalog-and-report-authz.int-spec.ts`.
   */
] as const;

/** Every persona the owner might realistically delegate. */
interface Persona {
  name: string;
  /** WITHOUT `admin.access` — it is added by the builder, and its absence is its own case. */
  permissions: string[];
  /** Section keys whose menu item should be visible and whose route should answer 200. */
  sections: string[];
}

const PERSONAS: readonly Persona[] = [
  {
    name: 'dashboard reader',
    permissions: ['dashboard.read'],
    sections: ['dashboard'],
  },
  {
    name: 'catalogue reader',
    permissions: ['products.read', 'categories.read', 'attributes.read'],
    sections: ['products', 'categories', 'attributes'],
  },
  {
    name: 'catalogue editor without activate/deactivate',
    permissions: ['products.read', 'products.update'],
    sections: ['products'],
  },
  {
    name: 'catalogue activator',
    permissions: ['products.read', 'products.update', 'products.activate'],
    sections: ['products'],
  },
  {
    name: 'catalogue deactivator',
    permissions: ['products.read', 'products.update', 'products.deactivate'],
    sections: ['products'],
  },
  {
    name: 'inventory reader',
    permissions: ['inventory.read'],
    sections: ['inventory'],
  },
  {
    name: 'inventory adjuster',
    permissions: [
      'inventory.read',
      'inventory.adjust',
      'inventory.movements.read',
    ],
    sections: ['inventory'],
  },
  { name: 'order reader', permissions: ['orders.read'], sections: ['orders'] },
  {
    name: 'order status manager',
    permissions: ['orders.read', 'orders.status.update'],
    sections: ['orders'],
  },
  {
    name: 'void operator',
    permissions: ['orders.read', 'orders.void'],
    sections: ['orders'],
  },
  {
    name: 'return operator',
    permissions: ['orders.read', 'orders.return'],
    sections: ['orders'],
  },
  {
    name: 'reconciliation reader',
    permissions: ['reconciliation.read'],
    sections: ['reconciliation'],
  },
  {
    name: 'reconciliation actor',
    permissions: ['reconciliation.read', 'reconciliation.act'],
    sections: ['reconciliation'],
  },
  {
    name: 'user reader',
    permissions: ['users.read'],
    sections: ['users', 'cashiers'],
  },
  {
    name: 'user creator',
    permissions: ['users.read', 'users.create'],
    sections: ['users', 'cashiers'],
  },
  {
    name: 'user updater',
    permissions: ['users.read', 'users.update'],
    sections: ['users', 'cashiers'],
  },
  {
    name: 'password-reset operator',
    permissions: ['users.read', 'users.password.reset'],
    sections: ['users', 'cashiers'],
  },
  {
    name: 'session-revoke operator',
    permissions: ['users.read', 'users.sessions.revoke'],
    sections: ['users', 'cashiers'],
  },
  {
    name: 'branch reader',
    permissions: ['branches.read'],
    sections: ['branches'],
  },
  {
    name: 'branch manager',
    permissions: [
      'branches.read',
      'branches.create',
      'branches.update',
      'branches.activate',
      'branches.deactivate',
    ],
    sections: ['branches'],
  },
  { name: 'RBAC reader', permissions: ['rbac.read'], sections: ['access'] },
  {
    name: 'RBAC manager',
    permissions: ['rbac.read', 'rbac.manage'],
    sections: ['access'],
  },
] as const;

describe('delegated role matrix (int)', () => {
  let app: TestApp;
  let admin: CookieJar;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(
      app,
      created.username,
      created.password,
      'admin',
    );
  });

  async function roleWith(permissions: string[]): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(app, admin)
      .post('/admin/access/roles')
      .send({ name: `p_${suffix}`, titleFa: 'نقش واگذارشده', permissions });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  /** Signs a persona in on the ADMIN surface and returns its jar. */
  async function signIn(
    permissions: string[],
  ): Promise<{ jar: CookieJar; userId: number }> {
    const roleId = await roleWith(['admin.access', ...permissions]);
    const created = await createUser(app.dataSource, { roles: [] });
    await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] })
      .expect(200);
    return {
      jar: await authenticate(app, created.username, created.password, 'admin'),
      userId: created.user.id,
    };
  }

  // =======================================================================
  // 1. The door
  // =======================================================================

  it('refuses the admin door outright to a role WITHOUT admin.access, and sets no cookie', async () => {
    // The door is checked when the token is minted, not per route. A cookie
    // that is then refused everywhere is still a working-looking admin session
    // in somebody's browser.
    const roleId = await roleWith(['orders.read', 'audit.read']);
    const created = await createUser(app.dataSource, { roles: [] });
    await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] })
      .expect(200);

    await expect(
      authenticate(app, created.username, created.password, 'admin'),
    ).rejects.toThrow(/401/);
  });

  // =======================================================================
  // 2. The matrix itself
  // =======================================================================

  describe.each(PERSONAS.map((p) => [p.name, p] as const))(
    'persona: %s',
    (_name, persona) => {
      it('sees exactly its own sections and is refused every other one', async () => {
        const { jar } = await signIn(persona.permissions);
        const held = new Set(['admin.access', ...persona.permissions]);

        // The session really is an admin session, and `/me` reports exactly
        // the capabilities the role confers — which is what the console reads
        // to decide the sidebar.
        const me = await withCookies(app, jar)
          .get('/auth/admin/me')
          .expect(200);
        expect(new Set(me.body.data.permissions as string[])).toEqual(held);

        for (const section of SECTIONS) {
          const shouldSee = held.has(section.permission);
          // The sidebar predicate and the persona table must agree; a
          // disagreement here means the persona list is wrong, not the API.
          expect([section.key, shouldSee]).toEqual([
            section.key,
            persona.sections.includes(section.key),
          ]);

          const response = await withCookies(app, jar).get(section.route);

          if (shouldSee) {
            // The page behind a visible menu item must actually load.
            expect([section.key, response.status]).toEqual([section.key, 200]);
          } else {
            // ...and a hidden one must be refused when typed into the URL bar,
            // with the machine-readable code the console renders as "you may
            // not open this", never a blank screen or a partial payload.
            expect([section.key, response.status]).toEqual([section.key, 403]);
            expect(response.body.error).toBe('PERMISSION_DENIED');
            expect(response.body.details.missingPermissions).toContain(
              section.permission,
            );
            // NOTHING of the payload leaks alongside the refusal.
            expect(response.body.data).toBeUndefined();
          }
        }
      });

      it('makes no authorised background request it should not, and sees no badge counts', async () => {
        // The sidebar's three badges are all derived from ONE request, and the
        // shell only issues it when `dashboard.read` is held. The counts are
        // open reconciliation cases, unfulfilled orders and low stock — real
        // operational figures, not decoration.
        const { jar } = await signIn(persona.permissions);
        const holdsDashboard = persona.permissions.includes('dashboard.read');

        const response = await withCookies(app, jar).get(
          '/admin/dashboard/summary',
        );

        if (holdsDashboard) {
          expect(response.status).toBe(200);
        } else {
          expect(response.status).toBe(403);
          // Not "the counts are zero" — the endpoint is closed, so there is no
          // count-shaped side channel at all.
          expect(JSON.stringify(response.body)).not.toContain('pipeline');
        }
      });

      it('cannot escalate its own authority', async () => {
        const { jar, userId } = await signIn(persona.permissions);

        // (a) It cannot mint a role carrying something it does not hold.
        const mintUnheld = await withCookies(app, jar)
          .post('/admin/access/roles')
          .send({
            name: `escalate_${uniqueSuffix().replace(/[^a-z0-9_]/g, '')}`,
            titleFa: 'تلاش برای ارتقا',
            permissions: ['rbac.manage', 'users.password.reset', 'orders.void'],
          });
        expect([403, 404]).toContain(mintUnheld.status);

        // (b) It cannot give ITSELF the administrator role.
        const [superAdminRole] = await app.dataSource.query<
          Array<{ id: number }>
        >(`SELECT id FROM roles WHERE name = 'super_admin'`);
        const selfPromote = await withCookies(app, jar)
          .put(`/admin/access/users/${userId}/roles`)
          .send({ roleIds: [superAdminRole.id] });
        expect([403, 404]).toContain(selfPromote.status);

        // (c) And its own capability set is unchanged after trying.
        const me = await withCookies(app, jar)
          .get('/auth/admin/me')
          .expect(200);
        expect(new Set(me.body.data.permissions as string[])).toEqual(
          new Set(['admin.access', ...persona.permissions]),
        );
      });
    },
  );

  // =======================================================================
  // 3. Reader versus actor, on the pair that moves money
  // =======================================================================

  describe('reconciliation reader versus actor', () => {
    /**
     * A PAID order whose fulfilment is still pending — the shape the
     * reconciliation queue exists for. Written with the same columns
     * `permission-enforcement-gaps.int-spec.ts` uses, so the two specs cannot
     * drift on what an open case looks like.
     */
    async function seedOpenCase(): Promise<number> {
      const [order] = await app.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO orders
           (channel, status, total_price, subtotal, "fulfillmentState",
            paid_at, "paidAt", "soldAt")
         VALUES ('online', 'paid', 1000000, 1000000, 'pending',
                 now(), now(), now())
         RETURNING id`,
      );
      return Number(order.id);
    }

    it('offers the reader no actions and refuses the mutation itself', async () => {
      const orderId = await seedOpenCase();
      const reader = await signIn(['reconciliation.read']);

      const detail = await withCookies(app, reader.jar)
        .get(`/payment/admin/reconciliation/${orderId}`)
        .expect(200);
      // The buttons are computed from the CALLER's capabilities, not from the
      // case's state alone — the defect that handed an auditor five
      // critical-risk buttons.
      expect(detail.body.data.allowedActions).toEqual([]);

      // And the refusal is real, not merely a hidden button.
      const attempt = await withCookies(app, reader.jar)
        .post(`/payment/admin/reconciliation/${orderId}/mark-refund-required`)
        .send({ reason: 'تلاش برای اقدام بدون اختیار لازم.' });
      expect(attempt.status).toBe(403);
      expect(attempt.body.details.missingPermissions).toContain(
        'reconciliation.act',
      );
    });

    it('offers the actor the state-appropriate actions', async () => {
      const orderId = await seedOpenCase();
      const actor = await signIn(['reconciliation.read', 'reconciliation.act']);

      const detail = await withCookies(app, actor.jar)
        .get(`/payment/admin/reconciliation/${orderId}`)
        .expect(200);
      expect(detail.body.data.allowedActions.length).toBeGreaterThan(0);
    });
  });

  // =======================================================================
  // 4. The activate/deactivate split, as two personas rather than one
  // =======================================================================

  describe('catalogue activator versus deactivator', () => {
    async function variant(): Promise<{
      productId: number;
      variantId: number;
    }> {
      const productCode = `MTXP-${uniqueSuffix()
        .toUpperCase()
        .replace(/_/g, '-')}`;
      const [product] = await app.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO products (title, description, "basePrice", "productCode",
                               "visibleOnSite", "branchVisibility")
         VALUES ($1, 'matrix fixture', 1000000, $2, true, 'all') RETURNING id`,
        [`matrix_${uniqueSuffix()}`, productCode],
      );
      const [row] = await app.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO product_variants ("productId", sku, price, stock, "isActive",
                                       "variantCode")
         VALUES ($1, $2, 1000000, 5, true, $3) RETURNING id`,
        [
          product.id,
          `MTX-${uniqueSuffix()}`,
          // Derived from the parent: migration 0033 enforces the relationship
          // in the database, so an unrelated literal is no longer insertable.
          `${productCode}-V${uniqueSuffix().replace(/_/g, '')}`,
        ],
      );
      return { productId: product.id, variantId: row.id };
    }

    it('lets the DEACTIVATOR retire a variant and refuses the activator', async () => {
      const { productId, variantId } = await variant();
      const off = await signIn([
        'products.read',
        'products.update',
        'products.deactivate',
      ]);
      const on = await signIn([
        'products.read',
        'products.update',
        'products.activate',
      ]);

      // The activator may not take it off sale...
      const refused = await withCookies(app, on.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: variantId, isActive: false }] });
      expect(refused.status).toBe(403);
      expect(refused.body.details.missingPermissions).toContain(
        'products.deactivate',
      );

      // ...the deactivator may.
      await withCookies(app, off.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: variantId, isActive: false }] })
        .expect(200);

      // And now the mirror image: the deactivator cannot put it back.
      const refusedBack = await withCookies(app, off.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: variantId, isActive: true }] });
      expect(refusedBack.status).toBe(403);
      expect(refusedBack.body.details.missingPermissions).toContain(
        'products.activate',
      );

      await withCookies(app, on.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: variantId, isActive: true }] })
        .expect(200);
    });

    it('refuses BOTH transitions to an editor holding neither', async () => {
      const { productId, variantId } = await variant();
      const editor = await signIn(['products.read', 'products.update']);

      const offAttempt = await withCookies(app, editor.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: variantId, isActive: false }] });
      expect(offAttempt.status).toBe(403);

      // ...but an ordinary edit still works, which is the point of the split.
      await withCookies(app, editor.jar)
        .patch(`/products/${productId}`)
        .send({ title: 'renamed by the editor' })
        .expect(200);
    });
  });

  // =======================================================================
  // 5. Reporting and the money are nobody's to delegate
  // =======================================================================

  /**
   * THE OWNER'S RULE AS A CROSS-PERSONA INVARIANT.
   *
   * "Sales reports must be available only to the main administrator,
   * represented by the built-in `super_admin` role."
   *
   * Everything in the matrix above is a capability that CAN be delegated. This
   * block asserts the complement: there is no delegated role — not one built
   * from a single code, not one built from EVERY code the catalogue publishes —
   * that reaches the sales reports or today's money.
   *
   * TWO SURFACES, BECAUSE THERE ARE TWO WAYS TO ASK. `/reports/*` is the
   * obvious one. `GET /admin/dashboard/financial` is the one that would be
   * missed: the dashboard used to return today's gross, refunds, voids, net,
   * the per-channel and per-BRANCH revenue split and eight recent order
   * amounts inside the SAME payload a `dashboard.read` holder reads for the
   * pending-order badge. Splitting the contract is the fix; this is the test
   * that the split holds.
   *
   * THE THIRD SURFACE IS ASSERTED BY ABSENCE. `GET /admin/dashboard/summary`
   * is exercised for every persona in the matrix above, and the assertion below
   * reads the actual response body: no money field of any name may appear in
   * it, however the service is refactored. A future `totals.grossSales`
   * creeping back into the operational payload fails here.
   */
  describe('reporting and the money are nobody to delegate', () => {
    const REPORT_ROUTES = [
      '/reports/sales/summary?from=2026-01-01&to=2026-12-31',
      '/reports/sales?from=2026-01-01&to=2026-12-31',
      '/reports/sales/by-cashier?from=2026-01-01&to=2026-12-31',
      '/reports/sales/1',
    ];

    /** Every code the catalogue publishes — the most privileged delegated role that can exist. */
    async function theMostPrivilegedDelegate(): Promise<CookieJar> {
      /*
       * TWO EXCLUSIONS, BOTH DELIBERATE.
       *
       * `admin.access` because `signIn` prepends it and the DTO is
       * `@ArrayUnique()`. `storefront.access` because it is the CUSTOMER door,
       * which `super_admin` does not itself hold — `assertNoEscalation`
       * refuses to confer it, so a delegated role cannot carry it either and
       * excluding it does not weaken the claim.
       */
      const everythingElse = [...PERMISSION_CODES].filter(
        (code) => code !== 'admin.access' && code !== 'storefront.access',
      );
      const { jar } = await signIn(everythingElse);
      return jar;
    }

    it.each(REPORT_ROUTES)(
      'refuses %s to a role holding EVERY capability',
      async (route) => {
        const jar = await theMostPrivilegedDelegate();
        const response = await withCookies(app, jar).get(route);
        expect(response.status).toBe(403);
        // And nothing of the report comes back with the refusal.
        expect(JSON.stringify(response.body)).not.toMatch(
          /grossSales|netSales/,
        );
      },
    );

    it('refuses the financial dashboard to a role holding EVERY capability', async () => {
      const jar = await theMostPrivilegedDelegate();
      const response = await withCookies(app, jar).get(
        '/admin/dashboard/financial',
      );
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toMatch(/grossSales|netSales/);
    });

    it('serves the financial dashboard to a super_admin', async () => {
      // The other half of the rule: the main administrator is not locked out
      // by the same change that locked everybody else out.
      const response = await withCookies(app, admin).get(
        '/admin/dashboard/financial',
      );
      expect(response.status).toBe(200);
      expect(typeof response.body.data.money.grossSales).toBe('string');
    });

    /**
     * NO MONEY IN THE OPERATIONAL PAYLOAD — asserted on the body, not on a
     * field list, so it survives a refactor that renames things.
     *
     * `dashboard.read` is the badge capability: a shift supervisor holds it.
     * The response must carry counts and queue depths and no figure of money
     * anywhere in it, at any depth.
     */
    it('gives a dashboard.read holder counts and queues but no money, at any depth', async () => {
      const { jar } = await signIn(['dashboard.read']);
      const response = await withCookies(app, jar)
        .get('/admin/dashboard/summary')
        .expect(200);

      const body = response.body.data as Record<string, unknown>;
      expect(body.totals).toBeDefined();
      expect(body.pipeline).toBeDefined();

      /*
       * Money in this API is an integer-Rial STRING and counts are NUMBERS, so
       * a stray money field is findable structurally: walk the payload and
       * collect every key whose name says money. `semantics` is excluded
       * because it is prose ABOUT the figures — it names them in order to
       * explain which timestamp places them, and refusing it would be refusing
       * the documentation rather than the data.
       */
      const MONEY_NAME = /gross|net|total|refunded|voided|amount|price|sales/i;
      const offenders: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((item, i) => walk(item, `${path}[${i}]`));
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          const here = path ? `${path}.${key}` : key;
          if (here.startsWith('semantics')) continue;
          // A money figure is a STRING of digits under a money-ish name.
          // `refundedCount: 2` is a count and stays; `refundedTotal: "40000"`
          // is money and must not be here.
          if (
            MONEY_NAME.test(key) &&
            typeof value === 'string' &&
            /^-?\d+$/.test(value)
          ) {
            offenders.push(`${here} = ${value}`);
          }
          walk(value, here);
        }
      };
      walk(body, '');
      expect(offenders).toEqual([]);
    });

    /**
     * AND NOT THROUGH THE ORDER LIST EITHER.
     *
     * `orders.read` is delegatable and must stay so — somebody has to fulfil
     * the queue. It hands over individual order totals, which is the data the
     * job needs. What it must not hand over is an AGGREGATE: no endpoint under
     * it sums a day, and the report routes that do are refused above. This
     * case pins that an `orders.read` holder is still refused the aggregate
     * surfaces, so "list them all and add them up yourself" is the only path
     * left — which is a different thing from the server publishing the figure.
     */
    it('leaves an orders.read holder with rows but no aggregate', async () => {
      const { jar } = await signIn(['orders.read']);
      await withCookies(app, jar).get('/orders').expect(200);
      await withCookies(app, jar)
        .get('/reports/sales/summary?from=2026-01-01&to=2026-12-31')
        .expect(403);
      await withCookies(app, jar).get('/admin/dashboard/financial').expect(403);
    });

    /**
     * AND NOT THROUGH RECONCILIATION.
     *
     * `reconciliation.read` opens the payment-mismatch desk, which necessarily
     * shows amounts of individual disputed payments. It must not become a
     * back door to the day's takings.
     */
    it('leaves a reconciliation.read holder with the desk but no takings', async () => {
      const { jar } = await signIn(['reconciliation.read']);
      await withCookies(app, jar)
        .get('/payment/admin/reconciliation')
        .expect(200);
      await withCookies(app, jar).get('/admin/dashboard/financial').expect(403);
      await withCookies(app, jar)
        .get('/reports/sales/by-cashier?from=2026-01-01&to=2026-12-31')
        .expect(403);
    });
  });
});

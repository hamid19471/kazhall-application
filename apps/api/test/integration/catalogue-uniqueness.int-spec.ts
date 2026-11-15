import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import {
  closeTestDataSource,
  resetDb,
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';
import { createUser } from './setup/seed-helpers';

/**
 * ============================================================================
 * CATALOGUE UNIQUENESS — proved where it actually has to hold: in PostgreSQL.
 *
 * The application has always refused a duplicate category title, attribute
 * name and attribute value. Every one of those refusals is a SELECT followed
 * by an INSERT, so every one of them is a TOCTOU race: two requests that
 * arrive together both read "free" and both write. Migration 0025 closes it
 * with unique functional indexes, and this suite is what says so.
 *
 * WHY THERE ARE TWO KINDS OF CONCURRENCY CASE HERE
 * ------------------------------------------------
 * `Promise.all` over two supertest requests is worth having — it is the shape
 * a real client produces — but it does NOT prove the index closed the race.
 * Node dispatches both requests, and if the server happens to serialise them
 * the application-level probe catches the second one and the test passes
 * against a database with no constraint at all. That is exactly the false
 * green this whole workstream exists to remove.
 *
 * So every HTTP concurrency case is paired with a TWO-CONNECTION SQL case that
 * interleaves the writes deliberately:
 *
 *     connection A   BEGIN; INSERT 'x';
 *     connection B   BEGIN; INSERT 'x';      <- blocks on A's uncommitted row
 *     connection A   COMMIT;
 *     connection B                            <- 23505, always
 *
 * The block-then-fail is the unique index and nothing else: no application
 * code is involved, both connections passed any check they might have made,
 * and the second INSERT still cannot land. That is the only evidence that the
 * race is shut.
 *
 * THE DECISIONS BEING PINNED DOWN (and where they are written)
 * -----------------------------------------------------------
 *   SCOPE          category title  GLOBAL
 *                  attribute name  GLOBAL
 *                  attribute value WITHIN ONE ATTRIBUTE  <- «قرمز» may belong
 *                                  to «رنگ» AND to «رنگ آستر» at once
 *   NORMALISATION  fold ك→ک and ي→ی, trim the ends, lower-case
 *                  do NOT fold ZWNJ (نیم‌فاصله)
 *
 * Both are stated in `src/common/catalogue/catalogue-uniqueness.ts` and in the
 * migration header; the cases below are the executable copy.
 * ============================================================================
 */

/** `@types/pg` is not installed; narrow the small surface used here. */
interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
type PgClientCtor = new (config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}) => PgClientLike;
const PgClient = Client as unknown as PgClientCtor;

// ---------------------------------------------------------------------------
// The two spellings that must collide, written as escapes so no editor,
// clipboard or terminal can silently "helpfully" normalise them.
// ---------------------------------------------------------------------------
/** «کیف» — PERSIAN KEHEH U+06A9 + PERSIAN YEH U+06CC. What a Persian layout types. */
const PERSIAN_BAG = 'کیف';
/** «كيف» — ARABIC KAF U+0643 + ARABIC YEH U+064A. What an Arabic layout types. */
const ARABIC_BAG = 'كيف';
/** «دسته‌بندی» with ZWNJ U+200C. */
const ZWNJ_WORD = 'دسته‌بندی';
/** «دسته بندی» with a plain space. DIFFERENT by decision. */
const SPACED_WORD = 'دسته بندی';

const RED = 'قرمز'; // «قرمز»
const COLOUR = 'رنگ'; // «رنگ»
const LINING_COLOUR = 'رنگ آستر'; // «رنگ آستر»

interface StatusBody {
  status: number;
  body: { error?: string; message?: string | string[] };
}

describe('catalogue uniqueness is enforced by PostgreSQL, not only by the service', () => {
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

  // =========================================================================
  // Helpers
  // =========================================================================

  const client = () => withCookies(app, admin);

  const createCategory = (title: string) =>
    client().post('/categories').send({ title });

  const renameCategory = (id: number, title: string) =>
    client().patch(`/categories/${id}`).send({ title });

  const createAttribute = (name: string, values: string[]) =>
    client().post('/attributes').send({ name, values });

  const addValues = (attributeId: number, values: string[]) =>
    client().post(`/attributes/${attributeId}/values`).send({ values });

  async function categoryCount(title?: string): Promise<number> {
    const rows = await app.dataSource.query<Array<{ count: string }>>(
      title === undefined
        ? `SELECT COUNT(*) AS count FROM "categories"`
        : `SELECT COUNT(*) AS count FROM "categories"
             WHERE "catalogue_norm"("title") = "catalogue_norm"($1)`,
      title === undefined ? undefined : [title],
    );
    return Number(rows[0].count);
  }

  /**
   * Fires both requests and settles them together.
   *
   * They are dispatched in ONE tick — `Promise.all` subscribes to both
   * thenables synchronously, so neither has been awaited before the other
   * starts. Failures are captured rather than thrown so that a 500 is reported
   * as "expected 409, got 500" instead of as an unhandled rejection.
   */
  async function bothAtOnce(
    a: PromiseLike<{ status: number; body: unknown }>,
    b: PromiseLike<{ status: number; body: unknown }>,
  ): Promise<StatusBody[]> {
    const results = await Promise.all([a, b]);
    return results as unknown as StatusBody[];
  }

  /** Asserts "exactly one winner and one 409 carrying `code`". */
  function expectOneWinnerOneConflict(
    responses: StatusBody[],
    successStatus: number,
    code: string,
  ): void {
    const statuses = responses.map((r) => r.status).sort((x, y) => x - y);
    expect(statuses).toEqual([successStatus, 409].sort((x, y) => x - y));

    const conflict = responses.find((r) => r.status === 409)!;
    // The DB backstop and the application probe answer with the SAME stable
    // code, so a client cannot tell which one fired — which is the point.
    expect(conflict.body.error).toBe(code);
    // And the sentence is the Persian one a store manager can act on, not a
    // driver string mentioning an index.
    expect(String(conflict.body.message)).toMatch(/[؀-ۿ]/);
    expect(String(conflict.body.message)).not.toMatch(
      /uq_|23505|duplicate key/,
    );
  }

  // =========================================================================
  // 1. Two CONCURRENT identical creates
  // =========================================================================
  describe('concurrent creates', () => {
    it('answers exactly one 201 and one 409, and leaves exactly one row', async () => {
      const responses = await bothAtOnce(
        createCategory(PERSIAN_BAG),
        createCategory(PERSIAN_BAG),
      );

      expectOneWinnerOneConflict(responses, 201, 'CATEGORY_TITLE_TAKEN');
      // THE ASSERTION THAT MATTERS: the database, not the status codes.
      expect(await categoryCount()).toBe(1);
    });

    it('does the same for attribute names', async () => {
      const responses = await bothAtOnce(
        createAttribute(COLOUR, [RED]),
        createAttribute(COLOUR, ['آبی']), // «آبی»
      );

      expectOneWinnerOneConflict(responses, 201, 'ATTRIBUTE_ALREADY_EXISTS');

      const rows = await app.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "product_attribute"`,
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    it('does the same for two values added to ONE attribute', async () => {
      const created = await createAttribute(COLOUR, ['آبی']);
      const attributeId = Number(created.body.data.id);

      const responses = await bothAtOnce(
        addValues(attributeId, [RED]),
        addValues(attributeId, [RED]),
      );

      expectOneWinnerOneConflict(
        responses,
        201,
        'ATTRIBUTE_VALUE_ALREADY_EXISTS',
      );

      const rows = await app.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "product_attribute_value"
           WHERE "attributeId" = $1 AND "catalogue_norm"("value") = "catalogue_norm"($2)`,
        [attributeId, RED],
      );
      expect(Number(rows[0].count)).toBe(1);
    });
  });

  // =========================================================================
  // 2. Concurrent RENAMES — the path a "create-only" fix would have missed
  // =========================================================================
  describe('concurrent renames', () => {
    it('lets exactly one of two categories take a contested new title', async () => {
      const first = await createCategory('الف'); // «الف»
      const second = await createCategory('ب'); // «ب»
      const contested = 'مشترک'; // «مشترک»

      const responses = await bothAtOnce(
        renameCategory(Number(first.body.data.id), contested),
        renameCategory(Number(second.body.data.id), contested),
      );

      expectOneWinnerOneConflict(responses, 200, 'CATEGORY_TITLE_TAKEN');
      expect(await categoryCount(contested)).toBe(1);
      // Nothing was lost: the loser keeps the title it had.
      expect(await categoryCount()).toBe(2);
    });

    it('lets exactly one of two attributes take a contested new name', async () => {
      const first = await createAttribute(COLOUR, [RED]);
      const second = await createAttribute('سایز', ['L']); // «سایز»
      const contested = 'مشترک';

      const responses = await bothAtOnce(
        client()
          .patch(`/attributes/${Number(first.body.data.id)}`)
          .send({ name: contested }),
        client()
          .patch(`/attributes/${Number(second.body.data.id)}`)
          .send({ name: contested }),
      );

      expectOneWinnerOneConflict(responses, 200, 'ATTRIBUTE_ALREADY_EXISTS');
    });

    it('lets exactly one of two values of ONE attribute take a contested text', async () => {
      const created = await createAttribute(COLOUR, [
        'آبی', // «آبی»
        'سبز', // «سبز»
      ]);
      const attributeId = Number(created.body.data.id);
      const values = await app.dataSource.query<Array<{ id: number }>>(
        `SELECT "id" FROM "product_attribute_value"
           WHERE "attributeId" = $1 ORDER BY "id"`,
        [attributeId],
      );

      const responses = await bothAtOnce(
        client()
          .patch(`/attributes/values/${values[0].id}`)
          .send({ value: RED }),
        client()
          .patch(`/attributes/values/${values[1].id}`)
          .send({ value: RED }),
      );

      expectOneWinnerOneConflict(
        responses,
        200,
        'ATTRIBUTE_VALUE_ALREADY_EXISTS',
      );
    });
  });

  // =========================================================================
  // 3. Case-only differences
  // =========================================================================
  describe('case folding', () => {
    it('refuses a category whose title differs only in case', async () => {
      await createCategory('Mobile').expect(201);

      const response = await createCategory('mobile');
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('CATEGORY_TITLE_TAKEN');
      expect(await categoryCount()).toBe(1);
    });

    it('refuses an attribute whose name differs only in case', async () => {
      await createAttribute('Colour', ['red']).expect(201);

      const response = await createAttribute('COLOUR', ['blue']);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ATTRIBUTE_ALREADY_EXISTS');
    });

    it('refuses a value that differs only in case WITHIN one attribute', async () => {
      const created = await createAttribute('Colour', ['Red']);
      const response = await addValues(Number(created.body.data.id), ['RED']);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ATTRIBUTE_VALUE_ALREADY_EXISTS');
    });
  });

  // =========================================================================
  // 4. Blank and whitespace-only
  // =========================================================================
  describe('blank names', () => {
    it.each([
      ['empty string', ''],
      ['spaces', '   '],
      ['a tab', '\t'],
      ['a newline', '\n'],
      ['a non-breaking space', ' '],
    ])('refuses a category title that is only %s', async (_label, title) => {
      const response = await createCategory(title);
      // 400 from the ValidationPipe: the DTO trims BEFORE `@IsNotEmpty`, so a
      // whitespace-only title never reaches the service. The CHECK constraint
      // `ck_categories_title_not_blank` says the same thing independently.
      expect(response.status).toBe(400);
      expect(await categoryCount()).toBe(0);
    });

    it('refuses a RENAME to whitespace', async () => {
      const created = await createCategory(PERSIAN_BAG);
      const response = await renameCategory(
        Number(created.body.data.id),
        '   ',
      );

      expect(response.status).toBe(400);
      // The row still says what it said.
      const rows = await app.dataSource.query<Array<{ title: string }>>(
        `SELECT "title" FROM "categories"`,
      );
      expect(rows[0].title).toBe(PERSIAN_BAG);
    });

    it('refuses a blank attribute name and a blank value', async () => {
      await createAttribute('   ', [RED]).expect(400);
      await createAttribute(COLOUR, ['  ']).expect(400);
    });

    it('stores the TRIMMED title, so " x " and "x" are one category', async () => {
      const created = await createCategory(`  ${PERSIAN_BAG}  `);
      expect(created.status).toBe(201);
      expect(created.body.data.title).toBe(PERSIAN_BAG);

      const second = await createCategory(PERSIAN_BAG);
      expect(second.status).toBe(409);
      expect(await categoryCount()).toBe(1);
    });

    it('makes a blank title unrepresentable even from raw SQL', async () => {
      // The CHECK constraint, not the DTO. This is what protects a seeder, a
      // console session or a future endpoint that forgets to validate.
      await expect(
        app.dataSource.query(
          `INSERT INTO "categories" ("title") VALUES ('  ')`,
        ),
      ).rejects.toThrow(/ck_categories_title_not_blank/);
    });
  });

  // =========================================================================
  // 5. THE PERSIAN/ARABIC NORMALISATION DECISION
  // =========================================================================
  describe('Persian/Arabic look-alike folding (ک/ك and ی/ي ARE folded)', () => {
    it('refuses «كيف» once «کیف» exists — they are the same name', async () => {
      // Sanity: these really are different strings. If this ever fails, the
      // file has been normalised by an editor and the rest proves nothing.
      expect(PERSIAN_BAG).not.toBe(ARABIC_BAG);

      await createCategory(PERSIAN_BAG).expect(201);

      const response = await createCategory(ARABIC_BAG);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('CATEGORY_TITLE_TAKEN');
      expect(await categoryCount()).toBe(1);
    });

    it('folds in the other direction too, and on the rename path', async () => {
      await createCategory(ARABIC_BAG).expect(201);
      const other = await createCategory('دیگر'); // «دیگر»

      expect((await createCategory(PERSIAN_BAG)).status).toBe(409);
      expect(
        (await renameCategory(Number(other.body.data.id), PERSIAN_BAG)).status,
      ).toBe(409);
    });

    it('folds attribute names and per-attribute values as well', async () => {
      await createAttribute(PERSIAN_BAG, [RED]).expect(201);
      expect((await createAttribute(ARABIC_BAG, ['x'])).status).toBe(409);

      const attribute = await createAttribute(COLOUR, [PERSIAN_BAG]);
      const response = await addValues(Number(attribute.body.data.id), [
        ARABIC_BAG,
      ]);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ATTRIBUTE_VALUE_ALREADY_EXISTS');
    });

    it('collapses both spellings inside ONE payload instead of failing', async () => {
      // Submitting both used to insert one row and then hit 23505 on the
      // other, failing an otherwise sensible request with a 500.
      const created = await createAttribute(COLOUR, [PERSIAN_BAG, ARABIC_BAG]);
      expect(created.status).toBe(201);

      const rows = await app.dataSource.query<Array<{ value: string }>>(
        `SELECT "value" FROM "product_attribute_value" WHERE "attributeId" = $1`,
        [Number(created.body.data.id)],
      );
      expect(rows).toHaveLength(1);
      // The FIRST spelling submitted is kept — the payload order is the only
      // signal about which form the admin meant.
      expect(rows[0].value).toBe(PERSIAN_BAG);
    });

    it('does NOT fold ZWNJ: «دسته‌بندی» and «دسته بندی» coexist, by decision', async () => {
      // Documented in the migration header: collapsing the half-space would
      // mean choosing between deleting it and turning it into a space, and
      // those choices disagree on real Persian words. Half-space usage is
      // editorial, not an identity question.
      expect(ZWNJ_WORD).not.toBe(SPACED_WORD);

      await createCategory(ZWNJ_WORD).expect(201);
      await createCategory(SPACED_WORD).expect(201);
      expect(await categoryCount()).toBe(2);
    });
  });

  // =========================================================================
  // 6. SCOPE: values are unique WITHIN an attribute, never globally
  // =========================================================================
  describe('attribute value scope', () => {
    it('lets «قرمز» belong to «رنگ» and to «رنگ آستر» at the same time', async () => {
      const colour = await createAttribute(COLOUR, [RED]);
      expect(colour.status).toBe(201);

      // THE CASE THE OLD GLOBAL CHECK GOT WRONG: this used to be a 400.
      const lining = await createAttribute(LINING_COLOUR, [RED]);
      expect(lining.status).toBe(201);

      // And adding it to a third axis afterwards is fine too.
      const size = await createAttribute('سایز', ['L']);
      expect((await addValues(Number(size.body.data.id), [RED])).status).toBe(
        201,
      );

      const rows = await app.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "product_attribute_value"
           WHERE "catalogue_norm"("value") = "catalogue_norm"($1)`,
        [RED],
      );
      expect(Number(rows[0].count)).toBe(3);
    });

    it('still refuses the second «قرمز» on the SAME attribute', async () => {
      const colour = await createAttribute(COLOUR, [RED]);
      const response = await addValues(Number(colour.body.data.id), [RED]);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ATTRIBUTE_VALUE_ALREADY_EXISTS');
    });
  });

  // =========================================================================
  // THE PROOF THE RACE IS ACTUALLY SHUT — two real connections, no app code
  // =========================================================================
  describe('the unique indexes themselves (two interleaved connections)', () => {
    const config = testDbConfig();
    let a: PgClientLike;
    let b: PgClientLike;

    beforeEach(async () => {
      a = new PgClient({ ...config, user: config.username });
      b = new PgClient({ ...config, user: config.username });
      await a.connect();
      await b.connect();
    });

    afterEach(async () => {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
    });

    /**
     * The interleaving that no `Promise.all` can guarantee.
     *
     * B's INSERT is issued while A's is still uncommitted, so PostgreSQL
     * BLOCKS it on the index's row lock instead of failing it. Only when A
     * commits can B proceed — and then it must fail 23505. If the index did
     * not exist, B's INSERT would return immediately and this returns null.
     */
    async function secondInsertLosesTo(
      insertSql: string,
      values: unknown[],
    ): Promise<{ code: string; constraint: string }> {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await a.query(insertSql, values);

      // NOT awaited yet: it must still be in flight when A commits.
      const blocked = b.query(insertSql, values).then(
        () => null,
        (error: { code?: string; constraint?: string }) => ({
          code: error.code ?? '',
          constraint: error.constraint ?? '',
        }),
      );

      // Give B a moment to reach the lock, then let A win.
      await new Promise((resolve) => setImmediate(resolve));
      await a.query('COMMIT');

      const outcome = await blocked;
      expect(outcome).not.toBeNull();
      return outcome!;
    }

    it('refuses a second category title through a second connection', async () => {
      const outcome = await secondInsertLosesTo(
        `INSERT INTO "categories" ("title") VALUES ($1)`,
        [PERSIAN_BAG],
      );

      expect(outcome.code).toBe('23505');
      expect(outcome.constraint).toBe('uq_categories_title_norm');
      expect(await categoryCount()).toBe(1);
    });

    it('refuses the ARABIC spelling from a second connection once the PERSIAN one is committed', async () => {
      // The fold is in the INDEX, not merely in the service: two different
      // byte strings, one index entry.
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`INSERT INTO "categories" ("title") VALUES ($1)`, [
        PERSIAN_BAG,
      ]);

      const blocked = b
        .query(`INSERT INTO "categories" ("title") VALUES ($1)`, [ARABIC_BAG])
        .then(
          () => null,
          (error: { code?: string; constraint?: string }) => error,
        );

      await new Promise((resolve) => setImmediate(resolve));
      await a.query('COMMIT');

      const error = (await blocked) as { code?: string; constraint?: string };
      expect(error).not.toBeNull();
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('uq_categories_title_norm');
    });

    it('refuses a second attribute name through a second connection', async () => {
      const outcome = await secondInsertLosesTo(
        `INSERT INTO "product_attribute" ("name") VALUES ($1)`,
        [COLOUR],
      );
      expect(outcome.code).toBe('23505');
      // Either the baseline exact-match UNIQUE or the normalised index may be
      // the one PostgreSQL checks first; both are mapped to the same 409.
      expect([
        'uq_product_attribute_name_norm',
        'UQ_05d080e931ec850c1e0219ee111',
      ]).toContain(outcome.constraint);
    });

    it('refuses a second value on ONE attribute, and allows it on another', async () => {
      const [{ id: colourId }] = await app.dataSource.query<
        Array<{ id: number }>
      >(`INSERT INTO "product_attribute" ("name") VALUES ($1) RETURNING id`, [
        COLOUR,
      ]);
      const [{ id: liningId }] = await app.dataSource.query<
        Array<{ id: number }>
      >(`INSERT INTO "product_attribute" ("name") VALUES ($1) RETURNING id`, [
        LINING_COLOUR,
      ]);

      const outcome = await secondInsertLosesTo(
        `INSERT INTO "product_attribute_value" ("value", "attributeId") VALUES ($1, $2)`,
        [RED, colourId],
      );
      expect(outcome.code).toBe('23505');
      expect(outcome.constraint).toBe(
        'uq_product_attribute_value_per_attribute_norm',
      );

      // SCOPE, at the index: the same word under a DIFFERENT attribute lands.
      await app.dataSource.query(
        `INSERT INTO "product_attribute_value" ("value", "attributeId") VALUES ($1, $2)`,
        [RED, liningId],
      );
      const rows = await app.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "product_attribute_value"`,
      );
      expect(Number(rows[0].count)).toBe(2);
    });
  });
});

// ===========================================================================
// 7. THE MIGRATION'S OWN GUARD, on a throwaway database that HAS duplicates
// ===========================================================================
/**
 * Modelled on `variant-backfill-migration.int-spec.ts`: the schema is built in
 * two stages so the bad data genuinely predates the migration under test.
 *
 * This is the case nobody can test on the main harness database, because the
 * harness database is clean by construction — and it is the case that decides
 * whether a real deployment fails safely or corrupts a live catalogue.
 */
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'src', 'migrations');
/** The last migration BEFORE the one under test. */
const BEFORE_TIMESTAMP = 1757000000024;
/** The one under test. */
const HEAD_TIMESTAMP = 1757000000025;

function migrationFilesUpTo(upTo: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => Number(f.split('-')[0]) <= upTo)
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

describe('migration 0025 refuses to run on a catalogue that already has duplicates', () => {
  const DB_NAME = scratchDatabaseName('catalogue_uniqueness');

  async function openAt(upTo: number): Promise<DataSource> {
    const ds = new DataSource({
      ...testDataSourceOptions(),
      database: DB_NAME,
      migrations: migrationFilesUpTo(upTo),
    } as never);
    await ds.initialize();
    return ds;
  }

  /**
   * Builds the pre-0025 schema, plants `rows`, then tries to apply 0025 and
   * returns whatever it threw (or null if it unexpectedly succeeded).
   */
  async function attempt(
    plant: (ds: DataSource) => Promise<void>,
    verify?: (ds: DataSource) => Promise<void>,
  ): Promise<Error | null> {
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();

    const before = await openAt(BEFORE_TIMESTAMP);
    await before.runMigrations({ transaction: 'all' });
    await plant(before);
    await before.destroy();

    const head = await openAt(HEAD_TIMESTAMP);
    let thrown: Error | null = null;
    try {
      await head.runMigrations({ transaction: 'all' });
    } catch (error) {
      thrown = error as Error;
    }

    // Whether it threw or not, the catalogue must be untouched: this migration
    // never renames, merges or deletes a row to make itself applicable.
    if (thrown) {
      const applied = await head.query<Array<{ name: string }>>(
        `SELECT name FROM migrations WHERE name = $1`,
        ['CatalogueUniqueness1757000000025'],
      );
      expect(applied).toHaveLength(0);
    }
    if (verify) await verify(head);
    await head.destroy();

    const cleaner = new PgClient({ ...config, user: config.username });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await cleaner.end();

    return thrown;
  }

  it('fails LOUDLY on duplicate category titles, naming the colliding rows', async () => {
    const thrown = await attempt(async (ds) => {
      await ds.query(
        `INSERT INTO "categories" ("title") VALUES ($1), ($2), ($3)`,
        [PERSIAN_BAG, ARABIC_BAG, 'کیف '], // «کیف», «كيف», «کیف »
      );
    });

    expect(thrown).not.toBeNull();
    const message = thrown!.message;

    // An operator has to be able to act on this without reading the migration.
    expect(message).toContain('REFUSES TO RUN');
    expect(message).toContain('categories.title');
    expect(message).toContain('unique GLOBALLY');
    // The colliding rows are listed BY ID, all three of them, including the
    // two that only collide because of the ک/ی fold and the trim.
    expect(message).toMatch(/#1\b/);
    expect(message).toMatch(/#2\b/);
    expect(message).toMatch(/#3\b/);
    expect(message).toContain('FIX BY HAND');
    // And it says what it will NOT do, so nobody goes looking for the repair.
    expect(message).toContain('NEVER merges, renames or deletes');
  });

  it('fails on duplicate attribute names', async () => {
    const thrown = await attempt(async (ds) => {
      // The baseline UNIQUE(name) is exact-match, so these two coexist today
      // and ONLY the normalised index would reject them.
      await ds.query(
        `INSERT INTO "product_attribute" ("name") VALUES ($1), ($2)`,
        [PERSIAN_BAG, ARABIC_BAG],
      );
    });

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('product_attribute.name');
    expect(thrown!.message).toContain('REFUSES TO RUN');
  });

  it('fails on duplicate values WITHIN one attribute, and not across attributes', async () => {
    const thrown = await attempt(async (ds) => {
      const [{ id: colourId }] = await ds.query<Array<{ id: number }>>(
        `INSERT INTO "product_attribute" ("name") VALUES ($1) RETURNING id`,
        [COLOUR],
      );
      const [{ id: liningId }] = await ds.query<Array<{ id: number }>>(
        `INSERT INTO "product_attribute" ("name") VALUES ($1) RETURNING id`,
        [LINING_COLOUR],
      );
      await ds.query(
        `INSERT INTO "product_attribute_value" ("value", "attributeId")
         VALUES ($1, $2), ($3, $2), ($4, $5)`,
        [RED, colourId, ` ${RED}`, RED, liningId],
      );
    });

    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    expect(message).toContain('WITHIN ONE ATTRIBUTE');
    // ONE group only: the «قرمز» under the other attribute is NOT a collision.
    expect(message).toContain('1 duplicate group(s) covering 2 rows');
  });

  it('fails on a blank title rather than silently deleting or renaming it', async () => {
    const thrown = await attempt(async (ds) => {
      await ds.query(`INSERT INTO "categories" ("title") VALUES ($1), ($2)`, [
        '   ',
        'کیف',
      ]);
    });

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('blank category titles');
    expect(thrown!.message).toContain('FIX BY HAND');
  });

  it('APPLIES CLEANLY once the catalogue is clean, trimming as it goes', async () => {
    // The positive control. Without it, "the guard fires" would be satisfied
    // by a migration that always throws.
    const thrown = await attempt(
      async (ds) => {
        await ds.query(`INSERT INTO "categories" ("title") VALUES ($1), ($2)`, [
          `  ${PERSIAN_BAG}  `, // untrimmed, but unique — safe to repair
          'دیگر', // «دیگر»
        ]);
      },
      async (ds) => {
        // THE ONE WRITE THE MIGRATION MAKES: invisible edge whitespace is
        // stripped. Nothing a catalogue displays is lost, and the row keeps
        // its id, so every `product_category` link survives untouched.
        const rows = await ds.query<Array<{ title: string }>>(
          `SELECT "title" FROM "categories" ORDER BY "id"`,
        );
        expect(rows.map((r) => r.title)).toEqual([PERSIAN_BAG, 'دیگر']);

        // And the constraint really is installed afterwards.
        const indexes = await ds.query<Array<{ indexname: string }>>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND indexname LIKE 'uq_%norm'
            ORDER BY indexname`,
        );
        expect(indexes.map((r) => r.indexname)).toEqual([
          'uq_categories_title_norm',
          'uq_product_attribute_name_norm',
          'uq_product_attribute_value_per_attribute_norm',
        ]);
      },
    );

    expect(thrown).toBeNull();
  });
});

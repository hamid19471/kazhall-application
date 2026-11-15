import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0026 — `orders."orderNumber"` becomes `character varying(40)`, which is what
 * the entity has always said it was.
 *
 * ---------------------------------------------------------------------------
 * THE MISMATCH THIS CLOSES
 *
 * Migration 0003 added the column as:
 *
 *     ALTER TABLE "orders" ADD "orderNumber" character varying
 *
 * — UNBOUNDED — while `Order.orderNumber` has always been declared
 * `@Column({ type: 'varchar', length: 40, unique: true, nullable: true })`.
 * Nothing ever failed, because no generated value has come close to 40
 * characters, so the disagreement was invisible in behaviour and permanent in
 * `typeorm schema:log`, which proposed this same ALTER on every single run.
 * That is the real cost: a schema-log that is never empty is a schema-log
 * nobody reads, and the next genuinely-pending change hides in it.
 *
 * MIGRATION 0003 IS NOT EDITED. It is committed and has been applied to real
 * databases; rewriting it would make the recorded history disagree with what
 * those databases actually ran, and would do nothing at all for a database
 * that already has the column. A forward migration is the only honest fix.
 *
 * ---------------------------------------------------------------------------
 * WHY `up()` MEASURES BEFORE IT ALTERS
 *
 * `ALTER COLUMN ... TYPE character varying(40)` on data that does not fit
 * fails with PostgreSQL's own `22001 value too long for type character
 * varying(40)`, which names neither the table, the row, nor the length that
 * was actually found. Worse, the obvious "fix" a person reaches for under
 * deployment pressure is `USING left("orderNumber", 40)` — which silently
 * TRUNCATES a number printed on a customer's receipt, and can collide two
 * distinct orders into one value that the UNIQUE constraint then rejects at
 * random.
 *
 * So the migration asks the question first and refuses with a sentence that
 * states the longest value found, the target, and how many rows exceed it. A
 * refusal here is a transaction that rolls back having changed nothing; there
 * is no half-applied state to recover from.
 *
 * THE LIMIT IS NEVER REACHABLE BY THE GENERATOR. `buildOrderNumber` produces
 * `<POS|WEB>-<yyyyMMdd>-<id padded to 6>`: 13 fixed characters plus the id,
 * so 19 characters until `orders.id` passes 999 999 and 23 at the `int4`
 * maximum of 2 147 483 647. Only a hand-written value could exceed 40, which
 * is exactly the case worth checking for rather than assuming away.
 *
 * ---------------------------------------------------------------------------
 * THE UNIQUE CONSTRAINT AND EVERY REFERENCE SURVIVE
 *
 * `uq_orders_order_number` (migration 0003) is a UNIQUE CONSTRAINT with an
 * implicit index. `ALTER COLUMN ... TYPE` does not drop either: PostgreSQL
 * rebuilds dependent indexes and revalidates dependent constraints as part of
 * the same statement. Dropping and recreating it by hand would open a window
 * in which two duplicate order numbers could be inserted, so it is
 * deliberately left alone — and `assertConstraintIntact` below re-reads
 * `pg_constraint` afterwards rather than trusting that paragraph.
 *
 * `orders.orderNumber` is referenced by no foreign key — it is not a key, by
 * design (see the entity's comment) — so no other table's rows can be
 * invalidated by this change. Order references elsewhere are all by
 * `orders.id`.
 *
 * ---------------------------------------------------------------------------
 * `down()` WIDENS BACK, WHICH ALWAYS SUCCEEDS
 *
 * `varchar(40) -> varchar` is a widening: every existing value already fits,
 * PostgreSQL performs it without a table rewrite, and no data can be lost. The
 * reverse direction is the one that needs a guard, which is why the guard is
 * in `up()` and not here.
 */
export class OrderNumberLength1757000000026 implements MigrationInterface {
  name = 'OrderNumberLength1757000000026';

  /** Kept in step with `ORDER_NUMBER_MAX_LENGTH` in src/modules/orders/order-number.ts. */
  private static readonly TARGET_LENGTH = 40;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const target = OrderNumberLength1757000000026.TARGET_LENGTH;

    // ---- 1. MEASURE. Ask the data, do not assume it. ----------------------
    const measured = (await queryRunner.query(
      `SELECT MAX(char_length("orderNumber"))            AS longest,
              COUNT(*) FILTER (
                WHERE char_length("orderNumber") > $1)   AS over,
              COUNT("orderNumber")                       AS total
         FROM "orders"`,
      [target],
    )) as Array<{ longest: number | null; over: string; total: string }>;
    const row = measured[0];
    // `COUNT` comes back from node-postgres as a string; it is compared as a
    // string rather than parsed, because the only question asked of it is
    // whether it is zero.
    const over = row?.over ?? '0';

    if (over !== '0') {
      const longest = row?.longest ?? 0;
      throw new Error(
        `REFUSING TO ALTER orders."orderNumber".\n` +
          `${over} of ${row?.total ?? '0'} non-null order numbers are longer than ` +
          `${target} characters; the longest is ${longest}.\n` +
          `This migration will not truncate a number that is printed on a customer's ` +
          `receipt, and truncation could also collide two distinct orders onto one ` +
          `value that uq_orders_order_number would then reject.\n` +
          `Decide what those rows should say, correct them, and run the migration again:\n` +
          `  SELECT id, "orderNumber", char_length("orderNumber") AS len\n` +
          `    FROM orders WHERE char_length("orderNumber") > ${target}\n` +
          `   ORDER BY len DESC;`,
      );
    }

    // ---- 2. ALTER. Every value fits, so this cannot lose data. ------------
    await queryRunner.query(
      `ALTER TABLE "orders"
         ALTER COLUMN "orderNumber" TYPE character varying(${target})`,
    );

    // ---- 3. VERIFY the constraint is still there. -------------------------
    await OrderNumberLength1757000000026.assertConstraintIntact(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Widening back to the unbounded type migration 0003 created. Always
    // succeeds: every stored value already satisfies the wider type.
    await queryRunner.query(
      `ALTER TABLE "orders"
         ALTER COLUMN "orderNumber" TYPE character varying`,
    );

    // The same check in the other direction: a revert that silently dropped
    // the uniqueness of a receipt number would be worse than no revert at all.
    await OrderNumberLength1757000000026.assertConstraintIntact(queryRunner);
  }

  /**
   * Re-reads `pg_constraint` for the UNIQUE constraint on `orderNumber`.
   *
   * `ALTER COLUMN ... TYPE` is documented to rebuild dependent indexes and
   * constraints, and it does — but "documented to" is not "verified in this
   * database", and losing the uniqueness of a receipt number is the one
   * failure of this migration that would be discovered by a customer rather
   * than by a test.
   */
  private static async assertConstraintIntact(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const found = (await queryRunner.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'orders'
          AND c.contype = 'u'
          AND c.conkey = ARRAY[
                (SELECT a.attnum FROM pg_attribute a
                  WHERE a.attrelid = t.oid AND a.attname = 'orderNumber')
              ]::smallint[]`,
    )) as Array<{ conname: string }>;

    if (found.length === 0) {
      throw new Error(
        `orders."orderNumber" lost its UNIQUE constraint while its type was ` +
          `being altered. The receipt number must stay unique; refusing to ` +
          `leave the schema in this state.`,
      );
    }
  }
}

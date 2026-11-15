import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0029 — closes the three pieces of REAL schema drift that `typeorm schema:log`
 * has been proposing on every run: a nullable `payment."orderId"`, and three
 * indexes that only ever existed in entity metadata.
 *
 * ---------------------------------------------------------------------------
 * 1. `payment."orderId"` — NULLABLE IN THE DATABASE, REQUIRED EVERYWHERE ELSE
 *
 * `Payment.orderId` is declared `@Column({ type: 'int' })` — non-optional — and
 * every read treats it as present: the reconciliation query in the entity
 * header does `JOIN orders o ON o.id = p."orderId"`, and
 * `uq_payment_one_success_per_order` is a UNIQUE index on `("orderId") WHERE
 * status = 'success'`. That partial unique index is the ONLY structural reason
 * two attempts for one order cannot both settle it — and in PostgreSQL, NULLs
 * are never equal to each other, so an unbounded number of `orderId IS NULL`
 * rows can hold `status = 'success'` simultaneously without tripping it. A
 * single stray NULL therefore turns the guarantee off for that row rather than
 * raising 23505, and `ReconciliationService` never sees the receipt because
 * the operator query's inner JOIN drops it. The column became nullable by
 * accident: 0001 created it as TypeORM's `synchronize` did (`"orderId" integer`
 * from the relation, not from the explicit `@Column`), and nothing since
 * tightened it.
 *
 * GUARDED, NOT OPTIMISTIC. `SET NOT NULL` against a table that does hold NULLs
 * fails with `column "orderId" contains null values` — a message that names
 * neither how many rows nor what to do about them, on a deploy that has already
 * started. The explicit pre-check below raises with the COUNT, so the operator
 * learns the size of the problem from the failure itself. Those rows are real
 * money with no order attached; deciding where each belongs is reconciliation
 * work, not something a migration may guess, so this refuses rather than
 * deleting or back-filling them.
 *
 * ---------------------------------------------------------------------------
 * 2/3. THREE INDEXES THAT WERE ONLY EVER DECLARED
 *
 * `OrderItems` has carried `@Index('idx_order_item_order', ['orderId'])` and
 * `@Index('idx_order_item_variant', ['variantId'])` since it was written, and
 * `Order` has carried an index on `soldAt` alone. None of the three was ever
 * created by a migration, so `order_items` had NO index but its primary key:
 * every receipt render, every `/reports/sales/:id` detail, and every
 * `ON DELETE CASCADE` from `orders` was a sequential scan of the whole line
 * table, and the cascade cost grows with total sales history rather than with
 * the order being deleted.
 *
 * `idx_orders_sold_at` is not redundant against the composites migration 0003
 * created: those lead with `status`, `branchId` and `cashierUserId`, and a
 * btree cannot serve a range on its SECOND column without an equality on the
 * first. Every unfiltered report range (`/reports/sales`, the admin order list
 * ordered by `soldAt DESC`) has no such equality.
 *
 * NAMING. `idx_orders_sold_at`, not the entity's former `idx_order_sold_at`:
 * migration 0003 already established `idx_orders_*` for this table and 0003 is
 * deployed. The entity decorators were corrected to match, which is the
 * direction this project's index comments already state ("Index names match
 * migrations 0007 / 0010 exactly").
 *
 * NOT `CONCURRENTLY`. A migration runs inside a transaction and
 * `CREATE INDEX CONCURRENTLY` cannot; making it concurrent would mean giving up
 * the all-or-nothing property of the whole migration. These tables are small
 * enough that the write lock is short, and the operator alternative — build the
 * index by hand, then run the migration — stays available.
 */
export class PaymentOrderIdNotNullAndOrderIndexes1757000000029 implements MigrationInterface {
  name = 'PaymentOrderIdNotNullAndOrderIndexes1757000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fails BEFORE any DDL, naming the row count, so the deploy log says how
    // big the reconciliation job is instead of "contains null values".
    await queryRunner.query(`
      DO $do$
      DECLARE
        orphaned bigint;
      BEGIN
        SELECT count(*) INTO orphaned FROM "payment" WHERE "orderId" IS NULL;
        IF orphaned > 0 THEN
          RAISE EXCEPTION
            'migration 0029 refused: % payment row(s) have a NULL "orderId" and cannot be attached to an order by a migration. Resolve them first: SELECT id, track_id, ref_number, amount, status, paid_at FROM payment WHERE "orderId" IS NULL ORDER BY id;',
            orphaned
            USING ERRCODE = '23502';
        END IF;
      END
      $do$;
    `);

    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "orderId" SET NOT NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_order_item_order" ON "order_items" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_item_variant" ON "order_items" ("variantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_sold_at" ON "orders" ("soldAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_orders_sold_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_item_variant"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_item_order"`);

    // Widening a column back to nullable never fails and loses no row, so the
    // revert is total: the database is byte-identical to its pre-0029 shape.
    // What a revert DOES restore is the defect described above — the partial
    // unique index stops constraining any row whose `orderId` is NULL again —
    // so reverting this is only safe alongside reverting the application code
    // that now relies on `Payment.orderId` being present.
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "orderId" DROP NOT NULL`,
    );
  }
}

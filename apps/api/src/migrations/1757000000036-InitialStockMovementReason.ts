import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0036 — `initial_stock`, so a product born with units says where they came
 * from.
 *
 * WHY A NEW REASON RATHER THAN `manual_adjustment`
 * ------------------------------------------------
 * A simple product created with an opening quantity now writes a real ledger
 * movement instead of assigning `stock` directly. That movement has to be
 * honest about what it is.
 *
 * `manual_adjustment` means "a person looked at the shelf and corrected the
 * number", and its rows are what a stock-take audit reads. Filing an opening
 * balance under it would put a correction on the ledger that never happened,
 * and the first person to ask "who adjusted this?" would find an adjustment
 * nobody made. `initial_stock` is a different fact: it is the quantity the
 * product entered the catalogue with, written once, at creation, by the same
 * transaction that created the variant.
 *
 * It is also the property that makes the rule "all later stock changes go
 * through the adjustment endpoint" checkable — an `initial_stock` row can only
 * exist as a variant's FIRST movement, and anything else is a bug worth
 * finding.
 *
 * ---------------------------------------------------------------------------
 * THE TYPE IS REBUILT, NOT EXTENDED
 * ---------------------------------------------------------------------------
 * Same reasoning as migrations 0010 and 0018, and for the same two reasons:
 *
 *   PostgreSQL forbids using a value added by `ALTER TYPE ... ADD VALUE`
 *   inside the transaction that added it, and this project's harness runs
 *   every migration in ONE transaction (`runMigrations({transaction:'all'})`).
 *
 *   An added value cannot be removed, so `down()` could not be honest. A
 *   rebuild is fully transactional in both directions.
 *
 * Nothing references the column's type — no index and no check constraint
 * (`chk_stock_movement_reason_text_not_blank` tests `reasonText`) — so the swap
 * needs no objects dropped and rebuilt around it.
 *
 * `down()` refuses rather than corrupts: if any row already uses the new value
 * there is no correct way to narrow the type, and silently rewriting those
 * rows to `manual_adjustment` would forge ledger history.
 * ============================================================================
 */

const WITHOUT_INITIAL_STOCK =
  "'pos_sale', 'online_fulfillment', 'cancellation_restore', 'return_restore', 'manual_adjustment'";

const WITH_INITIAL_STOCK = `${WITHOUT_INITIAL_STOCK}, 'initial_stock'`;

export class InitialStockMovementReason1757000000036 implements MigrationInterface {
  name = 'InitialStockMovementReason1757000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."stock_movements_reason_enum"
         RENAME TO "stock_movements_reason_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_reason_enum"
         AS ENUM(${WITH_INITIAL_STOCK})`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ALTER COLUMN "reason" TYPE "public"."stock_movements_reason_enum"
         USING "reason"::text::"public"."stock_movements_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_movements_reason_enum_old"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = (await queryRunner.query(
      `SELECT count(*)::int AS count
         FROM "stock_movements" WHERE "reason" = 'initial_stock'`,
    )) as Array<{ count: number }>;

    if (count > 0) {
      throw new Error(
        `Refusing to revert ${this.name}: ${count} stock movement(s) already ` +
          `carry reason 'initial_stock'. Narrowing the type would require ` +
          `rewriting them as something they are not, which would forge ledger ` +
          `history. Reassign or remove those rows deliberately first.`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "public"."stock_movements_reason_enum"
         RENAME TO "stock_movements_reason_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_reason_enum"
         AS ENUM(${WITHOUT_INITIAL_STOCK})`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ALTER COLUMN "reason" TYPE "public"."stock_movements_reason_enum"
         USING "reason"::text::"public"."stock_movements_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_movements_reason_enum_old"`,
    );
  }
}

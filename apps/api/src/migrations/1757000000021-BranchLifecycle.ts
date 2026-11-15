import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0021 — `branches.isActive`.
 *
 * WHY. A branch could be created and renamed but never retired. The only way
 * to take a closed shop out of the business was `DELETE /branch/:id`, which is
 * a hard delete against a table referenced by `users.branchId` and
 * `orders.branchId` — so it either destroyed the answer to "which shop sold
 * this" or, more often, surfaced the foreign-key restriction as a 500. Neither
 * is a lifecycle.
 *
 * `isActive = false` is the retirement. It is enforced where it matters and
 * nowhere else:
 *
 *   - a cashier whose branch is inactive is refused at `POST /orders/pos`
 *     (`BRANCH_INACTIVE`), because a sale attributes itself to a branch and an
 *     inactive branch is not selling;
 *   - the branch keeps its rows, so every past order still resolves its
 *     `branchId` and every `branchNameSnapshot` stays meaningful;
 *   - staff assignments are NOT cascaded away. Reassigning them is an explicit
 *     administrative act, surfaced by the branch screen, not a silent side
 *     effect of flipping a flag.
 *
 * DEFAULT TRUE so every existing branch keeps working. There is deliberately
 * no `type`/`kind` column: warehouse and retail branches are not distinguished
 * by this schema, and adding a column the application does not act on would be
 * a claim the system cannot honour. See the delivery report.
 */
export class BranchLifecycle1757000000021 implements MigrationInterface {
  name = 'BranchLifecycle1757000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "branches" ADD "isActive" boolean NOT NULL DEFAULT true`,
    );
    // "the branches a till may sell from" is the only hot predicate.
    await queryRunner.query(
      `CREATE INDEX "idx_branches_active" ON "branches" ("isActive")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_branches_active"`,
    );
    await queryRunner.query(`ALTER TABLE "branches" DROP COLUMN "isActive"`);
  }
}

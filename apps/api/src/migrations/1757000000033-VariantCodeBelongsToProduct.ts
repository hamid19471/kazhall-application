import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0033 — A VARIANT CODE MUST BELONG TO ITS CURRENT PARENT, enforced by the
 * database rather than by every writer remembering.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * Migration 0031 gave `products."productCode"` and
 * `product_variants."variantCode"` uniqueness and a format, and the
 * application checked the RELATIONSHIP between them
 * (`assertVariantBelongsToProduct`). But nothing stopped the relationship from
 * being broken AFTER the fact: `PATCH /products/:id` accepted a new product
 * code and left the children alone, so a perfectly ordinary edit produced
 *
 *     product   KZ-P-000010  ->  KZ-P-000020
 *     variant   KZ-P-000010-V000025   (unchanged, now an orphan prefix)
 *
 * and every later read of that variant claimed a parent that no longer exists.
 * The service now cascades the rename, and this migration makes the invariant
 * impossible to violate from ANY path — a direct `psql` UPDATE, a future
 * service method, a bulk import script.
 *
 * ---------------------------------------------------------------------------
 * WHY A TRIGGER AND NOT A CHECK
 * ---------------------------------------------------------------------------
 * The rule spans two tables. A CHECK constraint sees one row of one table, so
 * expressing this as a CHECK would require denormalising the parent's code onto
 * every variant — and then the two copies could disagree, which is a worse
 * failure than the one being prevented.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DEFERRABLE, AND WHY THAT IS NOT A WEAKENING
 * ---------------------------------------------------------------------------
 * Renaming a product is necessarily TWO statements: update the parent, then
 * update the children (or the reverse). Whichever order is chosen, the
 * intermediate state violates the rule. An IMMEDIATE trigger would therefore
 * make the correct operation impossible to perform at all, which is how
 * constraints end up being dropped rather than obeyed.
 *
 * `DEFERRABLE INITIALLY DEFERRED` moves the check to COMMIT. The rule is
 * enforced on every state that is ever DURABLE; only the invisible middle of a
 * transaction is exempt, and nothing outside that transaction can observe it.
 * A session that wants the old behaviour can still `SET CONSTRAINTS ...
 * IMMEDIATE`, but nothing needs to.
 *
 * This mirrors `trg_product_branch_visibility_consistent` from 0030, which is
 * deferrable for exactly the same two-statement reason.
 *
 * ---------------------------------------------------------------------------
 * IT REFUSES TO RUN ON DRIFTED DATA
 * ---------------------------------------------------------------------------
 * Any variant already violating the rule is listed by id, with both codes, and
 * the migration stops. Nothing is auto-repaired: only a human knows whether a
 * mismatched variant should take its parent's prefix or was mis-assigned to the
 * wrong product in the first place, and guessing would write a business
 * identifier nobody chose onto a row that orders may reference.
 *
 * ---------------------------------------------------------------------------
 * ORPHANS ARE OUT OF SCOPE, DELIBERATELY
 * ---------------------------------------------------------------------------
 * `product_variants."productId"` is NULLABLE in the baseline schema. A variant
 * with no parent has no code to be related to, so the trigger skips it rather
 * than inventing a rule for it. Migration 0031 already refuses to run while any
 * such row exists, so this is a gap only a future schema change could reopen.
 * ============================================================================
 */

const FN = 'assert_variant_code_belongs_to_product';
const TRG = 'trg_variant_code_belongs_to_product';

interface DriftRow {
  id: number;
  variantCode: string;
  productId: number;
  productCode: string;
}

export class VariantCodeBelongsToProduct1757000000033 implements MigrationInterface {
  name = 'VariantCodeBelongsToProduct1757000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------------
    // GUARD. Refuse on drift, naming every offending row.
    // -----------------------------------------------------------------------
    const drifted = (await queryRunner.query(
      `SELECT v."id", v."variantCode", p."id" AS "productId", p."productCode"
         FROM "product_variants" v
         JOIN "products" p ON p."id" = v."productId"
        WHERE v."variantCode" NOT LIKE p."productCode" || '-%'
        ORDER BY v."id"`,
    )) as DriftRow[];

    if (drifted.length > 0) {
      const listed = drifted
        .map(
          (row) =>
            `  variant #${row.id} ${JSON.stringify(row.variantCode)} ` +
            `belongs to product #${row.productId} ${JSON.stringify(row.productCode)}`,
        )
        .join('\n');
      throw new Error(
        `${this.name} REFUSES TO RUN.\n` +
          `${drifted.length} variant code(s) do not begin with their product's ` +
          `code followed by a hyphen, so the invariant this migration installs ` +
          `is already false for them.\n${listed}\n` +
          `FIX BY HAND: for each row decide whether the VARIANT code should be ` +
          `re-prefixed onto its parent, or whether the variant is attached to ` +
          `the wrong product. Then run the migration again. This migration ` +
          `deliberately does not rewrite a business identifier for you.`,
      );
    }

    // -----------------------------------------------------------------------
    // The check, written once and called from both directions.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `CREATE FUNCTION "${FN}"() RETURNS trigger
         LANGUAGE plpgsql
       AS $fn$
       DECLARE
         bad_variant   integer;
         bad_code      text;
         parent_code   text;
       BEGIN
         IF TG_TABLE_NAME = 'products' THEN
           SELECT v."id", v."variantCode", NEW."productCode"
             INTO bad_variant, bad_code, parent_code
             FROM "product_variants" v
            WHERE v."productId" = NEW."id"
              AND v."variantCode" NOT LIKE NEW."productCode" || '-%'
            LIMIT 1;
         ELSE
           -- A variant with no parent has nothing to be related to.
           IF NEW."productId" IS NULL THEN
             RETURN NULL;
           END IF;

           SELECT NEW."id", NEW."variantCode", p."productCode"
             INTO bad_variant, bad_code, parent_code
             FROM "products" p
            WHERE p."id" = NEW."productId"
              AND NEW."variantCode" NOT LIKE p."productCode" || '-%'
            LIMIT 1;
         END IF;

         IF bad_variant IS NOT NULL THEN
           RAISE EXCEPTION
             'variant % code % does not belong to product code %',
             bad_variant, bad_code, parent_code
             USING ERRCODE = 'check_violation',
                   CONSTRAINT = '${TRG}';
         END IF;

         RETURN NULL;
       END
       $fn$`,
    );

    /*
     * Two triggers, one function. The `products` side fires only on a code
     * change, so an ordinary title or price edit costs nothing.
     */
    await queryRunner.query(
      `CREATE CONSTRAINT TRIGGER "${TRG}"
         AFTER UPDATE OF "productCode" ON "products"
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
    );

    await queryRunner.query(
      `CREATE CONSTRAINT TRIGGER "${TRG}"
         AFTER INSERT OR UPDATE OF "variantCode", "productId" ON "product_variants"
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
    );
  }

  /**
   * Drops both triggers and the function. No data is touched, so the revert is
   * total: the schema returns byte-identically to its pre-0033 shape.
   *
   * What a revert DOES restore is the ability to write a mismatched pair again,
   * so reverting this is only safe alongside reverting the service code that
   * now relies on the invariant holding.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "${TRG}" ON "product_variants"`);
    await queryRunner.query(`DROP TRIGGER "${TRG}" ON "products"`);
    await queryRunner.query(`DROP FUNCTION "${FN}"()`);
  }
}

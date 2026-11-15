import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import {
  PRODUCT_CODE_SEQUENCE,
  VARIANT_CODE_SEQUENCE,
  assertProductCode,
  formatProductCode,
  formatVariantCode,
} from 'src/common/catalogue/product-codes';

/**
 * ============================================================================
 * CODE ALLOCATION — «تولید خودکار کد».
 *
 * The one place a generated `productCode` or `variantCode` comes from. The
 * Admin form's two "generate" buttons call HTTP endpoints that call this; no
 * final code is ever invented in React.
 *
 * ---------------------------------------------------------------------------
 * WHY A POSTGRESQL SEQUENCE
 * ---------------------------------------------------------------------------
 * `nextval()` is atomic, is NOT serialised behind a row lock, and is correct
 * across any number of API instances. Each of the alternatives the requirement
 * rules out fails in a specific, reachable way:
 *
 *   max(id) + 1            two readers in the same millisecond compute the
 *                          same answer and one of them loses at INSERT;
 *   a timestamp            collides under load and publishes order volume to
 *                          anyone who can read two codes;
 *   an in-process counter  is wrong the moment a second instance boots, which
 *                          is the deployment this is written for.
 *
 * ---------------------------------------------------------------------------
 * GAPS ARE FINE AND ARE NOT CHASED
 * ---------------------------------------------------------------------------
 * `nextval` is deliberately NOT transactional: a rolled-back transaction does
 * not give the number back. So a code generated into the form and never saved
 * is simply never used, and the next one is higher. That is accepted: a code
 * is an identifier, not a count, and nothing reads meaning into the arithmetic
 * between two of them. No reservation table, no expiry sweeper, no
 * "unallocate" endpoint — building one would add a whole subsystem whose only
 * job is to make a harmless number sequence look tidier.
 *
 * ---------------------------------------------------------------------------
 * THE SEQUENCE IS NOT THE GUARANTEE. THE UNIQUE INDEX IS.
 * ---------------------------------------------------------------------------
 * A generated candidate can still be taken, because codes may be typed BY
 * HAND: nothing stops an operator entering `KZ-P-000123` today and the
 * sequence reaching 123 tomorrow. So generation SKIPS candidates that already
 * exist, up to `MAX_ATTEMPTS`, and the caller still writes through
 * `uq_products_product_code` / `uq_product_variants_variant_code`, which is
 * what actually makes a duplicate impossible — including against a concurrent
 * manual create that lands between this check and that INSERT.
 *
 * The skip loop is a courtesy that avoids handing the operator a code that is
 * visibly doomed; it is not, and must never be described as, the protection.
 * ============================================================================
 */
@Injectable()
export class ProductCodeService {
  private readonly logger = new Logger(ProductCodeService.name);

  /**
   * How many taken candidates to step over before giving up.
   *
   * Reaching this means the sequence is walking through a dense block of
   * hand-typed codes, which is a catalogue-shaped problem rather than a
   * transient one; retrying forever would turn it into a hung request.
   */
  private static readonly MAX_ATTEMPTS = 25;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * `EntityManager.query` is typed `Promise<any>`. The DECLARED RETURN TYPE
   * here is what narrows it — an explicit assertion is flagged redundant and
   * stripped by `eslint --fix`, putting `any` back at every call site.
   */
  private rows<T>(
    manager: EntityManager,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    return manager.query(sql, parameters);
  }

  /**
   * A fresh, currently-unused «کد محصول».
   *
   * `manager` is accepted so a caller inside a transaction can allocate on the
   * same connection. It changes nothing about correctness — `nextval` ignores
   * transactions entirely — but it avoids checking out a second pooled
   * connection while one is already held, which is the lock-ordering discipline
   * the rest of this codebase follows.
   */
  async nextProductCode(manager?: EntityManager): Promise<string> {
    const em = manager ?? this.dataSource.manager;

    for (
      let attempt = 0;
      attempt < ProductCodeService.MAX_ATTEMPTS;
      attempt++
    ) {
      const candidate = formatProductCode(
        await this.nextSequenceValue(em, PRODUCT_CODE_SEQUENCE),
      );

      const taken = await this.productCodeTaken(em, candidate);
      if (!taken) return candidate;

      this.logger.warn(
        `Generated product code ${candidate} is already taken by a manual ` +
          `entry; skipping to the next sequence value.`,
      );
    }

    throw new Error(
      `Could not allocate an unused product code after ` +
        `${ProductCodeService.MAX_ATTEMPTS} attempts. The ${PRODUCT_CODE_SEQUENCE} ` +
        `sequence is walking through a block of manually entered codes. ` +
        `Advance it past them with: SELECT setval('${PRODUCT_CODE_SEQUENCE}', <n>, true);`,
    );
  }

  /**
   * A fresh, currently-unused «کد گونه» BELONGING TO `rawProductCode`.
   *
   * The parent is normalised here rather than trusted, because this is reached
   * straight from an HTTP body: the form sends whatever is in the product-code
   * input, which may be mid-edit, lower-case, or carrying Persian digits.
   * Normalising first means the generated child provably satisfies
   * `assertVariantBelongsToProduct` against the code that will actually be
   * stored.
   *
   * The V number comes from a GLOBAL sequence, not a per-product counter. A
   * per-product counter would need either `max(...) + 1` over that product's
   * variants — the exact race the requirement forbids — or a counter column
   * with its own locking. A global number is unique by construction, and the
   * parent prefix is what expresses the relationship.
   */
  async nextVariantCode(
    rawProductCode: string,
    manager?: EntityManager,
  ): Promise<{ productCode: string; variantCode: string }> {
    const productCode = assertProductCode(rawProductCode);
    const em = manager ?? this.dataSource.manager;

    for (
      let attempt = 0;
      attempt < ProductCodeService.MAX_ATTEMPTS;
      attempt++
    ) {
      const candidate = formatVariantCode(
        productCode,
        await this.nextSequenceValue(em, VARIANT_CODE_SEQUENCE),
      );

      const taken = await this.variantCodeTaken(em, candidate);
      if (!taken) return { productCode, variantCode: candidate };

      this.logger.warn(
        `Generated variant code ${candidate} is already taken by a manual ` +
          `entry; skipping to the next sequence value.`,
      );
    }

    throw new Error(
      `Could not allocate an unused variant code after ` +
        `${ProductCodeService.MAX_ATTEMPTS} attempts. The ${VARIANT_CODE_SEQUENCE} ` +
        `sequence is walking through a block of manually entered codes. ` +
        `Advance it past them with: SELECT setval('${VARIANT_CODE_SEQUENCE}', <n>, true);`,
    );
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * `nextval` returns bigint, which `pg` hands back as a STRING. It is kept as
   * a string all the way into `lpad`-equivalent formatting rather than passed
   * through `Number`, so a sequence beyond 2^53 cannot silently start
   * producing duplicate codes through float rounding.
   */
  private async nextSequenceValue(
    em: EntityManager,
    sequence: string,
  ): Promise<string> {
    const rows = await this.rows<{ value: string }>(
      em,
      `SELECT nextval($1)::text AS value`,
      [sequence],
    );

    const value = rows[0]?.value;
    if (value === undefined) {
      throw new Error(`nextval('${sequence}') returned no row`);
    }
    return value;
  }

  private async productCodeTaken(
    em: EntityManager,
    code: string,
  ): Promise<boolean> {
    const rows = await this.rows<{ '?column?': number }>(
      em,
      `SELECT 1 FROM "products" WHERE "productCode" = $1 LIMIT 1`,
      [code],
    );
    return rows.length > 0;
  }

  private async variantCodeTaken(
    em: EntityManager,
    code: string,
  ): Promise<boolean> {
    const rows = await this.rows<{ '?column?': number }>(
      em,
      `SELECT 1 FROM "product_variants" WHERE "variantCode" = $1 LIMIT 1`,
      [code],
    );
    return rows.length > 0;
  }
}

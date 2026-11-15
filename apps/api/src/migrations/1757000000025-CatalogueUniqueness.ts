import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0025 — CATALOGUE UNIQUENESS IN THE DATABASE, not only in the service.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `CategoriesService.create`, `AttributeService.create/renameAttribute/
 * addValues/renameValue` all refuse a duplicate name — and every one of those
 * refusals is a SELECT followed by an INSERT. Two requests that arrive at the
 * same moment both read "free" and both write. `categories.title` carried no
 * constraint at all, and `product_attribute_value.value` none either, so the
 * duplicate that the race produced was permanent and invisible: two identical
 * entries in the storefront nav, or one colour axis offering «قرمز» twice,
 * with nothing in the schema to say which is the real one. The application
 * comment in `categories.messages.ts` named the fix — "a unique index on
 * LOWER(title)" — and deferred it. This is that migration.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPE DECISION (documented here AND in
 * `src/common/catalogue/catalogue-uniqueness.ts`)
 * ---------------------------------------------------------------------------
 *   categories.title               unique GLOBALLY.
 *       `Category` is FLAT — no parent column, no self relation — so a
 *       per-parent scope does not exist to be chosen.
 *
 *   product_attribute.name         unique GLOBALLY.
 *       Matches what `renameAttribute` already promises (it compares
 *       case-insensitively) and strengthens the baseline `UNIQUE ("name")`,
 *       which is case- and variant-SENSITIVE. The baseline constraint is LEFT
 *       IN PLACE: the entity still declares `@Column({ unique: true })`, and
 *       dropping it would put the entity metadata and the schema at odds for
 *       no gain.
 *
 *   product_attribute_value.value  unique WITHIN ONE ATTRIBUTE, not globally.
 *       «قرمز» may legitimately be a value of both «رنگ» and «رنگ آستر».
 *       This matches `addValues` and `renameValue`, which already scope their
 *       check to the parent attribute.
 *
 *       DISCREPANCY, RESOLVED IN FAVOUR OF THE NARROW SCOPE:
 *       `AttributeService.create` used to check the submitted values against
 *       the WHOLE vocabulary (`find({ where: { value: In(values) } })`), so
 *       the API promised two different things depending on which endpoint you
 *       reached. A global index would have frozen the wrong one — it makes an
 *       existing axis unextendable for a reason the store manager cannot see
 *       — so `create` has been narrowed to match `addValues` instead.
 *
 * ---------------------------------------------------------------------------
 * THE NORMALISATION DECISION — ک/ی ARE FOLDED
 * ---------------------------------------------------------------------------
 * `catalogue_norm(text)` applies, in order:
 *
 *   1. FOLD  ك U+0643 ARABIC KAF → ک U+06A9 PERSIAN KEHEH
 *            ي U+064A ARABIC YEH → ی U+06CC PERSIAN YEH
 *   2. TRIM  space, tab, LF, CR, FF, VT and NBSP (U+00A0) from both ends
 *   3. LOWER
 *
 * WHY FOLD. The two pairs are visually identical in every font the admin
 * console renders. A store manager typing on an Arabic keyboard layout — or
 * pasting a name out of a supplier's list — produces «كيف»; the same person on
 * a Persian layout produces «کیف». Without folding, both rows exist, both look
 * the same on screen, and nobody can tell which one the products are in. With
 * folding they COLLIDE and the second one is refused with a plain 409.
 * به بیان ساده: «کیف» و «كيف» یک نام حساب می‌شوند و دوّمی پذیرفته نمی‌شود.
 *
 * NOT folded, deliberately: ZWNJ U+200C (نیم‌فاصله) — «دسته‌بندی» and
 * «دسته بندی» remain different names, because collapsing them would mean
 * choosing between deleting the half-space and turning it into a space, and
 * those two choices disagree on real words. Also not folded: Arabic-Indic
 * digits, alef hamza variants (أ إ آ) and ة/ه — none of them is the everyday
 * keyboard accident that ک/ی is.
 *
 * `catalogue_norm` is a real, IMMUTABLE database function rather than an
 * expression copy-pasted into three indexes: the APPLICATION's pre-check calls
 * the same function, so the check and the constraint cannot disagree and
 * produce a confusing 500. It is written with `chr()` rather than escape
 * sequences so no backslash has to survive a TypeScript template literal, a
 * TypeORM parameter pass and the PostgreSQL parser intact.
 *
 * ---------------------------------------------------------------------------
 * IT REFUSES TO RUN ON DIRTY DATA. IT NEVER CLEANS IT.
 * ---------------------------------------------------------------------------
 * Before any constraint is created, three guards run and THROW with the
 * colliding rows listed by id and by text, so an operator can fix them by
 * hand. Nothing is auto-merged, auto-renamed or auto-deleted: only a human
 * knows whether the two «کیف» categories are one category typed twice or two
 * different things, and merging them would silently move products between
 * them.
 *
 * The ONE write this migration makes to existing rows is `btrim` on the three
 * text columns, and only where it changes something. Trimming loses no
 * information a catalogue can show — leading and trailing blanks are invisible
 * on screen — and it is done only AFTER the duplicate guard has passed, so a
 * collision that trimming would CREATE ("کیف" + "کیف ") is reported as a
 * duplicate rather than silently produced and then rejected by the index.
 * `down()` does NOT restore the blanks; it cannot, and nothing depends on them.
 *
 * AUDIT AT THE TIME OF WRITING (review database `kazhal_review`):
 *   categories = 14, product_attribute = 7, product_attribute_value = 33;
 *   0 normalised duplicates, 0 blanks, 0 untrimmed values in all three tables.
 * So on that data every guard passes and the trim updates 0 rows.
 * ============================================================================
 */

/** Characters `catalogue_norm` strips from both ends, built without escapes. */
const TRIM_CHARS =
  'chr(32) || chr(9) || chr(10) || chr(13) || chr(12) || chr(11) || chr(160)';

/** ك U+0643 (1603) and ي U+064A (1610) → ک U+06A9 (1705) and ی U+06CC (1740). */
const FOLD_FROM = 'chr(1603) || chr(1610)';
const FOLD_TO = 'chr(1705) || chr(1740)';

interface DuplicateGroup {
  key: string;
  scope: string | null;
  rows: Array<{ id: number; text: string }>;
}

interface BlankRow {
  id: number;
  text: string;
}

/** One human-readable line per colliding group, ids included. */
function describeDuplicates(groups: DuplicateGroup[]): string {
  return groups
    .map((group) => {
      const where = group.scope === null ? '' : ` [attributeId=${group.scope}]`;
      const rows = group.rows
        .map((row) => `#${row.id} ${JSON.stringify(row.text)}`)
        .join(' , ');
      return `  ${JSON.stringify(group.key)}${where}  <-  ${rows}`;
    })
    .join('\n');
}

function describeBlanks(rows: BlankRow[]): string {
  return rows
    .map((row) => `  #${row.id} ${JSON.stringify(row.text)}`)
    .join('\n');
}

export class CatalogueUniqueness1757000000025 implements MigrationInterface {
  name = 'CatalogueUniqueness1757000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // 1. The normalisation function. Everything below — and the application's
    //    duplicate pre-check — goes through this one definition.
    // ---------------------------------------------------------------------
    await queryRunner.query(
      `CREATE FUNCTION "catalogue_norm"(input text) RETURNS text
         LANGUAGE sql
         IMMUTABLE
         PARALLEL SAFE
         RETURNS NULL ON NULL INPUT
       AS $fn$
         SELECT lower(btrim(translate($1, ${FOLD_FROM}, ${FOLD_TO}), ${TRIM_CHARS}))
       $fn$`,
    );

    // ---------------------------------------------------------------------
    // 2. GUARD: blanks. A row whose whole name is whitespace cannot be shown,
    //    cannot be searched for, and collides with every other blank row once
    //    the unique index exists.
    // ---------------------------------------------------------------------
    await this.assertNoBlanks(
      queryRunner,
      'categories',
      'title',
      'category titles',
    );
    await this.assertNoBlanks(
      queryRunner,
      'product_attribute',
      'name',
      'attribute names',
    );
    await this.assertNoBlanks(
      queryRunner,
      'product_attribute_value',
      'value',
      'attribute values',
    );

    // ---------------------------------------------------------------------
    // 3. GUARD: duplicates under the decided scope + normalisation.
    //    This runs BEFORE the trim, so a collision that trimming would create
    //    is reported here rather than silently manufactured.
    // ---------------------------------------------------------------------
    await this.assertNoDuplicates(
      queryRunner,
      `SELECT "catalogue_norm"("title") AS key,
              NULL::text AS scope,
              json_agg(json_build_object('id', "id", 'text', "title")
                       ORDER BY "id") AS rows
         FROM "categories"
        GROUP BY 1
       HAVING count(*) > 1
        ORDER BY 1`,
      'categories.title (unique GLOBALLY)',
    );

    await this.assertNoDuplicates(
      queryRunner,
      `SELECT "catalogue_norm"("name") AS key,
              NULL::text AS scope,
              json_agg(json_build_object('id', "id", 'text', "name")
                       ORDER BY "id") AS rows
         FROM "product_attribute"
        GROUP BY 1
       HAVING count(*) > 1
        ORDER BY 1`,
      'product_attribute.name (unique GLOBALLY)',
    );

    // `attributeId IS NULL` rows are excluded: they are orphans no endpoint
    // can create, and the unique index treats NULL scopes as distinct anyway,
    // so failing the migration over them would refuse to install a constraint
    // they cannot violate.
    await this.assertNoDuplicates(
      queryRunner,
      `SELECT "catalogue_norm"("value") AS key,
              "attributeId"::text AS scope,
              json_agg(json_build_object('id', "id", 'text', "value")
                       ORDER BY "id") AS rows
         FROM "product_attribute_value"
        WHERE "attributeId" IS NOT NULL
        GROUP BY 1, 2
       HAVING count(*) > 1
        ORDER BY 2, 1`,
      'product_attribute_value.value (unique WITHIN ONE ATTRIBUTE)',
    );

    // ---------------------------------------------------------------------
    // 4. The one permitted repair: strip invisible edge whitespace. Safe —
    //    nothing a catalogue displays is lost — and now provably
    //    collision-free, because step 3 compared the TRIMMED forms.
    // ---------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "categories"
          SET "title" = btrim("title", ${TRIM_CHARS})
        WHERE "title" <> btrim("title", ${TRIM_CHARS})`,
    );
    await queryRunner.query(
      `UPDATE "product_attribute"
          SET "name" = btrim("name", ${TRIM_CHARS})
        WHERE "name" <> btrim("name", ${TRIM_CHARS})`,
    );
    await queryRunner.query(
      `UPDATE "product_attribute_value"
          SET "value" = btrim("value", ${TRIM_CHARS})
        WHERE "value" <> btrim("value", ${TRIM_CHARS})`,
    );

    // ---------------------------------------------------------------------
    // 5. The constraints themselves.
    // ---------------------------------------------------------------------
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_categories_title_norm"
         ON "categories" (("catalogue_norm"("title")))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_product_attribute_name_norm"
         ON "product_attribute" (("catalogue_norm"("name")))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_product_attribute_value_per_attribute_norm"
         ON "product_attribute_value" ("attributeId", ("catalogue_norm"("value")))`,
    );

    // Blank names are unrepresentable from here on. Stated through
    // `catalogue_norm` rather than a bare `btrim(...) <> ''` so that a title
    // made only of non-breaking spaces — which looks blank and IS blank to a
    // reader — is refused too.
    await queryRunner.query(
      `ALTER TABLE "categories"
         ADD CONSTRAINT "ck_categories_title_not_blank"
         CHECK ("catalogue_norm"("title") <> '')`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_attribute"
         ADD CONSTRAINT "ck_product_attribute_name_not_blank"
         CHECK ("catalogue_norm"("name") <> '')`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_attribute_value"
         ADD CONSTRAINT "ck_product_attribute_value_not_blank"
         CHECK ("catalogue_norm"("value") <> '')`,
    );
  }

  /**
   * Drops everything `up()` added, in dependency order: the CHECK constraints
   * and the indexes both depend on `catalogue_norm`, so the function goes last.
   *
   * The trim in step 4 is NOT undone — the removed characters were never
   * recorded and restoring them would mean inventing data.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_attribute_value"
         DROP CONSTRAINT "ck_product_attribute_value_not_blank"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_attribute"
         DROP CONSTRAINT "ck_product_attribute_name_not_blank"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories"
         DROP CONSTRAINT "ck_categories_title_not_blank"`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."uq_product_attribute_value_per_attribute_norm"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_product_attribute_name_norm"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_categories_title_norm"`);

    await queryRunner.query(`DROP FUNCTION "catalogue_norm"(text)`);
  }

  // =========================================================================
  // Guards
  // =========================================================================

  private async assertNoBlanks(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    label: string,
  ): Promise<void> {
    // `QueryRunner.query` is not generic and returns `any`; the shape is
    // fixed by the SELECT two lines up.
    const rows = (await queryRunner.query(
      `SELECT "id", "${column}" AS text
         FROM "${table}"
        WHERE "catalogue_norm"("${column}") = ''
        ORDER BY "id"`,
    )) as BlankRow[];
    if (rows.length === 0) return;

    throw new Error(
      `${this.name} REFUSES TO RUN.\n` +
        `${rows.length} blank ${label} exist in "${table}"."${column}". ` +
        `A name that is entirely whitespace cannot be displayed and collides ` +
        `with every other blank name once the unique index exists.\n` +
        `${describeBlanks(rows)}\n` +
        `FIX BY HAND: give each of these rows a real name (or delete the row ` +
        `if it is not in use), then run the migration again. This migration ` +
        `deliberately does not rename or delete anything for you.`,
    );
  }

  private async assertNoDuplicates(
    queryRunner: QueryRunner,
    sql: string,
    label: string,
  ): Promise<void> {
    const groups = (await queryRunner.query(sql)) as DuplicateGroup[];
    if (groups.length === 0) return;

    const rowCount = groups.reduce((sum, g) => sum + g.rows.length, 0);
    throw new Error(
      `${this.name} REFUSES TO RUN.\n` +
        `${groups.length} duplicate group(s) covering ${rowCount} rows violate ` +
        `the uniqueness rule for ${label}.\n` +
        `Compared after normalisation: ک/ك and ی/ي folded together, ends ` +
        `trimmed, lower-cased. Rows that look different may still collide for ` +
        `exactly that reason.\n` +
        `${describeDuplicates(groups)}\n` +
        `FIX BY HAND: decide which row survives, move whatever references the ` +
        `others onto it, then rename or delete the losers. This migration ` +
        `NEVER merges, renames or deletes catalogue rows — only a human knows ` +
        `whether two identical-looking names are one thing typed twice or two ` +
        `different things.`,
    );
  }
}

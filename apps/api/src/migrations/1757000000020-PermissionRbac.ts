import { MigrationInterface, QueryRunner } from 'typeorm';
import UserRoleEnum from '../modules/user/enums/user-role.enum';

/**
 * 0020 — PERMISSION-BASED AUTHORISATION.
 *
 * THE DEFECT THIS REPLACES. Authorisation was three role NAMES matched by
 * `@Roles(...)`. That gives an owner exactly two settings for an employee —
 * "can do everything an administrator can" or "cannot enter the admin console
 * at all" — so handing one person the order queue meant handing them the
 * ability to void sales, read every report, reset passwords and edit roles.
 * There was no representable middle.
 *
 * ===========================================================================
 * WHY THE CATALOGUE BELOW IS A FROZEN LITERAL AND NOT AN IMPORT
 * ===========================================================================
 *
 * This migration used to `import { PERMISSION_CATALOG }` from
 * `permission.catalog.ts` and loop over it, on the reasoning that importing
 * the live catalogue meant the two "could not drift". That reasoning is
 * exactly backwards, and it is the defect this revision fixes.
 *
 * A migration is a HISTORICAL FACT: "on this date, the schema changed from X
 * to Y". Its output must depend only on the database it is applied to, never
 * on the current contents of a source file that is still being edited. A
 * migration that reads live code produces DIFFERENT DATABASES depending on
 * WHEN it is run:
 *
 *   - a database migrated today gets today's 45 codes;
 *   - a database migrated after somebody adds a 46th code to the catalogue
 *     gets 46 codes from this same migration;
 *   - a database that was ALREADY migrated gets 45 and never hears about the
 *     46th, because migrations run once.
 *
 * So the fresh environment and the long-lived environment permanently
 * diverge, and nothing in the system can tell you they have. `down()` then
 * `up()` on the same database no longer returns it to the same state, which
 * is the definition of non-deterministic rollback.
 *
 * The rows below are therefore the catalogue AS IT STOOD WHEN THIS MIGRATION
 * WAS WRITTEN, pinned. They must never be edited again. Adding, retiring,
 * relabelling, re-grouping or re-risking a permission is a NEW migration —
 * that is the whole point, and `PermissionCatalogIntegrityService` fails the
 * application's boot if anybody forgets.
 *
 * WHY THIS MIGRATION IS EDITED IN PLACE RATHER THAN CORRECTED BY AN 0024.
 * 0020 has never been committed to git and has never been deployed: it exists
 * only as an untracked working-tree file, applied to a disposable review
 * database that this pass resets. Migrations 0021-0023 add
 * `branches.isActive`, `admin_audit_log` and `users.mustChangePassword`, and
 * none of them reads or writes `permissions` or `role_permissions`, so no
 * later migration depends on 0020's exact current state. Editing it in place
 * therefore leaves one honest migration instead of a broken one plus a
 * corrective one that exists only to apologise for it. Had 0020 been pushed —
 * or had 0021-0023 touched these tables — the correct answer would have been
 * the opposite: leave it alone and add a new explicit migration.
 *
 * ===========================================================================
 * WHAT IS STORED HERE, AND WHAT DELIBERATELY IS NOT
 * ===========================================================================
 *
 * `permissions` is SYSTEM REFERENCE DATA owned by migrations. The application
 * reads it and never writes it. `retiredAt` gives a code a way to stop
 * granting anything without being deleted: deleting a row would cascade
 * through `role_permissions` and silently strip a capability from every custom
 * role that held it, with no record that it ever existed. A retired row keeps
 * the grants visible and inert, which is what makes retirement auditable and
 * reversible.
 *
 * `role_permissions` holds grants for CUSTOM roles ONLY. The three system
 * roles' capability sets live in `SYSTEM_ROLE_PERMISSIONS` (code), and the
 * effective-permission resolver expands them from there. That is deliberate:
 *
 *   - a row that could strip `rbac.manage` from `super_admin` is a lockout
 *     primitive, and every route that could put it back requires the
 *     permission that was just removed — the same unrecoverable state
 *     `role-safety.ts` already exists to prevent for role ASSIGNMENT;
 *   - the built-in sets are what the seeder, the audience rules and the POS
 *     flow assume, so they are part of the application, not of its data;
 *   - it means a truncated or freshly-migrated database still has a working
 *     administrator, rather than one whose account exists and authorises
 *     nothing.
 *
 * `roles` gains lifecycle columns so a custom role can be retired without
 * stripping it from the users who hold it: an inactive role contributes
 * nothing to effective permissions, and reactivating it restores exactly the
 * access it had. Deleting would lose the assignments irreversibly.
 */

/**
 * The catalogue as of this migration. FROZEN — see the header.
 * Tuple order: code, groupKey, labelFa, descriptionFa, risk.
 */
const CATALOGUE_AT_0020: ReadonlyArray<
  readonly [string, string, string, string, string]
> = [
  [
    'admin.access',
    'surfaces',
    'ورود به پنل مدیریت',
    'این نقش می‌تواند وارد پنل مدیریت شود. بدون این دسترسی، حتی با داشتن سایر اختیارات، ورود به پنل مدیریت ممکن نیست.',
    'sensitive',
  ],
  [
    'pos.access',
    'surfaces',
    'ورود به صندوق فروشگاه',
    'این نقش می‌تواند وارد نرم‌افزار صندوق (POS) شود و کاتالوگ کالاها را ببیند.',
    'normal',
  ],
  [
    'storefront.access',
    'surfaces',
    'ورود به فروشگاه اینترنتی (مشتری)',
    'دسترسی حساب مشتری در فروشگاه اینترنتی. این یک دسترسی مشتری است، نه یک اختیار مدیریتی.',
    'normal',
  ],
  [
    'dashboard.read',
    'dashboard',
    'مشاهدهٔ داشبورد',
    'مشاهدهٔ خلاصهٔ فروش امروز، سفارش‌های در انتظار، هشدارهای موجودی و پرونده‌های باز.',
    'sensitive',
  ],
  [
    'products.read',
    'products',
    'مشاهدهٔ کالاها',
    'دیدن فهرست کالاها، گونه‌ها (Variant)، کد کالا (SKU) و قیمت‌ها در پنل مدیریت.',
    'normal',
  ],
  [
    'products.create',
    'products',
    'ایجاد کالا',
    'افزودن کالای جدید همراه با گونه‌ها، قیمت و دسته‌بندی.',
    'normal',
  ],
  [
    'products.update',
    'products',
    'ویرایش کالا',
    'تغییر عنوان، توضیحات، قیمت پایه، دسته‌بندی، تصاویر و گونه‌های کالا. موجودی از این مسیر تغییر نمی‌کند.',
    'normal',
  ],
  [
    'products.activate',
    'products',
    'فعال‌کردن گونهٔ کالا',
    'بازگرداندن یک گونهٔ بازنشسته به فروش. کالا دوباره در سایت و صندوق قابل فروش می‌شود.',
    'normal',
  ],
  [
    'products.deactivate',
    'products',
    'غیرفعال‌کردن گونهٔ کالا',
    'خارج‌کردن یک گونه از فروش در سایت و صندوق. سابقهٔ سفارش‌های گذشته دست‌نخورده می‌ماند.',
    'sensitive',
  ],
  [
    'categories.read',
    'categories',
    'مشاهدهٔ دسته‌بندی‌ها',
    'دیدن فهرست دسته‌بندی‌ها و تعداد کالای هر دسته.',
    'normal',
  ],
  [
    'categories.create',
    'categories',
    'ایجاد دسته‌بندی',
    'افزودن دسته‌بندی تازه به کاتالوگ.',
    'normal',
  ],
  [
    'categories.update',
    'categories',
    'تغییر نام دسته‌بندی',
    'تغییر عنوان یک دسته‌بندی موجود.',
    'normal',
  ],
  [
    'categories.delete',
    'categories',
    'حذف دسته‌بندی',
    'حذف دسته‌بندی‌ای که هیچ کالایی در آن نیست. دسته‌بندی دارای کالا حذف نمی‌شود.',
    'sensitive',
  ],
  [
    'attributes.read',
    'attributes',
    'مشاهدهٔ ویژگی‌ها',
    'دیدن ویژگی‌ها (مانند رنگ، سایز، ظرفیت) و مقادیر آن‌ها به همراه تعداد گونه‌های استفاده‌کننده.',
    'normal',
  ],
  [
    'attributes.create',
    'attributes',
    'ایجاد ویژگی یا مقدار',
    'افزودن ویژگی تازه یا افزودن مقدار تازه به یک ویژگی موجود.',
    'normal',
  ],
  [
    'attributes.update',
    'attributes',
    'تغییر نام ویژگی یا مقدار',
    'تغییر نام یک ویژگی یا یکی از مقادیر آن. نام‌های ثبت‌شده روی سفارش‌های گذشته تغییر نمی‌کند.',
    'normal',
  ],
  [
    'attributes.delete',
    'attributes',
    'حذف ویژگی یا مقدار',
    'حذف ویژگی یا مقداری که هیچ گونه‌ای از آن استفاده نمی‌کند. موارد در حال استفاده حذف نمی‌شوند.',
    'sensitive',
  ],
  [
    'inventory.read',
    'inventory',
    'مشاهدهٔ موجودی',
    'دیدن موجودی فیزیکی، رزرو سبد خرید، تخصیص سفارش و موجودی قابل فروش در سایت و صندوق.',
    'normal',
  ],
  [
    'inventory.adjust',
    'inventory',
    'اصلاح موجودی انبار',
    'این نقش می‌تواند موجودی فیزیکی انبار را کم یا زیاد کند. هر اصلاح با ذکر دلیل و نام انجام‌دهنده در دفتر موجودی ثبت می‌شود و قابل حذف نیست.',
    'critical',
  ],
  [
    'inventory.movements.read',
    'inventory',
    'مشاهدهٔ تاریخچهٔ گردش موجودی',
    'دیدن دفتر گردش موجودی: هر کم و زیاد شدن، دلیل آن، انجام‌دهنده و سفارش مرتبط.',
    'normal',
  ],
  [
    'orders.read',
    'orders',
    'مشاهدهٔ سفارش‌ها',
    'این نقش می‌تواند اطلاعات سفارش مشتریان را ببیند؛ شامل اقلام، مبلغ، نشانی تحویل و شمارهٔ تماس گیرنده.',
    'sensitive',
  ],
  [
    'orders.status.update',
    'orders',
    'تغییر وضعیت سفارش',
    'این نقش می‌تواند وضعیت سفارش را جلو ببرد (مثلاً «در حال آماده‌سازی» یا «ارسال‌شده»). این کار پول یا موجودی را جابه‌جا نمی‌کند.',
    'sensitive',
  ],
  [
    'orders.void',
    'orders',
    'ابطال سفارش',
    'این نقش می‌تواند یک فروش ثبت‌شده را باطل کند. کالاها به موجودی برمی‌گردند و فروش از گزارش کسر می‌شود. این کار برگشت‌ناپذیر است.',
    'critical',
  ],
  [
    'orders.return',
    'orders',
    'ثبت مرجوعی سفارش',
    'این نقش می‌تواند یک فروش پرداخت‌شده را مرجوع کند. کالاها به موجودی برمی‌گردند و مبلغ در گزارش به‌عنوان بازپرداخت ثبت می‌شود. این کار برگشت‌ناپذیر است.',
    'critical',
  ],
  [
    'orders.actions.read',
    'orders',
    'مشاهدهٔ تاریخچهٔ اقدام‌های سفارش',
    'دیدن اینکه چه کسی، چه زمانی و با چه دلیلی وضعیت سفارش را تغییر داده، آن را باطل یا مرجوع کرده است.',
    'normal',
  ],
  [
    'reconciliation.read',
    'reconciliation',
    'مشاهدهٔ پرونده‌های مغایرت پرداخت',
    'دیدن سفارش‌هایی که پول مشتری دریافت شده ولی سفارش کامل نشده، یا مشکل موجودی دارند.',
    'sensitive',
  ],
  [
    'reconciliation.act',
    'reconciliation',
    'اقدام روی پروندهٔ مغایرت',
    'این نقش می‌تواند روی پروندهٔ مغایرت اقدام ثبت کند: تلاش دوباره برای تکمیل موجودی، ثبت نیاز به بازپرداخت، تأیید بازپرداخت انجام‌شده در درگاه، یا بستن پرونده. هیچ‌کدام از این اقدام‌ها به‌تنهایی پولی جابه‌جا نمی‌کند.',
    'critical',
  ],
  [
    'reports.read',
    'reports',
    'مشاهدهٔ گزارش فروش',
    'این نقش می‌تواند مبلغ کل فروش، بازپرداخت‌ها، فروش هر شعبه و فروش هر صندوق‌دار را ببیند.',
    'sensitive',
  ],
  [
    'users.read',
    'users',
    'مشاهدهٔ کاربران',
    'دیدن فهرست کارکنان و مشتریان، نقش‌ها، شعبه و وضعیت فعال یا غیرفعال بودن آن‌ها.',
    'sensitive',
  ],
  [
    'users.create',
    'users',
    'ایجاد کاربر',
    'ساخت حساب کاربری تازه برای کارکنان، همراه با نام کاربری، گذرواژه، نقش و شعبه.',
    'sensitive',
  ],
  [
    'users.update',
    'users',
    'ویرایش کاربر',
    'تغییر نام کاربری، شمارهٔ همراه و شعبهٔ یک کاربر. تغییر نقش‌ها دسترسی جداگانه‌ای دارد.',
    'sensitive',
  ],
  [
    'users.activate',
    'users',
    'فعال‌کردن کاربر',
    'بازگرداندن امکان ورود به یک حساب غیرفعال‌شده.',
    'sensitive',
  ],
  [
    'users.deactivate',
    'users',
    'غیرفعال‌کردن کاربر',
    'این نقش می‌تواند ورود یک کاربر را قطع کند. نشست‌های باز آن کاربر در همهٔ سامانه‌ها بلافاصله از کار می‌افتد.',
    'critical',
  ],
  [
    'users.sessions.revoke',
    'users',
    'قطع نشست‌های کاربر',
    'خروج اجباری یک کاربر از همهٔ دستگاه‌ها و همهٔ سامانه‌ها. حساب کاربر غیرفعال نمی‌شود.',
    'sensitive',
  ],
  [
    'users.password.reset',
    'users',
    'تعیین گذرواژهٔ موقت',
    'این نقش می‌تواند برای یک کاربر گذرواژهٔ موقت تعیین کند. تمام نشست‌های آن کاربر قطع می‌شود و در ورود بعدی باید گذرواژه را تغییر دهد. گذرواژهٔ فعلی هیچ‌گاه نمایش داده نمی‌شود.',
    'critical',
  ],
  [
    'branches.read',
    'branches',
    'مشاهدهٔ شعبه‌ها',
    'دیدن فهرست شعبه‌ها، نشانی، تلفن و صندوق‌داران هر شعبه.',
    'normal',
  ],
  ['branches.create', 'branches', 'ایجاد شعبه', 'افزودن شعبهٔ تازه.', 'normal'],
  [
    'branches.update',
    'branches',
    'ویرایش شعبه',
    'تغییر نام، نشانی و تلفن شعبه. نام ثبت‌شده روی سفارش‌های گذشته تغییر نمی‌کند.',
    'normal',
  ],
  [
    'branches.activate',
    'branches',
    'فعال‌کردن شعبه',
    'بازگرداندن شعبه به چرخهٔ فروش.',
    'sensitive',
  ],
  [
    'branches.deactivate',
    'branches',
    'غیرفعال‌کردن شعبه',
    'این نقش می‌تواند یک شعبه را از چرخهٔ فروش خارج کند. صندوق‌داران آن شعبه دیگر نمی‌توانند فروش ثبت کنند.',
    'critical',
  ],
  [
    'rbac.read',
    'access',
    'مشاهدهٔ نقش‌ها و دسترسی‌ها',
    'دیدن فهرست نقش‌ها و اختیارات هر نقش.',
    'sensitive',
  ],
  [
    'rbac.manage',
    'access',
    'مدیریت نقش‌ها و دسترسی‌ها',
    'این نقش می‌تواند نقش بسازد، اختیارات نقش‌ها را تغییر دهد و نقش کاربران را عوض کند. هر کسی که این دسترسی را داشته باشد می‌تواند اختیارات خودش و دیگران را تغییر دهد.',
    'critical',
  ],
  [
    'audit.read',
    'access',
    'مشاهدهٔ دفتر رخدادهای مدیریتی',
    'دیدن اینکه چه کسی چه تغییری در نقش‌ها، کاربران، شعبه‌ها، موجودی و سفارش‌ها داده است.',
    'sensitive',
  ],
  [
    'pos.sell',
    'surfaces',
    'ثبت فروش در صندوق',
    'این نقش می‌تواند در صندوق فروش ثبت کند. هر فروش موجودی فیزیکی را کم می‌کند و به نام همین کاربر و شعبهٔ او ثبت می‌شود.',
    'sensitive',
  ],
  [
    'pos.receipt.read_own',
    'surfaces',
    'مشاهدهٔ رسید فروش‌های خود',
    'دیدن رسید فروش‌هایی که خودِ این کاربر ثبت کرده است — و نه فروش دیگران.',
    'normal',
  ],
];

export class PermissionRbac1757000000020 implements MigrationInterface {
  name = 'PermissionRbac1757000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id"            SERIAL PRIMARY KEY,
        "code"          character varying(64)  NOT NULL,
        "groupKey"      character varying(48)  NOT NULL,
        "labelFa"       character varying(160) NOT NULL,
        "descriptionFa" text                   NOT NULL,
        "risk"          character varying(16)  NOT NULL DEFAULT 'normal',
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "retiredAt"     TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "uq_permissions_code" UNIQUE ("code"),
        CONSTRAINT "ck_permissions_risk" CHECK ("risk" IN ('normal','sensitive','critical'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_permissions_group" ON "permissions" ("groupKey")`,
    );
    // Partial, because every read the application performs is "the codes that
    // still grant something" — retired rows exist for history, not for lookup.
    await queryRunner.query(
      `CREATE INDEX "idx_permissions_active" ON "permissions" ("code") WHERE "retiredAt" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "roleId"          integer NOT NULL,
        "permissionId"    integer NOT NULL,
        "grantedByUserId" integer NULL,
        "grantedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_role_permissions" PRIMARY KEY ("roleId", "permissionId"),
        CONSTRAINT "fk_role_permissions_role"
          FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_role_permissions_permission"
          FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_role_permissions_granted_by"
          FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // The PK already covers ("roleId", …); this serves "who grants X?", which
    // the access-control screen asks when a permission is about to be retired.
    await queryRunner.query(
      `CREATE INDEX "idx_role_permissions_permission" ON "role_permissions" ("permissionId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "roles" ADD "titleFa" character varying(80)`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "description" character varying(400)`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "isSystem" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "isActive" boolean NOT NULL DEFAULT true`,
    );

    // Matched on NAME. `roles.id` differs per environment and per seed run, so
    // an id-based statement would protect the wrong row on the next database.
    await queryRunner.query(
      `UPDATE "roles" SET "isSystem" = true, "isActive" = true WHERE "name" = ANY($1::text[])`,
      [Object.values(UserRoleEnum)],
    );
    await queryRunner.query(
      `UPDATE "roles" SET "titleFa" = $2, "description" = $3 WHERE "name" = $1`,
      [
        UserRoleEnum.superAdmin,
        'مدیر ارشد',
        'دسترسی کامل به همهٔ بخش‌های مدیریتی. این نقش قابل حذف یا محدود کردن نیست.',
      ],
    );
    await queryRunner.query(
      `UPDATE "roles" SET "titleFa" = $2, "description" = $3 WHERE "name" = $1`,
      [
        UserRoleEnum.sale,
        'صندوق‌دار',
        'ورود به صندوق فروشگاه و ثبت فروش. دسترسی به پنل مدیریت ندارد.',
      ],
    );
    await queryRunner.query(
      `UPDATE "roles" SET "titleFa" = $2, "description" = $3 WHERE "name" = $1`,
      [
        UserRoleEnum.site,
        'مشتری',
        'حساب مشتری فروشگاه اینترنتی. هیچ اختیار مدیریتی ندارد.',
      ],
    );

    // The catalogue, from the frozen list above. ONE statement rather than 45
    // round trips, and a plain INSERT rather than an upsert: the table was
    // created four statements ago and is empty by construction, so a conflict
    // clause here would only hide a bug.
    await queryRunner.query(
      `INSERT INTO "permissions" ("code", "groupKey", "labelFa", "descriptionFa", "risk")
       SELECT * FROM UNNEST(
         $1::varchar[], $2::varchar[], $3::varchar[], $4::text[], $5::varchar[]
       )`,
      [
        CATALOGUE_AT_0020.map((row) => row[0]),
        CATALOGUE_AT_0020.map((row) => row[1]),
        CATALOGUE_AT_0020.map((row) => row[2]),
        CATALOGUE_AT_0020.map((row) => row[3]),
        CATALOGUE_AT_0020.map((row) => row[4]),
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "isActive"`);
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "isSystem"`);
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "description"`);
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "titleFa"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_role_permissions_permission"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "role_permissions"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_permissions_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_permissions_group"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "permissions"`);
  }
}

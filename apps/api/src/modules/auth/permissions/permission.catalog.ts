/**
 * ===========================================================================
 * THE PERMISSION CATALOGUE — the single definition of what may be delegated
 * ===========================================================================
 *
 * WHY THIS EXISTS. Authorisation used to be three fixed role NAMES
 * (`super_admin`, `sale`, `site`) checked by `@Roles(...)`. That model has
 * exactly two settings for a member of staff: "can do everything an
 * administrator can do" or "can do nothing an administrator can do". The owner
 * needs to hand one employee the order queue and nothing else, and another the
 * stockroom and nothing else, so the unit of authorisation has to be a
 * CAPABILITY, not a job title.
 *
 * A permission is a SYSTEM-DEFINED capability code. It is not user data:
 *
 *  - the codes below are the only ones that exist. There is no endpoint that
 *    invents one, because a code nothing checks authorises nothing — the same
 *    reasoning that removed `POST /roles` in the role-name model;
 *  - a code is STABLE. It is written into `@RequirePermissions(...)` call
 *    sites and into `role_permissions` rows, so renaming one silently changes
 *    who can do what. Add a new code and retire the old one instead;
 *  - the Persian label and description below are what an administrator
 *    actually reads. `orders.status.update` is a machine key, never a UI
 *    label — see `apps/web/lib/permissions.ts`, which renders these strings.
 *
 * THIS FILE IS THE SPECIFICATION; MIGRATIONS ARE THE IMPLEMENTATION.
 *
 * The `permissions` table is written ONLY by migrations. Migration 0020
 * created it and inserted this catalogue as a FROZEN literal — pinned to what
 * it said on the day that migration was written — and every change since is
 * its own migration. The application never writes a catalogue row, at boot or
 * at any other time.
 *
 * So EDITING THIS FILE IS HALF A CHANGE. Adding a code, retiring one,
 * relabelling one, moving one between groups or changing its risk all require
 * a matching migration, and `PermissionCatalogIntegrityService` REFUSES TO
 * START THE PROCESS if this file and the table disagree — naming every code
 * that differs and what to do about it. That is deliberate friction: these
 * rows decide who may void a sale, and a change to them should be reviewed
 * like a schema change rather than take effect because somebody restarted a
 * pod.
 *
 * Retiring a code is a migration setting `permissions.retiredAt`, NEVER a
 * DELETE: `role_permissions` cascades, so deleting the row would silently
 * strip the capability from every custom role that held it and leave no trace
 * it had been granted.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: anything a guard does not check. Every code
 * below is referenced by at least one `@RequirePermissions(...)` (or, for the
 * three surface codes, by audience eligibility) and
 * `rbac-coverage.int-spec.ts` fails the build if that stops being true.
 */

/** Ordered groups. The order IS the order the access-control screen renders. */
export const PERMISSION_GROUPS = [
  { key: 'surfaces', titleFa: 'ورود به سامانه‌ها' },
  { key: 'dashboard', titleFa: 'داشبورد' },
  { key: 'products', titleFa: 'کالاها' },
  { key: 'categories', titleFa: 'دسته‌بندی‌ها' },
  { key: 'attributes', titleFa: 'ویژگی‌ها' },
  { key: 'inventory', titleFa: 'موجودی' },
  { key: 'orders', titleFa: 'سفارش‌ها' },
  { key: 'reconciliation', titleFa: 'مغایرت پرداخت' },
  { key: 'reports', titleFa: 'گزارش‌ها' },
  { key: 'users', titleFa: 'کاربران و کارکنان' },
  { key: 'branches', titleFa: 'شعبه‌ها' },
  { key: 'access', titleFa: 'کنترل دسترسی' },
] as const;

export type PermissionGroupKey = (typeof PERMISSION_GROUPS)[number]['key'];

/**
 * How loudly the confirmation dialog has to speak before this is granted.
 *
 *  - `normal`    reads, and writes that only move catalogue metadata around;
 *  - `sensitive` touches customer data, physical stock, or who may sign in;
 *  - `critical`  moves money, reverses a completed sale, or edits the
 *                authorisation model itself. The UI requires a typed
 *                confirmation for these.
 */
export type PermissionRisk = 'normal' | 'sensitive' | 'critical';

export interface PermissionSpec {
  readonly code: string;
  readonly groupKey: PermissionGroupKey;
  /** What an administrator reads in the role editor. Never the code. */
  readonly labelFa: string;
  /**
   * The consequence sentence. Shown under the label, and again inside the
   * confirmation dialog when the permission is granted, so "this role will be
   * able to …" is a property of the catalogue rather than of one screen.
   */
  readonly descriptionFa: string;
  readonly risk: PermissionRisk;
}

/*
 * `as const` + `satisfies`, NOT `: readonly PermissionSpec[]`.
 *
 * The annotation widened every `code` to `string`, which is why a typo in
 * `@RequirePermissions('prodcuts.read')` was only ever caught at RUNTIME, by an
 * integration test that had to enumerate the container to find it. Keeping the
 * literals lets {@link PermissionCode} be a real union, so the same typo is a
 * compile error in the file that made it.
 *
 * `satisfies` still checks every entry against `PermissionSpec` — nothing is
 * loosened, the shape is simply verified without being erased.
 */
export const PERMISSION_CATALOG = Object.freeze([
  // --- surfaces ----------------------------------------------------------
  //
  // These three are the DOOR, not a capability behind it. They are checked by
  // `AuthService.assertEligible` BEFORE any token is minted — never by a route
  // guard alone, because issuing a valid admin cookie to somebody who may not
  // administer and then refusing each request one at a time still puts a
  // working admin session in their browser. See `audience.ts`.
  {
    code: 'admin.access',
    groupKey: 'surfaces',
    labelFa: 'ورود به پنل مدیریت',
    descriptionFa:
      'این نقش می‌تواند وارد پنل مدیریت شود. بدون این دسترسی، حتی با داشتن سایر اختیارات، ورود به پنل مدیریت ممکن نیست.',
    risk: 'sensitive',
  },
  {
    code: 'pos.access',
    groupKey: 'surfaces',
    labelFa: 'ورود به صندوق فروشگاه',
    descriptionFa:
      'این نقش می‌تواند وارد نرم‌افزار صندوق (POS) شود و کاتالوگ کالاها را ببیند.',
    risk: 'normal',
  },
  {
    code: 'storefront.access',
    groupKey: 'surfaces',
    labelFa: 'ورود به فروشگاه اینترنتی (مشتری)',
    descriptionFa:
      'دسترسی حساب مشتری در فروشگاه اینترنتی. این یک دسترسی مشتری است، نه یک اختیار مدیریتی.',
    risk: 'normal',
  },

  // --- dashboard ---------------------------------------------------------
  {
    code: 'dashboard.read',
    groupKey: 'dashboard',
    labelFa: 'مشاهدهٔ داشبورد',
    descriptionFa:
      'مشاهدهٔ خلاصهٔ فروش امروز، سفارش‌های در انتظار، هشدارهای موجودی و پرونده‌های باز.',
    risk: 'sensitive',
  },

  // --- products ----------------------------------------------------------
  {
    code: 'products.read',
    groupKey: 'products',
    labelFa: 'مشاهدهٔ کالاها',
    descriptionFa:
      'دیدن فهرست کالاها، گونه‌ها (Variant)، کد کالا (SKU) و قیمت‌ها در پنل مدیریت.',
    risk: 'normal',
  },
  {
    code: 'products.create',
    groupKey: 'products',
    labelFa: 'ایجاد کالا',
    descriptionFa: 'افزودن کالای جدید همراه با گونه‌ها، قیمت و دسته‌بندی.',
    risk: 'normal',
  },
  {
    code: 'products.update',
    groupKey: 'products',
    labelFa: 'ویرایش کالا',
    descriptionFa:
      'تغییر عنوان، توضیحات، قیمت پایه، دسته‌بندی، تصاویر و گونه‌های کالا. موجودی از این مسیر تغییر نمی‌کند.',
    risk: 'normal',
  },
  {
    code: 'products.activate',
    groupKey: 'products',
    labelFa: 'فعال‌کردن گونهٔ کالا',
    descriptionFa:
      'بازگرداندن یک گونهٔ بازنشسته به فروش. کالا دوباره در سایت و صندوق قابل فروش می‌شود.',
    risk: 'normal',
  },
  {
    code: 'products.deactivate',
    groupKey: 'products',
    labelFa: 'غیرفعال‌کردن گونهٔ کالا',
    descriptionFa:
      'خارج‌کردن یک گونه از فروش در سایت و صندوق. سابقهٔ سفارش‌های گذشته دست‌نخورده می‌ماند.',
    risk: 'sensitive',
  },

  // --- categories --------------------------------------------------------
  {
    code: 'categories.read',
    groupKey: 'categories',
    labelFa: 'مشاهدهٔ دسته‌بندی‌ها',
    descriptionFa: 'دیدن فهرست دسته‌بندی‌ها و تعداد کالای هر دسته.',
    risk: 'normal',
  },
  {
    code: 'categories.create',
    groupKey: 'categories',
    labelFa: 'ایجاد دسته‌بندی',
    descriptionFa: 'افزودن دسته‌بندی تازه به کاتالوگ.',
    risk: 'normal',
  },
  {
    code: 'categories.update',
    groupKey: 'categories',
    labelFa: 'تغییر نام دسته‌بندی',
    descriptionFa: 'تغییر عنوان یک دسته‌بندی موجود.',
    risk: 'normal',
  },
  {
    code: 'categories.delete',
    groupKey: 'categories',
    labelFa: 'حذف دسته‌بندی',
    descriptionFa:
      'حذف دسته‌بندی‌ای که هیچ کالایی در آن نیست. دسته‌بندی دارای کالا حذف نمی‌شود.',
    risk: 'sensitive',
  },

  // --- attributes --------------------------------------------------------
  {
    code: 'attributes.read',
    groupKey: 'attributes',
    labelFa: 'مشاهدهٔ ویژگی‌ها',
    descriptionFa:
      'دیدن ویژگی‌ها (مانند رنگ، سایز، ظرفیت) و مقادیر آن‌ها به همراه تعداد گونه‌های استفاده‌کننده.',
    risk: 'normal',
  },
  {
    code: 'attributes.create',
    groupKey: 'attributes',
    labelFa: 'ایجاد ویژگی یا مقدار',
    descriptionFa: 'افزودن ویژگی تازه یا افزودن مقدار تازه به یک ویژگی موجود.',
    risk: 'normal',
  },
  {
    code: 'attributes.update',
    groupKey: 'attributes',
    labelFa: 'تغییر نام ویژگی یا مقدار',
    descriptionFa:
      'تغییر نام یک ویژگی یا یکی از مقادیر آن. نام‌های ثبت‌شده روی سفارش‌های گذشته تغییر نمی‌کند.',
    risk: 'normal',
  },
  {
    code: 'attributes.delete',
    groupKey: 'attributes',
    labelFa: 'حذف ویژگی یا مقدار',
    descriptionFa:
      'حذف ویژگی یا مقداری که هیچ گونه‌ای از آن استفاده نمی‌کند. موارد در حال استفاده حذف نمی‌شوند.',
    risk: 'sensitive',
  },

  // --- inventory ---------------------------------------------------------
  {
    code: 'inventory.read',
    groupKey: 'inventory',
    labelFa: 'مشاهدهٔ موجودی',
    descriptionFa:
      'دیدن موجودی فیزیکی، رزرو سبد خرید، تخصیص سفارش و موجودی قابل فروش در سایت و صندوق.',
    risk: 'normal',
  },
  {
    code: 'inventory.adjust',
    groupKey: 'inventory',
    labelFa: 'اصلاح موجودی انبار',
    descriptionFa:
      'این نقش می‌تواند موجودی فیزیکی انبار را کم یا زیاد کند. هر اصلاح با ذکر دلیل و نام انجام‌دهنده در دفتر موجودی ثبت می‌شود و قابل حذف نیست.',
    risk: 'critical',
  },
  {
    code: 'inventory.movements.read',
    groupKey: 'inventory',
    labelFa: 'مشاهدهٔ تاریخچهٔ گردش موجودی',
    descriptionFa:
      'دیدن دفتر گردش موجودی: هر کم و زیاد شدن، دلیل آن، انجام‌دهنده و سفارش مرتبط.',
    risk: 'normal',
  },

  // --- orders ------------------------------------------------------------
  {
    code: 'orders.read',
    groupKey: 'orders',
    labelFa: 'مشاهدهٔ سفارش‌ها',
    descriptionFa:
      'این نقش می‌تواند اطلاعات سفارش مشتریان را ببیند؛ شامل اقلام، مبلغ، نشانی تحویل و شمارهٔ تماس گیرنده.',
    risk: 'sensitive',
  },
  {
    code: 'orders.status.update',
    groupKey: 'orders',
    labelFa: 'تغییر وضعیت سفارش',
    descriptionFa:
      'این نقش می‌تواند وضعیت سفارش را جلو ببرد (مثلاً «در حال آماده‌سازی» یا «ارسال‌شده»). این کار پول یا موجودی را جابه‌جا نمی‌کند.',
    risk: 'sensitive',
  },
  {
    code: 'orders.void',
    groupKey: 'orders',
    labelFa: 'ابطال سفارش',
    descriptionFa:
      'این نقش می‌تواند یک فروش ثبت‌شده را باطل کند. کالاها به موجودی برمی‌گردند و فروش از گزارش کسر می‌شود. این کار برگشت‌ناپذیر است.',
    risk: 'critical',
  },
  {
    code: 'orders.return',
    groupKey: 'orders',
    labelFa: 'ثبت مرجوعی سفارش',
    descriptionFa:
      'این نقش می‌تواند یک فروش پرداخت‌شده را مرجوع کند. کالاها به موجودی برمی‌گردند و مبلغ در گزارش به‌عنوان بازپرداخت ثبت می‌شود. این کار برگشت‌ناپذیر است.',
    risk: 'critical',
  },
  {
    code: 'orders.actions.read',
    groupKey: 'orders',
    labelFa: 'مشاهدهٔ تاریخچهٔ اقدام‌های سفارش',
    descriptionFa:
      'دیدن اینکه چه کسی، چه زمانی و با چه دلیلی وضعیت سفارش را تغییر داده، آن را باطل یا مرجوع کرده است.',
    risk: 'normal',
  },

  // --- reconciliation ----------------------------------------------------
  {
    code: 'reconciliation.read',
    groupKey: 'reconciliation',
    labelFa: 'مشاهدهٔ پرونده‌های مغایرت پرداخت',
    descriptionFa:
      'دیدن سفارش‌هایی که پول مشتری دریافت شده ولی سفارش کامل نشده، یا مشکل موجودی دارند.',
    risk: 'sensitive',
  },
  {
    code: 'reconciliation.act',
    groupKey: 'reconciliation',
    labelFa: 'اقدام روی پروندهٔ مغایرت',
    descriptionFa:
      'این نقش می‌تواند روی پروندهٔ مغایرت اقدام ثبت کند: تلاش دوباره برای تکمیل موجودی، ثبت نیاز به بازپرداخت، تأیید بازپرداخت انجام‌شده در درگاه، یا بستن پرونده. هیچ‌کدام از این اقدام‌ها به‌تنهایی پولی جابه‌جا نمی‌کند.',
    risk: 'critical',
  },

  /*
   * --- reports ----------------------------------------------------------
   *
   * THERE IS DELIBERATELY NO REPORTS CAPABILITY IN THIS CATALOGUE.
   *
   * `reports.read` used to live here. It was RETIRED by migration 0028,
   * because a capability code is the wrong instrument for the owner's rule:
   *
   *   "Sales reports are available only to the main administrator,
   *    represented by the built-in `super_admin` role."
   *
   * A catalogue code exists precisely so that it can be delegated to a custom
   * role. Publishing one for sales reporting and then asking every reader to
   * remember never to grant it is a rule enforced by convention, and the
   * convention had already broken: a delegated "accountant" role was being
   * created and tested against.
   *
   * `ReportsController` is therefore gated on the ROLE — `@Roles(superAdmin)`
   * plus `@Audiences('admin')` — and `ReportsService` re-asserts it as
   * defence in depth. No permission string participates, so no grant, no
   * stale `role_permissions` row and no request body can confer it.
   *
   * WHY RETIRED AND NOT DELETED: see migration 0028. A retired row keeps its
   * grants for audit while `PermissionService.resolveEffective` filters it out
   * of every effective set, so the retirement is reversible and the history is
   * not rewritten.
   *
   * The `reports` GROUP is intentionally left in `PERMISSION_GROUPS`: it
   * carries no codes, renders as nothing in the RBAC editor, and removing it
   * would be a second, unrelated change to a list that migrations do not own.
   */

  // --- users -------------------------------------------------------------
  {
    code: 'users.read',
    groupKey: 'users',
    labelFa: 'مشاهدهٔ کاربران',
    descriptionFa:
      'دیدن فهرست کارکنان و مشتریان، نقش‌ها، شعبه و وضعیت فعال یا غیرفعال بودن آن‌ها.',
    risk: 'sensitive',
  },
  {
    code: 'users.create',
    groupKey: 'users',
    labelFa: 'ایجاد کاربر',
    descriptionFa:
      'ساخت حساب کاربری تازه برای کارکنان، همراه با نام کاربری، گذرواژه، نقش و شعبه.',
    risk: 'sensitive',
  },
  {
    code: 'users.update',
    groupKey: 'users',
    labelFa: 'ویرایش کاربر',
    descriptionFa:
      'تغییر نام کاربری، شمارهٔ همراه و شعبهٔ یک کاربر. تغییر نقش‌ها دسترسی جداگانه‌ای دارد.',
    risk: 'sensitive',
  },
  {
    code: 'users.activate',
    groupKey: 'users',
    labelFa: 'فعال‌کردن کاربر',
    descriptionFa: 'بازگرداندن امکان ورود به یک حساب غیرفعال‌شده.',
    risk: 'sensitive',
  },
  {
    code: 'users.deactivate',
    groupKey: 'users',
    labelFa: 'غیرفعال‌کردن کاربر',
    descriptionFa:
      'این نقش می‌تواند ورود یک کاربر را قطع کند. نشست‌های باز آن کاربر در همهٔ سامانه‌ها بلافاصله از کار می‌افتد.',
    risk: 'critical',
  },
  {
    code: 'users.sessions.revoke',
    groupKey: 'users',
    labelFa: 'قطع نشست‌های کاربر',
    descriptionFa:
      'خروج اجباری یک کاربر از همهٔ دستگاه‌ها و همهٔ سامانه‌ها. حساب کاربر غیرفعال نمی‌شود.',
    risk: 'sensitive',
  },
  {
    code: 'users.password.reset',
    groupKey: 'users',
    labelFa: 'تعیین گذرواژهٔ موقت',
    descriptionFa:
      'این نقش می‌تواند برای یک کاربر گذرواژهٔ موقت تعیین کند. تمام نشست‌های آن کاربر قطع می‌شود و در ورود بعدی باید گذرواژه را تغییر دهد. گذرواژهٔ فعلی هیچ‌گاه نمایش داده نمی‌شود.',
    risk: 'critical',
  },

  // --- branches ----------------------------------------------------------
  {
    code: 'branches.read',
    groupKey: 'branches',
    labelFa: 'مشاهدهٔ شعبه‌ها',
    descriptionFa: 'دیدن فهرست شعبه‌ها، نشانی، تلفن و صندوق‌داران هر شعبه.',
    risk: 'normal',
  },
  {
    code: 'branches.create',
    groupKey: 'branches',
    labelFa: 'ایجاد شعبه',
    descriptionFa: 'افزودن شعبهٔ تازه.',
    risk: 'normal',
  },
  {
    code: 'branches.update',
    groupKey: 'branches',
    labelFa: 'ویرایش شعبه',
    descriptionFa:
      'تغییر نام، نشانی و تلفن شعبه. نام ثبت‌شده روی سفارش‌های گذشته تغییر نمی‌کند.',
    risk: 'normal',
  },
  {
    code: 'branches.activate',
    groupKey: 'branches',
    labelFa: 'فعال‌کردن شعبه',
    descriptionFa: 'بازگرداندن شعبه به چرخهٔ فروش.',
    risk: 'sensitive',
  },
  {
    code: 'branches.deactivate',
    groupKey: 'branches',
    labelFa: 'غیرفعال‌کردن شعبه',
    descriptionFa:
      'این نقش می‌تواند یک شعبه را از چرخهٔ فروش خارج کند. صندوق‌داران آن شعبه دیگر نمی‌توانند فروش ثبت کنند.',
    risk: 'critical',
  },

  // --- access control ----------------------------------------------------
  {
    code: 'rbac.read',
    groupKey: 'access',
    labelFa: 'مشاهدهٔ نقش‌ها و دسترسی‌ها',
    descriptionFa: 'دیدن فهرست نقش‌ها و اختیارات هر نقش.',
    risk: 'sensitive',
  },
  {
    code: 'rbac.manage',
    groupKey: 'access',
    labelFa: 'مدیریت نقش‌ها و دسترسی‌ها',
    descriptionFa:
      'این نقش می‌تواند نقش بسازد، اختیارات نقش‌ها را تغییر دهد و نقش کاربران را عوض کند. هر کسی که این دسترسی را داشته باشد می‌تواند اختیارات خودش و دیگران را تغییر دهد.',
    risk: 'critical',
  },
  {
    code: 'audit.read',
    groupKey: 'access',
    labelFa: 'مشاهدهٔ دفتر رخدادهای مدیریتی',
    descriptionFa:
      'دیدن اینکه چه کسی چه تغییری در نقش‌ها، کاربران، شعبه‌ها، موجودی و سفارش‌ها داده است.',
    risk: 'sensitive',
  },

  // --- POS ---------------------------------------------------------------
  {
    code: 'pos.sell',
    groupKey: 'surfaces',
    labelFa: 'ثبت فروش در صندوق',
    descriptionFa:
      'این نقش می‌تواند در صندوق فروش ثبت کند. هر فروش موجودی فیزیکی را کم می‌کند و به نام همین کاربر و شعبهٔ او ثبت می‌شود.',
    risk: 'sensitive',
  },
  {
    code: 'pos.receipt.read_own',
    groupKey: 'surfaces',
    labelFa: 'مشاهدهٔ رسید فروش‌های خود',
    descriptionFa:
      'دیدن رسید فروش‌هایی که خودِ این کاربر ثبت کرده است — و نه فروش دیگران.',
    risk: 'normal',
  },
] as const) satisfies readonly PermissionSpec[];

/**
 * EVERY PERMISSION CODE, AS A TYPE.
 *
 * This is what makes `@RequirePermissions`, `@ConsultsPermissions`,
 * `assertPermission` and `hasPermission` typed rather than stringly-typed: a
 * code that is not in the catalogue above does not compile, anywhere, so the
 * class of bug where a guard silently requires a permission nobody can ever
 * hold is unrepresentable rather than merely tested for.
 *
 * It is derived from the catalogue, never written out beside it — a
 * hand-maintained second list is exactly the kind of thing that drifts.
 */
export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

/** Every code, as a `Set`, for O(1) membership checks. */
export const PERMISSION_CODES: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.map((permission) => permission.code),
);

export function isPermissionCode(value: unknown): value is PermissionCode {
  return typeof value === 'string' && PERMISSION_CODES.has(value);
}

export function permissionSpec(code: string): PermissionSpec | undefined {
  return PERMISSION_CATALOG.find((permission) => permission.code === code);
}

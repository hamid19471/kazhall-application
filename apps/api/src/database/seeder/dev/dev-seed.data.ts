import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

/**
 * The review dataset, as data.
 *
 * Everything here is a literal. There is no `Math.random()`, no `Date.now()`
 * and no counter that depends on insertion order, because the seed's contract
 * is that running it twice changes nothing — and a value that differs between
 * runs cannot be matched against an existing row.
 *
 * Every collection below carries a NATURAL KEY (a role name, a branch name, a
 * username, a category title, an attribute name, a SKU, an order number). The
 * seeder matches on that key, never on an auto-increment id, which is what
 * makes a re-run an update-or-skip instead of a duplicate.
 */

/** Marks every row this seeder owns, so the reset command can find them. */
export const DEV_SEED_TAG = 'kazhal-dev-seed';

/**
 * One password for every review account.
 *
 * DEVELOPMENT / REVIEW ONLY — NEVER USE IN PRODUCTION. It is hashed with the
 * same bcrypt cost the production path uses (`UserService.create`), is never
 * written to a column in plaintext, and is never logged by the application at
 * boot. It is printed exactly once, by the seed command's own report.
 *
 * `LoginDto` bounds passwords to 8..64 characters; this is 14.
 */
export const DEV_PASSWORD = 'Kazhal!Dev2026';

/**
 * `LoginDto` enforces `/^[a-zA-Z0-9_]+$/` on usernames — a dot is a 400, not a
 * login. Underscores only, therefore, and a `dev_` prefix so no review account
 * can be mistaken for a real one.
 */
export interface SeedUserSpec {
  username: string;
  mobile: string;
  role: UserRoleEnum;
  /** Branch NAME, resolved to an id at seed time. `null` = no branch. */
  branch: string | null;
  deactivated: boolean;
  /** Shown in the credential report; not stored. */
  purpose: string;
  displayName: string;
}

export const SEED_BRANCH_MAIN = 'فروشگاه مرکزی کژال — سنندج';
export const SEED_BRANCH_SECONDARY = 'شعبه کژال — مریوان';
export const SEED_BRANCH_WAREHOUSE = 'انبار مرکزی و سفارش‌های اینترنتی کژال';

export interface SeedBranchSpec {
  name: string;
  address: string;
  phone: string;
}

/**
 * `branches` has exactly three meaningful columns: `name`, `address`, `phone`.
 * There is NO branch type/kind column, so "warehouse" and "shop" are not
 * distinguishable to the schema — the third branch below is a real branch row
 * whose ROLE is conveyed only by its name. Nothing in the API treats it
 * differently. See the limitations section of the seed report.
 */
export const SEED_BRANCHES: SeedBranchSpec[] = [
  {
    name: SEED_BRANCH_MAIN,
    address: 'سنندج، خیابان پاسداران، نبش کوچه شهید بهشتی، پلاک ۱۲۴',
    phone: '08733245610',
  },
  {
    name: SEED_BRANCH_SECONDARY,
    address: 'مریوان، بلوار کردستان، روبه‌روی پارک شهر، پلاک ۴۷',
    phone: '08734523398',
  },
  {
    name: SEED_BRANCH_WAREHOUSE,
    address: 'سنندج، شهرک صنعتی شماره ۲، انبار شماره ۹',
    phone: '08733901177',
  },
];

export const SEED_USERS: SeedUserSpec[] = [
  {
    username: 'dev_superadmin',
    mobile: '09000000001',
    role: UserRoleEnum.superAdmin,
    branch: SEED_BRANCH_MAIN,
    deactivated: false,
    displayName: 'مدیر ارشد توسعه',
    purpose:
      'Primary super admin — full admin, reports, reconciliation, and POS (has a branch).',
  },
  {
    username: 'dev_admin_nobranch',
    mobile: '09000000002',
    role: UserRoleEnum.superAdmin,
    branch: null,
    deactivated: false,
    displayName: 'مدیر بدون شعبه',
    purpose:
      'Branchless super admin — proves administration and reports work while POS selling is refused.',
  },
  {
    username: 'dev_cashier1',
    mobile: '09000000003',
    role: UserRoleEnum.sale,
    branch: SEED_BRANCH_MAIN,
    deactivated: false,
    displayName: 'صندوق‌دار یکم — مرکزی',
    purpose:
      'Main-branch cashier 1 — POS selling, branch-scoped orders and reports.',
  },
  {
    username: 'dev_cashier2',
    mobile: '09000000004',
    role: UserRoleEnum.sale,
    branch: SEED_BRANCH_MAIN,
    deactivated: false,
    displayName: 'صندوق‌دار دوم — مرکزی',
    purpose:
      'Main-branch cashier 2 — second seller in the same branch, and the reversal actor for cashier 1 sales.',
  },
  {
    username: 'dev_cashier_marivan',
    mobile: '09000000005',
    role: UserRoleEnum.sale,
    branch: SEED_BRANCH_SECONDARY,
    deactivated: false,
    displayName: 'صندوق‌دار مریوان',
    purpose:
      'Secondary-branch cashier — proves branch scoping hides main-branch orders.',
  },
  {
    username: 'dev_customer1',
    mobile: '09000000006',
    role: UserRoleEnum.site,
    branch: null,
    deactivated: false,
    displayName: 'مشتری آزمایشی یکم',
    purpose:
      'Customer 1 — active cart with basket reservations, addresses, online orders.',
  },
  {
    username: 'dev_customer2',
    mobile: '09000000007',
    role: UserRoleEnum.site,
    branch: null,
    deactivated: false,
    displayName: 'مشتری آزمایشی دوم',
    purpose:
      'Customer 2 — separate addresses and orders; proves cross-customer isolation.',
  },
  {
    username: 'dev_disabled',
    mobile: '09000000008',
    role: UserRoleEnum.sale,
    branch: SEED_BRANCH_MAIN,
    deactivated: true,
    displayName: 'کاربر غیرفعال',
    purpose:
      'Deactivated user — every request must fail 401 ACCOUNT_DEACTIVATED.',
  },
];

/**
 * `categories` has `id` and `title` and nothing else — no slug, no parent, no
 * ordering column. The list below is therefore FLAT by necessity, not by
 * choice: the hierarchy the brief asks for cannot be expressed without a
 * schema change, and inventing a parent column here would be faking the model.
 * Title is the natural key.
 */
export const SEED_CATEGORIES: string[] = [
  'کوهنوردی',
  'کمپینگ',
  'شکار',
  'ماهیگیری',
  'آفرود',
  'پوشاک فضای باز',
  'کفش و تجهیزات پیمایش',
  'روشنایی',
  'پخت‌وپز سفری',
  'خواب و استراحت',
  'کوله‌پشتی و حمل تجهیزات',
  'ابزار و لوازم جانبی',
];

export interface SeedAttributeSpec {
  name: string;
  values: string[];
}

export const SEED_ATTRIBUTES: SeedAttributeSpec[] = [
  {
    name: 'رنگ',
    values: ['مشکی', 'سرمه‌ای', 'زیتونی', 'نارنجی', 'قرمز', 'خاکستری'],
  },
  {
    name: 'سایز',
    values: ['اسمال', 'مدیوم', 'لارج', 'ایکس‌لارج', '۴۰', '۴۲', '۴۴'],
  },
  {
    name: 'ظرفیت',
    values: [
      '۱ نفره',
      '۲ نفره',
      '۳ نفره',
      '۴ نفره',
      '۳۰ لیتر',
      '۵۰ لیتر',
      '۷۰ لیتر',
    ],
  },
  { name: 'وزن', values: ['سبک', 'متوسط', 'سنگین'] },
  {
    name: 'جنس',
    values: [
      'نایلون ریپ‌استاپ',
      'پلی‌استر',
      'گورتکس',
      'آلومینیوم',
      'استیل',
      'پنبه',
    ],
  },
];

export interface SeedVariantSpec {
  sku: string;
  /**
   * «کد گونه» (migration 0031). FIXED AND HAND-WRITTEN, exactly like every
   * other value in this file, and it must begin with its parent's
   * `productCode` followed by a hyphen — see {@link SeedProductSpec.productCode}
   * for why the generator is not used and why the 9xxxxx block was chosen.
   *
   * DISTINCT FROM `sku`: the SKU is the warehouse's string, this is the
   * store's own identifier. Neither is derived from the other.
   */
  variantCode: string;
  /**
   * Integer Rial. `null` means "inherit the product's basePrice" and is used
   * ONLY on the two products that deliberately exercise that path. Zero is
   * never used as an inheritance signal — a zero price is a free product.
   */
  price: number | null;
  stock: number;
  isActive: boolean;
  isDefault: boolean;
  /** `[attributeName, value]` pairs; both must exist in SEED_ATTRIBUTES. */
  attrs: Array<[string, string]>;
}

export interface SeedProductSpec {
  title: string;
  description: string;
  /** Integer Rial, or `null` when every variant prices itself. */
  basePrice: number | null;
  /**
   * «کد محصول» (migration 0031). FIXED, EXPLICIT AND HAND-WRITTEN.
   *
   * THE GENERATOR IS NOT USED BY THE SEED, deliberately. `ProductCodeAllocator`
   * draws from `product_code_seq`, and `nextval` advances whether or not the
   * transaction commits — so a generated code would differ between the first
   * run and the second, and the seed's whole contract is that running it twice
   * produces identical rows. A code that changes on a re-run cannot be matched
   * against the row it already created.
   *
   * WHY THE 9xxxxx BLOCK. Generated codes are `KZ-P-` + the sequence value,
   * and migration 0031 sets that sequence to max(product id) + 1 — so a freshly
   * seeded database hands out `KZ-P-000028` next and counts upward. Parking the
   * seed's own codes at `KZ-P-900001`+ keeps the generated FORMAT (so nothing
   * downstream sees a special case) while putting them ~900 000 allocations out
   * of the generator's reach, which is what makes a hand-written code and a
   * generated one unable to collide in a review database.
   */
  productCode: string;
  /**
   * WEBSITE CHANNEL (migration 0030) — one of the two INDEPENDENT dimensions.
   * `true` means the storefront lists it; it says nothing about any till.
   */
  visibleOnSite: boolean;
  /**
   * RETAIL CHANNEL (migration 0030) — the other dimension.
   *
   *   'none'      no till sells it
   *   'all'       every branch sells it, including ones created later
   *   'selected'  only the branches named in {@link branchNames}
   *
   * THIS IS VISIBILITY, NOT INVENTORY. Stock stays a single global number on
   * `product_variants.stock`; selecting branches decides WHERE a product may be
   * sold from, never how much of it each branch has.
   */
  branchVisibility: 'none' | 'all' | 'selected';
  /**
   * The selected branches, BY NAME. Required (non-empty) when
   * `branchVisibility` is `'selected'`, and forbidden otherwise — the
   * deferrable constraint trigger refuses both mistakes at COMMIT, and
   * `seedProducts` refuses them earlier with a sentence naming the product.
   *
   * NAMES, not ids, for the same reason every other collection here carries a
   * natural key: ids are assigned by the database and are not stable across a
   * reset, so the seeder resolves a name through `ctx.branchIds` at write time.
   */
  branchNames?: string[];
  categories: string[];
  variants: SeedVariantSpec[];
  /** Why this product exists in the dataset — surfaced in the seed report. */
  note?: string;
}

const RIAL = 1; // prices below are already integer Rial; named for readability

/**
 * 27 products. The mix is deliberate — between them they cover a default-only
 * variant, multi-variant products, variant-specific pricing, base-price
 * inheritance, an all-inactive product, out-of-stock, low stock, and deep
 * stock for concurrency and cart testing.
 *
 * `products` has NO `isActive` column — only `product_variants` does. An
 * "inactive product" is therefore a product whose every variant is inactive,
 * which is the only way the schema can express it.
 *
 * ---------------------------------------------------------------------------
 * CHANNEL VISIBILITY — all six owner cases, one product each
 * ---------------------------------------------------------------------------
 * `visibleOnSite` and `branchVisibility` are two independent dimensions, so the
 * six cases are their product rather than six values of one field. Each one is
 * demonstrated by exactly one product below and named in that product's `note`;
 * every OTHER product is `true` / `'all'` so the existing review flows — the
 * storefront listing, the POS catalogue at both branches, the carts and the
 * seeded sales — keep working unchanged.
 *
 *   website only              چادر خانوادگی ۴ نفره مدل دشت   KZ-P-900002
 *   all retail branches only  کفش کوهنوردی ساق‌بلند ضدآب      KZ-P-900016
 *   selected branches only    طناب دینامیک ۵۰ متری            KZ-P-900019  (مرکزی)
 *   website + all branches    every other product
 *   website + selected        کوله روزانه ۳۰ لیتری سیروان     KZ-P-900004  (مریوان)
 *   hidden / draft            چادر سقفی خودرو (بازنشسته)      KZ-P-900027
 *
 * THE TWO `selected` PRODUCTS POINT AT DIFFERENT BRANCHES ON PURPOSE, so
 * branch filtering is provable in both directions with the accounts this file
 * already creates: `dev_cashier1`/`dev_cashier2` sit in the main branch and
 * `dev_cashier_marivan` in the secondary one, so KZ-P-900019 must appear for
 * the first two and NOT for the third, and KZ-P-900004 exactly the other way
 * round. A single one-directional example proves only half the rule.
 *
 * NOTHING SOLD OR HELD ELSEWHERE IN THIS FILE IS GIVEN A SPECIAL CASE. The
 * five products above appear in no seeded order and no seeded cart line, so
 * the seeded history can never contradict the visibility rules — a POS sale
 * from a branch that the catalogue says cannot sell the product would be a
 * dataset that the running application could not have produced.
 *
 * AND THIS IS STILL NOT INVENTORY: stock is global, and a branch selection
 * decides only where a product may be sold from.
 */
export const SEED_PRODUCTS: SeedProductSpec[] = [
  {
    title: 'چادر کوهنوردی ۲ نفره مدل قله',
    description:
      'چادر دو پوش سبک با اسکلت آلومینیومی، مناسب سه فصل و پیمایش‌های کوهستانی.',
    basePrice: null,
    productCode: 'KZ-P-900001',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['کوهنوردی', 'کمپینگ'],
    variants: [
      {
        sku: 'KZ-TNT-001-2P-GRN',
        variantCode: 'KZ-P-900001-V000001',
        price: 128_500_000 * RIAL,
        stock: 24,
        isActive: true,
        isDefault: true,
        attrs: [
          ['ظرفیت', '۲ نفره'],
          ['رنگ', 'زیتونی'],
        ],
      },
      {
        sku: 'KZ-TNT-001-2P-ORG',
        variantCode: 'KZ-P-900001-V000002',
        price: 132_000_000 * RIAL,
        stock: 11,
        isActive: true,
        isDefault: false,
        attrs: [
          ['ظرفیت', '۲ نفره'],
          ['رنگ', 'نارنجی'],
        ],
      },
    ],
    note: 'multi-variant, variant-specific prices, healthy stock',
  },
  {
    title: 'چادر خانوادگی ۴ نفره مدل دشت',
    description:
      'چادر جادار خانوادگی با سایبان جلو و کف ضدآب، مناسب کمپ‌های تابستانی.',
    basePrice: null,
    productCode: 'KZ-P-900002',
    visibleOnSite: true,
    branchVisibility: 'none',
    categories: ['کمپینگ'],
    variants: [
      {
        sku: 'KZ-TNT-002-4P-GRY',
        variantCode: 'KZ-P-900002-V000001',
        price: 219_000_000 * RIAL,
        stock: 40,
        isActive: true,
        isDefault: true,
        attrs: [
          ['ظرفیت', '۴ نفره'],
          ['رنگ', 'خاکستری'],
        ],
      },
    ],
    note:
      'VISIBILITY CASE — WEBSITE ONLY (visibleOnSite=true, branchVisibility=none). ' +
      'Too bulky to keep on a shop floor, so it is an online-only line: it must ' +
      'appear in the storefront listing and in NO till catalogue, at either branch. ' +
      'Deep stock, so it still serves the concurrency and cart tests.',
  },
  {
    title: 'کوله‌پشتی کوهنوردی ۵۰ لیتری مدل آروند',
    description: 'کوله ۵۰ لیتری با سیستم تهویه پشت، کمربند باربر و روکش باران.',
    basePrice: null,
    productCode: 'KZ-P-900003',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['کوله‌پشتی و حمل تجهیزات', 'کوهنوردی'],
    variants: [
      {
        sku: 'KZ-BKP-010-50L-BLK',
        variantCode: 'KZ-P-900003-V000001',
        price: 87_500_000 * RIAL,
        stock: 18,
        isActive: true,
        isDefault: true,
        attrs: [
          ['ظرفیت', '۵۰ لیتر'],
          ['رنگ', 'مشکی'],
        ],
      },
      {
        sku: 'KZ-BKP-010-50L-NVY',
        variantCode: 'KZ-P-900003-V000002',
        price: 87_500_000 * RIAL,
        stock: 6,
        isActive: true,
        isDefault: false,
        attrs: [
          ['ظرفیت', '۵۰ لیتر'],
          ['رنگ', 'سرمه‌ای'],
        ],
      },
      {
        sku: 'KZ-BKP-010-70L-BLK',
        variantCode: 'KZ-P-900003-V000003',
        price: 104_000_000 * RIAL,
        stock: 0,
        isActive: true,
        isDefault: false,
        attrs: [
          ['ظرفیت', '۷۰ لیتر'],
          ['رنگ', 'مشکی'],
        ],
      },
    ],
    note: 'three variants: healthy / low stock / out of stock',
  },
  {
    title: 'کوله روزانه ۳۰ لیتری مدل سیروان',
    description:
      'کوله سبک روزانه برای پیمایش یک‌روزه با جیب بطری و محفظه لپ‌تاپ.',
    basePrice: 42_000_000 * RIAL,
    productCode: 'KZ-P-900004',
    visibleOnSite: true,
    branchVisibility: 'selected',
    branchNames: [SEED_BRANCH_SECONDARY],
    categories: ['کوله‌پشتی و حمل تجهیزات'],
    variants: [
      {
        sku: 'KZ-BKP-011-30L-STD',
        variantCode: 'KZ-P-900004-V000001',
        price: null,
        stock: 30,
        isActive: true,
        isDefault: true,
        attrs: [['ظرفیت', '۳۰ لیتر']],
      },
    ],
    note:
      'VISIBILITY CASE — WEBSITE + SELECTED BRANCHES (true, selected: مریوان). ' +
      'Stocked only at the Marivan shop, and also sold online: it must appear ' +
      'for `dev_cashier_marivan` and NOT for `dev_cashier1`/`dev_cashier2` in ' +
      'the main branch — the mirror image of KZ-P-900019. ' +
      'Also BASE-PRICE INHERITANCE — variant price is NULL on purpose.',
  },
  {
    title: 'کیسه خواب پر و پَر مدل زمستان',
    description: 'کیسه خواب مومیایی با عایق مصنوعی، دمای راحتی منفی ۵ درجه.',
    basePrice: null,
    productCode: 'KZ-P-900005',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['خواب و استراحت', 'کمپینگ'],
    variants: [
      {
        sku: 'KZ-SLP-020-M-NVY',
        variantCode: 'KZ-P-900005-V000001',
        price: 64_900_000 * RIAL,
        stock: 22,
        isActive: true,
        isDefault: true,
        attrs: [
          ['وزن', 'متوسط'],
          ['رنگ', 'سرمه‌ای'],
        ],
      },
      {
        sku: 'KZ-SLP-020-L-NVY',
        variantCode: 'KZ-P-900005-V000002',
        price: 71_500_000 * RIAL,
        stock: 3,
        isActive: true,
        isDefault: false,
        attrs: [
          ['وزن', 'سنگین'],
          ['رنگ', 'سرمه‌ای'],
        ],
      },
    ],
    note: 'low stock on the heavy variant',
  },
  {
    title: 'زیرانداز بادی خودمتورم',
    description: 'زیرانداز خودمتورم با ضخامت ۵ سانتی‌متر و کیف جمع‌کننده.',
    basePrice: null,
    productCode: 'KZ-P-900006',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['خواب و استراحت'],
    variants: [
      {
        sku: 'KZ-SLP-021-STD-GRN',
        variantCode: 'KZ-P-900006-V000001',
        price: 38_000_000 * RIAL,
        stock: 45,
        isActive: true,
        isDefault: true,
        attrs: [['رنگ', 'زیتونی']],
      },
    ],
  },
  {
    title: 'اجاق سفری تک‌شعله پیزو',
    description: 'اجاق گاز سفری کم‌مصرف با جرقه‌زن پیزو و پایه تاشو.',
    basePrice: null,
    productCode: 'KZ-P-900007',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پخت‌وپز سفری', 'کمپینگ'],
    variants: [
      {
        sku: 'KZ-CKS-030-STD',
        variantCode: 'KZ-P-900007-V000001',
        price: 19_800_000 * RIAL,
        stock: 60,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'استیل']],
      },
    ],
    note: 'deep stock — cheap line for POS basket tests',
  },
  {
    title: 'ست ظروف سفری آلومینیومی ۶ پارچه',
    description: 'ست قابلمه و ماهیتابه سبک سفری با کیف حمل.',
    basePrice: null,
    productCode: 'KZ-P-900008',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پخت‌وپز سفری'],
    variants: [
      {
        sku: 'KZ-CKS-031-6PC',
        variantCode: 'KZ-P-900008-V000001',
        price: 28_500_000 * RIAL,
        stock: 17,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'آلومینیوم']],
      },
    ],
  },
  {
    title: 'فلاسک استیل دوجداره ۱ لیتری',
    description: 'فلاسک دوجداره با نگهداری دما تا ۱۲ ساعت.',
    basePrice: null,
    productCode: 'KZ-P-900009',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پخت‌وپز سفری', 'ابزار و لوازم جانبی'],
    variants: [
      {
        sku: 'KZ-CKS-032-1L-SLV',
        variantCode: 'KZ-P-900009-V000001',
        price: 15_600_000 * RIAL,
        stock: 52,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'استیل']],
      },
    ],
  },
  {
    title: 'چراغ پیشانی ۴۰۰ لومن شارژی',
    description: 'هدلامپ شارژی با سه حالت نور و بدنه ضدآب.',
    basePrice: null,
    productCode: 'KZ-P-900010',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['روشنایی', 'کوهنوردی'],
    variants: [
      {
        sku: 'KZ-LGT-040-400L-BLK',
        variantCode: 'KZ-P-900010-V000001',
        price: 21_500_000 * RIAL,
        stock: 38,
        isActive: true,
        isDefault: true,
        attrs: [['رنگ', 'مشکی']],
      },
      {
        sku: 'KZ-LGT-040-400L-RED',
        variantCode: 'KZ-P-900010-V000002',
        price: 21_500_000 * RIAL,
        stock: 2,
        isActive: true,
        isDefault: false,
        attrs: [['رنگ', 'قرمز']],
      },
    ],
    note: 'low stock on the red variant',
  },
  {
    title: 'فانوس کمپ LED قابل شارژ',
    description: 'فانوس کمپینگ با نور گرم و پاوربانک داخلی.',
    basePrice: null,
    productCode: 'KZ-P-900011',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['روشنایی', 'کمپینگ'],
    variants: [
      {
        sku: 'KZ-LGT-041-STD',
        variantCode: 'KZ-P-900011-V000001',
        price: 17_900_000 * RIAL,
        stock: 29,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
  },
  {
    title: 'چراغ قوه تاکتیکال آلومینیومی',
    description: 'چراغ قوه بدنه آلومینیوم با زوم و حالت اضطراری.',
    basePrice: null,
    productCode: 'KZ-P-900012',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['روشنایی', 'شکار'],
    variants: [
      {
        sku: 'KZ-LGT-042-TAC',
        variantCode: 'KZ-P-900012-V000001',
        price: 24_300_000 * RIAL,
        stock: 0,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'آلومینیوم']],
      },
    ],
    note: 'OUT OF STOCK — single variant at zero',
  },
  {
    title: 'کاپشن کوهنوردی گورتکس مدل اورست',
    description: 'کاپشن ضدآب و تنفس‌پذیر سه لایه با کلاه جمع‌شونده.',
    basePrice: null,
    productCode: 'KZ-P-900013',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پوشاک فضای باز', 'کوهنوردی'],
    variants: [
      {
        sku: 'KZ-APP-050-M-BLK',
        variantCode: 'KZ-P-900013-V000001',
        price: 189_000_000 * RIAL,
        stock: 9,
        isActive: true,
        isDefault: true,
        attrs: [
          ['سایز', 'مدیوم'],
          ['رنگ', 'مشکی'],
          ['جنس', 'گورتکس'],
        ],
      },
      {
        sku: 'KZ-APP-050-L-BLK',
        variantCode: 'KZ-P-900013-V000002',
        price: 189_000_000 * RIAL,
        stock: 7,
        isActive: true,
        isDefault: false,
        attrs: [
          ['سایز', 'لارج'],
          ['رنگ', 'مشکی'],
          ['جنس', 'گورتکس'],
        ],
      },
      {
        sku: 'KZ-APP-050-XL-OLV',
        variantCode: 'KZ-P-900013-V000003',
        price: 195_000_000 * RIAL,
        stock: 4,
        isActive: true,
        isDefault: false,
        attrs: [
          ['سایز', 'ایکس‌لارج'],
          ['رنگ', 'زیتونی'],
          ['جنس', 'گورتکس'],
        ],
      },
    ],
    note: 'three sizes, one priced differently',
  },
  {
    title: 'شلوار کوهنوردی کش‌دار مدل دنا',
    description: 'شلوار سبک و کشسان با جیب‌های زیپ‌دار، مناسب پیمایش.',
    basePrice: null,
    productCode: 'KZ-P-900014',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پوشاک فضای باز'],
    variants: [
      {
        sku: 'KZ-APP-051-M-GRY',
        variantCode: 'KZ-P-900014-V000001',
        price: 58_000_000 * RIAL,
        stock: 14,
        isActive: true,
        isDefault: true,
        attrs: [
          ['سایز', 'مدیوم'],
          ['رنگ', 'خاکستری'],
        ],
      },
      {
        sku: 'KZ-APP-051-L-GRY',
        variantCode: 'KZ-P-900014-V000002',
        price: 58_000_000 * RIAL,
        stock: 16,
        isActive: true,
        isDefault: false,
        attrs: [
          ['سایز', 'لارج'],
          ['رنگ', 'خاکستری'],
        ],
      },
    ],
  },
  {
    title: 'جوراب پشمی کوهنوردی',
    description: 'جوراب ساق‌بلند مخلوط پشم مرینوس برای پیاده‌روی طولانی.',
    basePrice: 12_500_000 * RIAL,
    productCode: 'KZ-P-900015',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['پوشاک فضای باز', 'کفش و تجهیزات پیمایش'],
    variants: [
      {
        sku: 'KZ-APP-052-40',
        variantCode: 'KZ-P-900015-V000001',
        price: null,
        stock: 33,
        isActive: true,
        isDefault: true,
        attrs: [['سایز', '۴۰']],
      },
      {
        sku: 'KZ-APP-052-42',
        variantCode: 'KZ-P-900015-V000002',
        price: null,
        stock: 27,
        isActive: true,
        isDefault: false,
        attrs: [['سایز', '۴۲']],
      },
    ],
    note: 'BASE-PRICE INHERITANCE across two variants',
  },
  {
    title: 'کفش کوهنوردی ساق‌بلند ضدآب',
    description: 'کفش ساق‌بلند با زیره چنگ‌زن و غشای ضدآب.',
    basePrice: null,
    productCode: 'KZ-P-900016',
    visibleOnSite: false,
    branchVisibility: 'all',
    categories: ['کفش و تجهیزات پیمایش', 'کوهنوردی'],
    variants: [
      {
        sku: 'KZ-SHO-060-42-BRN',
        variantCode: 'KZ-P-900016-V000001',
        price: 156_000_000 * RIAL,
        stock: 8,
        isActive: true,
        isDefault: true,
        attrs: [['سایز', '۴۲']],
      },
      {
        sku: 'KZ-SHO-060-44-BRN',
        variantCode: 'KZ-P-900016-V000002',
        price: 156_000_000 * RIAL,
        stock: 5,
        isActive: true,
        isDefault: false,
        attrs: [['سایز', '۴۴']],
      },
    ],
    note:
      'VISIBILITY CASE — ALL RETAIL BRANCHES ONLY (visibleOnSite=false, ' +
      'branchVisibility=all). Boots have to be tried on, so this one is sold at ' +
      'every till and nowhere on the website: it must be absent from the ' +
      'storefront listing, detail, search and cart, and present for EVERY ' +
      'cashier — including a branch opened after the seed ran, because `all` ' +
      'is a mode and not a snapshot of today’s branches.',
  },
  {
    title: 'باتوم کوهنوردی تاشو کربنی (جفت)',
    description: 'باتوم سه‌تکه کربنی با دستگیره چوب‌پنبه و نوک تنگستن.',
    basePrice: null,
    productCode: 'KZ-P-900017',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['کفش و تجهیزات پیمایش', 'کوهنوردی'],
    variants: [
      {
        sku: 'KZ-SHO-061-PAIR',
        variantCode: 'KZ-P-900017-V000001',
        price: 72_000_000 * RIAL,
        stock: 21,
        isActive: true,
        isDefault: true,
        attrs: [['وزن', 'سبک']],
      },
    ],
  },
  {
    title: 'کرامپون ۱۲ شاخه یخ‌نوردی',
    description: 'کرامپون فولادی ۱۲ شاخه با بند تنظیم‌شونده.',
    basePrice: null,
    productCode: 'KZ-P-900018',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['کوهنوردی'],
    variants: [
      {
        sku: 'KZ-MNT-070-12PT',
        variantCode: 'KZ-P-900018-V000001',
        price: 98_000_000 * RIAL,
        stock: 6,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'استیل']],
      },
    ],
  },
  {
    title: 'طناب دینامیک کوهنوردی ۵۰ متری',
    description: 'طناب دینامیک ۹.۸ میلی‌متر با پوشش ضدسایش.',
    basePrice: null,
    productCode: 'KZ-P-900019',
    visibleOnSite: false,
    branchVisibility: 'selected',
    branchNames: [SEED_BRANCH_MAIN],
    categories: ['کوهنوردی', 'ابزار و لوازم جانبی'],
    variants: [
      {
        sku: 'KZ-MNT-071-50M',
        variantCode: 'KZ-P-900019-V000001',
        price: 143_000_000 * RIAL,
        stock: 12,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
    note:
      'VISIBILITY CASE — SELECTED BRANCHES ONLY (false, selected: مرکزی). ' +
      'Climbing rope is sold over the counter with advice and never shipped, so ' +
      'it is scoped to the Sanandaj main shop alone: it must appear for ' +
      '`dev_cashier1`/`dev_cashier2`, NOT for `dev_cashier_marivan`, and nowhere ' +
      'on the website. The exact mirror of KZ-P-900004.',
  },
  {
    title: 'چوب ماهیگیری تلسکوپی ۳.۶ متری',
    description: 'چوب تلسکوپی کربن‌فایبر با حلقه‌های سرامیکی.',
    basePrice: null,
    productCode: 'KZ-P-900020',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['ماهیگیری'],
    variants: [
      {
        sku: 'KZ-FSH-080-360',
        variantCode: 'KZ-P-900020-V000001',
        price: 76_500_000 * RIAL,
        stock: 15,
        isActive: true,
        isDefault: true,
        attrs: [['وزن', 'سبک']],
      },
    ],
  },
  {
    title: 'چرخ ماهیگیری اسپینینگ ۴۰۰۰',
    description: 'چرخ اسپینینگ با ۷ بلبرینگ و ترمز جلو.',
    basePrice: null,
    productCode: 'KZ-P-900021',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['ماهیگیری'],
    variants: [
      {
        sku: 'KZ-FSH-081-4000',
        variantCode: 'KZ-P-900021-V000001',
        price: 52_000_000 * RIAL,
        stock: 19,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
  },
  {
    title: 'جعبه لوازم ماهیگیری دوطبقه',
    description: 'جعبه ابزار ماهیگیری با تقسیم‌بندی متغیر.',
    basePrice: null,
    productCode: 'KZ-P-900022',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['ماهیگیری', 'ابزار و لوازم جانبی'],
    variants: [
      {
        sku: 'KZ-FSH-082-2T',
        variantCode: 'KZ-P-900022-V000001',
        price: 14_900_000 * RIAL,
        stock: 26,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
  },
  {
    title: 'دوربین شکاری ۱۰x۴۲ ضدآب',
    description: 'دوربین دوچشمی با پریسم بام و پوشش نیتروژن.',
    basePrice: null,
    productCode: 'KZ-P-900023',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['شکار', 'ابزار و لوازم جانبی'],
    variants: [
      {
        sku: 'KZ-HNT-090-10X42',
        variantCode: 'KZ-P-900023-V000001',
        price: 168_000_000 * RIAL,
        stock: 7,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
  },
  {
    title: 'جلیقه شکار چندجیب',
    description: 'جلیقه شکار با جیب‌های فشنگ و پارچه مقاوم.',
    basePrice: null,
    productCode: 'KZ-P-900024',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['شکار', 'پوشاک فضای باز'],
    variants: [
      {
        sku: 'KZ-HNT-091-L-OLV',
        variantCode: 'KZ-P-900024-V000001',
        price: 46_000_000 * RIAL,
        stock: 13,
        isActive: true,
        isDefault: true,
        attrs: [
          ['سایز', 'لارج'],
          ['رنگ', 'زیتونی'],
        ],
      },
    ],
  },
  {
    title: 'طناب بکسل آفرود ۹ تن',
    description: 'طناب بکسل با قلاب فولادی و غلاف مقاوم، مخصوص آفرود.',
    basePrice: null,
    productCode: 'KZ-P-900025',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['آفرود', 'ابزار و لوازم جانبی'],
    variants: [
      {
        sku: 'KZ-OFR-100-9T',
        variantCode: 'KZ-P-900025-V000001',
        price: 39_500_000 * RIAL,
        stock: 23,
        isActive: true,
        isDefault: true,
        attrs: [['جنس', 'استیل']],
      },
    ],
  },
  {
    title: 'کمپرسور باد خودرو آفرود',
    description: 'کمپرسور پرتابل با فشارسنج دیجیتال برای تنظیم باد لاستیک.',
    basePrice: null,
    productCode: 'KZ-P-900026',
    visibleOnSite: true,
    branchVisibility: 'all',
    categories: ['آفرود'],
    variants: [
      {
        sku: 'KZ-OFR-101-12V',
        variantCode: 'KZ-P-900026-V000001',
        price: 61_000_000 * RIAL,
        stock: 10,
        isActive: true,
        isDefault: true,
        attrs: [],
      },
    ],
  },
  {
    title: 'چادر سقفی خودرو (مدل بازنشسته)',
    description:
      'چادر سقفی نسل قبل. این محصول دیگر فروخته نمی‌شود و فقط برای بررسی حالت غیرفعال باقی مانده است.',
    basePrice: null,
    productCode: 'KZ-P-900027',
    visibleOnSite: false,
    branchVisibility: 'none',
    categories: ['آفرود', 'کمپینگ'],
    variants: [
      {
        sku: 'KZ-OFR-102-RTT-OLD',
        variantCode: 'KZ-P-900027-V000001',
        price: 410_000_000 * RIAL,
        stock: 3,
        isActive: false,
        isDefault: true,
        attrs: [['رنگ', 'زیتونی']],
      },
    ],
    note:
      'VISIBILITY CASE — HIDDEN / DRAFT (visibleOnSite=false, ' +
      'branchVisibility=none). Offered nowhere at all: absent from the ' +
      'storefront AND from every till, while still resolving by id so the ' +
      'admin console can show it. This is the state a delegated (non-super_admin) ' +
      'editor’s new product is born in. ' +
      'Also the INACTIVE PRODUCT — `products` has no isActive column, so that is ' +
      'expressed as an all-inactive variant set; the two mechanisms are ' +
      'independent and this row carries both.',
  },
];

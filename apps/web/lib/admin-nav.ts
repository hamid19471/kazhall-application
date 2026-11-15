import type { Route } from "next";
import type { UserRole } from "@kazhal/api-client";

import type { AccessGate } from "@/lib/permissions";

/**
 * THE SIDEBAR, as data.
 *
 * Each entry names the capability that makes the section reachable. That
 * string is the SAME code the API's `@RequirePermissions(...)` declares, which
 * is what keeps the menu and the server in step: a section the caller cannot
 * use is not rendered, and if this file ever drifts the user gets a 403 from
 * the route rather than a blank screen — the failure is loud either way.
 *
 * Gating the menu is NOT the access control. Every route behind it re-checks
 * the capability on every request, against the database, on the server.
 */
export interface AdminNavItem {
  href: Route;
  label: string;
  /** One line, shown on the desktop sidebar and in the mobile drawer. */
  description: string;
  /** Any ONE of these makes the item visible. Empty = no capability condition. */
  permissions: string[];
  /**
   * An additional ROLE condition, ANDed with `permissions`.
   *
   * Present for exactly one item — sales reporting — because the owner's rule
   * there is a role and not a delegable capability:
   *
   *   "Sales reports are available only to the main administrator, represented
   *    by the built-in `super_admin` role."
   *
   * The API gates `/reports/*` on `@Roles(super_admin)` + `@Audiences('admin')`
   * and retired the `reports.read` code in migration 0028, so a permission
   * string here would name something nobody can hold.
   */
  roles?: UserRole[];
  icon: AdminNavIcon;
  /** Key into the badge counts the shell fetches once for the whole menu. */
  badge?: "reconciliation" | "fulfilment" | "lowStock";
}

export type AdminNavIcon =
  | "dashboard"
  | "box"
  | "tag"
  | "sliders"
  | "layers"
  | "receipt"
  | "scale"
  | "users"
  | "till"
  | "store"
  | "key"
  | "chart"
  | "clipboard";

export interface AdminNavSection {
  key: string;
  title: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavSection[] = [
  {
    key: "overview",
    title: "نمای کلی",
    items: [
      {
        href: "/admin" as Route,
        label: "داشبورد",
        description: "فروش امروز، کارهای در انتظار و هشدارها",
        permissions: ["dashboard.read"],
        icon: "dashboard",
      },
    ],
  },
  {
    key: "catalogue",
    title: "کاتالوگ",
    items: [
      {
        href: "/admin/products" as Route,
        label: "کالاها",
        description: "کالاها، گونه‌ها، قیمت و تصاویر",
        permissions: ["products.read"],
        icon: "box",
      },
      {
        href: "/admin/categories" as Route,
        label: "دسته‌بندی‌ها",
        description: "گروه‌بندی کالاها در فروشگاه",
        permissions: ["categories.read"],
        icon: "tag",
      },
      {
        href: "/admin/attributes" as Route,
        label: "ویژگی‌ها",
        description: "رنگ، سایز، ظرفیت و مقادیر آن‌ها",
        permissions: ["attributes.read"],
        icon: "sliders",
      },
    ],
  },
  {
    key: "operations",
    title: "عملیات",
    items: [
      {
        href: "/admin/inventory" as Route,
        label: "موجودی",
        description: "موجودی انبار، رزروها و دفتر گردش",
        permissions: ["inventory.read"],
        icon: "layers",
        badge: "lowStock",
      },
      {
        href: "/admin/orders" as Route,
        label: "سفارش‌ها",
        description: "سفارش‌های سایت و صندوق",
        permissions: ["orders.read"],
        icon: "receipt",
        badge: "fulfilment",
      },
      {
        href: "/admin/reconciliation" as Route,
        label: "مغایرت پرداخت",
        description: "پرونده‌هایی که نیاز به تصمیم انسانی دارند",
        permissions: ["reconciliation.read"],
        icon: "scale",
        badge: "reconciliation",
      },
    ],
  },
  {
    key: "organization",
    title: "سازمان",
    items: [
      {
        href: "/admin/users" as Route,
        label: "کاربران",
        description: "حساب کارکنان و مشتریان",
        permissions: ["users.read"],
        icon: "users",
      },
      {
        href: "/admin/cashiers" as Route,
        label: "صندوق‌داران",
        description: "کارکنان صندوق و دسترسی آن‌ها به POS",
        permissions: ["users.read"],
        icon: "till",
      },
      {
        href: "/admin/branches" as Route,
        label: "شعبه‌ها",
        description: "فروشگاه‌ها، نشانی و وضعیت فعالیت",
        permissions: ["branches.read"],
        icon: "store",
      },
    ],
  },
  {
    key: "access",
    title: "کنترل دسترسی",
    items: [
      {
        href: "/admin/access" as Route,
        label: "نقش‌ها و دسترسی‌ها",
        description: "تعیین اینکه هر نقش چه کاری می‌تواند انجام دهد",
        permissions: ["rbac.read"],
        icon: "key",
      },
      {
        href: "/admin/audit" as Route,
        label: "دفتر رخدادها",
        description: "چه کسی چه تغییری داده است",
        permissions: ["audit.read"],
        icon: "clipboard",
      },
    ],
  },
  {
    key: "analytics",
    title: "تحلیل",
    items: [
      {
        href: "/admin/reports" as Route,
        label: "گزارش فروش",
        description: "بازهٔ تاریخی به وقت تهران",
        permissions: [],
        roles: ["super_admin"],
        icon: "chart",
      },
      {
        href: "/admin/reports/profit" as Route,
        label: "سود ناخالص",
        description: "درآمد، بهای تمام‌شده و سود ناخالص — نه سود خالص",
        permissions: [],
        // Cost is the main administrator's alone, by ROLE (docs §8).
        roles: ["super_admin"],
        icon: "chart",
      },
      {
        href: "/admin/pricing" as Route,
        label: "قیمت‌گذاری ماهانه",
        description: "هزینه‌های ماهانه، سود هدف و پیشنهاد قیمت فروش همهٔ کالاها",
        permissions: [],
        // The owner's costs, targets and margin, and every price: by ROLE only.
        roles: ["super_admin"],
        icon: "chart",
      },
    ],
  },
];

/**
 * Breadcrumb labels, keyed by the first two path segments after `/admin`.
 *
 * Derived from the nav above where possible; the extra entries are the leaf
 * routes that have no menu item of their own (a product's edit page, one
 * reconciliation case). Falling back to the raw segment would put an id or an
 * English slug in a Persian breadcrumb.
 */
export function adminCrumbLabel(segment: string): string | null {
  for (const section of ADMIN_NAV) {
    for (const item of section.items) {
      if (item.href === `/admin/${segment}`) return item.label;
    }
  }
  return EXTRA_CRUMBS[segment] ?? null;
}

/**
 * The capabilities a breadcrumb destination declares, or `null` when the
 * destination is not a menu item and therefore carries no gate of its own.
 *
 * A breadcrumb is navigation, and navigation the viewer cannot follow is a
 * dead end dressed as a way out. The trail is derived from the URL, so on a
 * delegated account it will happily offer sections that account cannot open —
 * `Breadcrumbs` uses this to render those as plain text instead of links.
 */
export function adminCrumbGate(segment: string): AccessGate | null {
  for (const section of ADMIN_NAV) {
    for (const item of section.items) {
      if (item.href === `/admin/${segment}`) return navGate(item);
    }
  }
  return null;
}

/**
 * The permissions the dashboard itself declares, for the root crumb.
 *
 * Read from the nav map rather than hard-coded, so changing the dashboard's
 * gate in one place changes the crumb too.
 */
export function adminRootGate(): AccessGate {
  for (const section of ADMIN_NAV) {
    for (const item of section.items) {
      if (item.href === "/admin") return navGate(item);
    }
  }
  return { permissions: ["dashboard.read"] };
}

/**
 * THE ONE PLACE A NAV ITEM'S GATE IS READ.
 *
 * Every consumer — the sidebar filter, the "first reachable section" fallback
 * on the logo, and the breadcrumb linkability check — goes through this, so an
 * item that grows a role condition cannot be honoured by one of them and
 * ignored by the other two.
 */
export function navGate(item: AdminNavItem): AccessGate {
  return {
    permissions: [...item.permissions],
    ...(item.roles ? { roles: [...item.roles] } : {}),
  };
}

const EXTRA_CRUMBS: Record<string, string> = {
  new: "افزودن",
  edit: "ویرایش",
  movements: "گردش موجودی",
  profit: "سود ناخالص",
  account: "حساب کاربری",
  password: "تغییر گذرواژه",
};

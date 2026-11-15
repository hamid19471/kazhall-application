"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import type { FormEvent, ReactNode } from "react";

import {
  Badge,
  Button,
  ErrorState,
  Input,
  PersianDateRangeFields,
  Skeleton,
  readDayRange,
  tehranDayEnd,
  tehranDayStart,
} from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination } from "@/components/common";
import { useAppSession } from "@/components/providers";
import {
  AdminPageHeader,
  AdminSection,
  FilterBar,
  Gate,
  RequirePermission,
  Select,
  count,
  when,
} from "@/components/admin/ui";
import { ClipboardIcon, LockIcon, RefreshIcon } from "@/components/icons";
import { fetchAudit, fetchPermissionCatalogue } from "@/lib/admin-api";
import type { AuditRow } from "@/lib/admin-api";
import {
  AUDIT_ACTION_CODES,
  AUDIT_ACTION_GROUPS,
  AUDIT_TARGET_TYPES,
  audienceLabel,
  auditActionLabel,
  auditSummaryKeyLabel,
  auditSummaryValueLabel,
  auditTargetTypeLabel,
} from "@/lib/labels";
import { can } from "@/lib/permissions";
import {
  adminAuditHref,
  adminBranchHref,
  adminOrderHref,
  adminProductHref,
  adminUserHref,
  href,
} from "@/lib/routes";
import { enumParam, intParam, localDateParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 25;

/**
 * ===========================================================================
 * THE ADMINISTRATIVE AUDIT TRAIL
 * ===========================================================================
 *
 * ## It is append-only, and that is enforced below this app
 *
 * `admin_audit_log` carries a database trigger that RAISES on UPDATE and on
 * DELETE. There is no write route on `/admin/audit` and there could not
 * usefully be one: a controller that offered an edit would be refused by the
 * database. This screen says so out loud, because a trail whose readers are not
 * sure it is tamper-evident is not doing the job it exists for.
 *
 * ## What it deliberately does not contain
 *
 * Rows are written by `AuditService` from explicit allow-lists, inside the
 * transaction of the act they describe. No password, token, cookie, session
 * identifier or one-time code is ever recorded — not redacted, not recorded.
 * That is also why this screen never dumps raw JSON: `summary` is arbitrary
 * JSON written by whichever service recorded the act, and an operator asked to
 * read `{"after":{"permissions":[…]}}` is being handed a debugging artefact
 * instead of an answer.
 *
 * ## Dates are INSTANTS here, unlike the order list
 *
 * `GET /admin/audit` compares `createdAt` against ISO-8601 instants with `>=`
 * and `<=`, where `GET /orders` takes local calendar days in the report
 * timezone and resolves them in PostgreSQL. Sending a bare `YYYY-MM-DD` here
 * would therefore silently exclude almost all of the `to` day. So the screen
 * takes a day from the operator and converts it to the first and last instant
 * of that day IN THIS BROWSER'S TIMEZONE, and says which timezone that was.
 */
export function AdminAudit({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["audit.read"]}>
      <AuditBody params={params} />
    </RequirePermission>
  );
}

interface AuditFilters {
  page: number;
  action: string | undefined;
  targetType: string | undefined;
  targetId: string | undefined;
  actorUserId: number | undefined;
  /** Local calendar days as typed. Converted to instants for the request. */
  from: string | undefined;
  to: string | undefined;
}

function readFilters(params: RawSearchParams): AuditFilters {
  const actorUserId = intParam(params, "actorUserId");
  return {
    page: pageParam(params),
    action: enumParam(params, "action", AUDIT_ACTION_CODES),
    targetType: enumParam(params, "targetType", AUDIT_TARGET_TYPES),
    targetId: textParam(params, "targetId", 64),
    actorUserId: actorUserId !== undefined && actorUserId >= 1 ? actorUserId : undefined,
    from: localDateParam(params, "from"),
    to: localDateParam(params, "to"),
  };
}

/*
 * The audit API takes INSTANTS, so a picked calendar day is sent as its first
 * and last instant in Tehran (the business timezone) — `tehranDayStart` /
 * `tehranDayEnd` in `@kazhal/ui`. It used to be the browser's own day, which
 * gave a different answer on a machine set to another zone and could differ
 * between the server render and the browser.
 */

function AuditBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();
  const filters = readFilters(params);

  const request = {
    page: filters.page,
    limit: PAGE_SIZE,
    action: filters.action,
    targetType: filters.targetType,
    targetId: filters.targetId,
    actorUserId: filters.actorUserId,
    from: filters.from === undefined ? undefined : (tehranDayStart(filters.from) ?? undefined),
    to: filters.to === undefined ? undefined : (tehranDayEnd(filters.to) ?? undefined),
  };

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchAudit(api, request, { signal }),
    [api, JSON.stringify(request)],
  );

  /*
   * The Persian names of permission codes are OPTIONAL enrichment, not a
   * dependency: the codes are the durable identifiers and are rendered either
   * way. The catalogue needs `rbac.read`, which a caller holding only
   * `audit.read` does not have, so the call is not even attempted for them.
   */
  const permissionNames = useApiQuery(
    (signal) => fetchPermissionCatalogue(api, { signal }),
    [api],
    { enabled: can(session, "rbac.read") },
  );

  const permissionLabels = new Map<string, string>();
  for (const group of permissionNames.data?.groups ?? []) {
    for (const permission of group.permissions) {
      permissionLabels.set(permission.code, permission.labelFa);
    }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string): string | undefined => {
      const value = form.get(key);
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    // A reversed range is refused where it is shown; nothing is swapped or sent.
    const range = readDayRange(form);
    if (range.error) return;

    router.push(
      adminAuditHref({
        action: field("action"),
        targetType: field("targetType"),
        targetId: field("targetId"),
        actorUserId: field("actorUserId"),
        from: range.from,
        to: range.to,
      }),
    );
  }

  const pageQuery = {
    action: filters.action,
    targetType: filters.targetType,
    targetId: filters.targetId,
    actorUserId: filters.actorUserId,
    from: filters.from,
    to: filters.to,
  };

  return (
    <>
      <AdminPageHeader
        title="دفتر رخدادهای مدیریتی"
        description="چه کسی، چه تغییری، روی چه چیزی و در چه زمانی. هر ردیف در همان تراکنشی نوشته شده که تغییر را انجام داده است."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={refetch}
            leadingIcon={<RefreshIcon className="size-4" />}
          >
            به‌روزرسانی
          </Button>
        }
      />

      <Notice
        tone="info"
        className="mb-5"
        icon={<LockIcon className="size-5" />}
        title="این دفتر فقط‌افزودنی است و از هیچ مسیری قابل ویرایش یا حذف نیست"
      >
        <p>
          روی جدول این دفتر یک <b>تریگر پایگاه داده</b> نشسته است که هر UPDATE و هر DELETE را
          رد می‌کند. بنابراین در کل API مدیریت، هیچ مسیری برای تغییر یا پاک‌کردن یک ردیف وجود
          ندارد — نه اینکه صرفاً پیاده‌سازی نشده باشد؛ پایگاه داده آن را نمی‌پذیرد.
        </p>
        <p className="mt-2">
          این دفتر به‌عمد هیچ‌گاه <b>گذرواژه، توکن، کوکی یا رمز یک‌بارمصرف</b> را در خود ندارد.
          چنین مقادیری پنهان‌سازی نمی‌شوند، بلکه اصلاً ثبت نمی‌شوند.
        </p>
      </Notice>

      <FilterBar
        key={JSON.stringify(filters)}
        onSubmit={apply}
        onReset={() => router.push(adminAuditHref())}
      >
        <Select
          name="action"
          label="نوع رخداد"
          defaultValue={filters.action ?? ""}
          options={[{ value: "", label: "همهٔ رخدادها" }, ...groupedActionOptions()]}
        />

        <Select
          name="targetType"
          label="نوع موضوع"
          defaultValue={filters.targetType ?? ""}
          options={[
            { value: "", label: "همهٔ موضوع‌ها" },
            ...AUDIT_TARGET_TYPES.map((value) => ({
              value,
              label: auditTargetTypeLabel(value),
            })),
          ]}
        />

        <Input
          name="targetId"
          label="شناسهٔ موضوع"
          numeric
          hint="فقط همراه با «نوع موضوع» معنا دارد."
          defaultValue={filters.targetId ?? ""}
          maxLength={64}
          containerClassName="min-w-0"
        />

        <Input
          name="actorUserId"
          label="شناسهٔ عامل"
          numeric
          hint="فقط اقدام‌های همین کاربر مدیریتی."
          defaultValue={filters.actorUserId === undefined ? "" : String(filters.actorUserId)}
          containerClassName="min-w-0"
        />

        <PersianDateRangeFields
          fromLabel="از تاریخ (شامل همان روز)"
          toLabel="تا تاریخ (شامل همان روز)"
          toHint="روز کامل، به وقت تهران."
          defaultFrom={filters.from}
          defaultTo={filters.to}
          containerClassName="min-w-0"
        />
      </FilterBar>

      {error ? (
        <ErrorState
          error={error}
          title="دفتر رخدادها خوانده نشد"
          description="ممکن است یکی از فیلترها را سرور نپذیرفته باشد، یا ارتباط برقرار نشده باشد."
          onRetry={refetch}
        />
      ) : isLoading || !data ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="kz-sr-only">در حال بارگذاری دفتر رخدادها</span>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} shape="block" height="7rem" />
          ))}
        </div>
      ) : (
        <AdminSection
          title="رخدادها"
          description={
            <>
              <bdi data-numeric="">{count(data.total)}</bdi> رخداد با این فیلترها. تازه‌ترین
              در بالا.
            </>
          }
        >
          {data.data.length === 0 ? (
            <div className="py-10 text-center">
              <ClipboardIcon className="mx-auto size-8 text-ink-subtle" aria-hidden="true" />
              <p className="mt-3 text-sm text-ink-muted">
                رخدادی با این فیلترها ثبت نشده است. این یعنی چنین اقدامی در این بازه انجام
                نشده — نه اینکه ردیفی حذف شده باشد.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {data.data.map((row) => (
                <AuditEntry key={row.id} row={row} permissionLabels={permissionLabels} />
              ))}
            </ol>
          )}

          <Pagination
            className="mt-6"
            pageInfo={{
              page: data.page,
              limit: data.limit,
              total: data.total,
              totalPages: Math.max(1, data.totalPages),
              hasNextPage: data.page < data.totalPages,
              hasPreviousPage: data.page > 1,
            }}
            buildHref={(target) =>
              adminAuditHref({ ...pageQuery, ...(target > 1 ? { page: target } : {}) })
            }
          />
        </AdminSection>
      )}
    </>
  );
}

/**
 * The action filter, ordered by subject area.
 *
 * A flat alphabetical list of thirty-six dotted codes is unusable, and the
 * `Select` in the kit is a native `<select>` with no `<optgroup>`. So the group
 * name is folded into the label — "سفارش‌ها › ابطال سفارش" — which keeps the
 * list scannable without inventing a custom listbox that would be worse than
 * the platform's at keyboard, screen-reader and mobile behaviour alike.
 *
 * Anything the catalogue gains but `AUDIT_ACTION_GROUPS` does not classify
 * still appears, under a trailing "سایر": a filter that silently omits a real
 * action code is worse than an untidy one.
 */
function groupedActionOptions(): Array<{ value: string; label: string }> {
  const placed = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];

  for (const group of AUDIT_ACTION_GROUPS) {
    for (const code of AUDIT_ACTION_CODES) {
      if (placed.has(code)) continue;
      if (!group.prefixes.some((prefix) => code.startsWith(prefix))) continue;
      placed.add(code);
      options.push({ value: code, label: `${group.titleFa} › ${auditActionLabel(code)}` });
    }
  }

  for (const code of AUDIT_ACTION_CODES) {
    if (placed.has(code)) continue;
    options.push({ value: code, label: `سایر › ${auditActionLabel(code)}` });
  }

  return options;
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

function AuditEntry({
  row,
  permissionLabels,
}: {
  row: AuditRow;
  permissionLabels: Map<string, string>;
}) {
  const subject = subjectHref(row);

  return (
    <li className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{auditActionLabel(row.action)}</p>
          {/* The stable machine code, kept visible but subordinate: it is what a
              support conversation and the `?action=` filter both quote. */}
          <bdi dir="ltr" className="mt-0.5 block text-2xs text-ink-subtle">
            {row.action}
          </bdi>
        </div>
        <p className="shrink-0 text-2xs text-ink-subtle" data-numeric="">
          {when(row.createdAt)}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 rounded-md bg-surface-muted p-3">
          <p className="text-xs text-ink-subtle">چه کسی</p>
          <p className="mt-1 break-words text-sm font-bold text-ink">
            <bdi dir="ltr">{row.actorDisplaySnapshot}</bdi>
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">
            {row.actorAudience ? `از ${audienceLabel(row.actorAudience)}` : "سامانهٔ نامشخص"}
            {row.actorUserId === null
              ? " — حساب عامل دیگر موجود نیست؛ نام بالا در لحظهٔ اقدام منجمد شده است."
              : ` — کاربر شمارهٔ ${count(row.actorUserId)}`}
          </p>
        </div>

        <div className="min-w-0 rounded-md bg-surface-muted p-3">
          <p className="text-xs text-ink-subtle">روی چه چیزی</p>
          <p className="mt-1 break-words text-sm font-bold text-ink">
            {auditTargetTypeLabel(row.targetType)}
            {row.targetLabel ? <> — {row.targetLabel}</> : null}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-ink-subtle">
            {row.targetId ? (
              <span data-numeric="">
                شناسه: <bdi dir="ltr">{row.targetId}</bdi>
              </span>
            ) : (
              <span>بدون شناسه</span>
            )}
            {/*
              THE LEDGER IS READABLE WITHOUT THE SUBJECT'S SCREEN. `audit.read`
              says nothing about the account directory, the branch register, the
              order queue or the catalogue, so each shortcut is gated on the
              capability its DESTINATION declares. The target type and id stay
              printed either way — that is the audit record, and withholding it
              would make the ledger less useful without making it safer.
            */}
            {subject ? (
              <Gate permissions={[subject.permission]}>
                <Link href={subject.href} className="font-bold no-underline">
                  {subject.label} ←
                </Link>
              </Gate>
            ) : null}
          </p>
        </div>
      </div>

      <SummaryView summary={row.summary} permissionLabels={permissionLabels} />
    </li>
  );
}

/**
 * A link to the subject's own admin page, where one exists.
 *
 * Only a link that IDENTIFIES the subject is offered. A category or an
 * attribute has no detail route, so nothing is rendered for them — sending the
 * operator to a list page and letting them hunt is worse than being honest that
 * there is nowhere to go. A variant has no page of its own either, so it links
 * through its product when the summary recorded one, and otherwise to the
 * stock screen filtered by its SKU, which is the screen a variant's id is
 * actually actionable on.
 */
function subjectHref(
  row: AuditRow,
): { href: Route; label: string; permission: string } | null {
  const numericId = row.targetId !== null && /^\d+$/.test(row.targetId) ? Number(row.targetId) : null;

  switch (row.targetType) {
    case "user":
      return numericId === null ? null : { href: adminUserHref(numericId), label: "صفحهٔ کاربر", permission: "users.read" };
    case "role":
      return numericId === null
        ? null
        : { href: href(`/admin/access/roles/${numericId}`), label: "صفحهٔ نقش", permission: "rbac.read" };
    case "branch":
      return numericId === null ? null : { href: adminBranchHref(numericId), label: "صفحهٔ شعبه", permission: "branches.read" };
    case "order":
      return numericId === null ? null : { href: adminOrderHref(numericId), label: "صفحهٔ سفارش", permission: "orders.read" };
    case "product":
      return numericId === null ? null : { href: adminProductHref(numericId), label: "صفحهٔ کالا", permission: "products.read" };
    case "variant": {
      const productId = row.summary?.["productId"];
      if (typeof productId === "number" && Number.isInteger(productId)) {
        return { href: adminProductHref(productId), label: "صفحهٔ کالای این گونه", permission: "products.read" };
      }
      if (row.targetLabel) {
        return {
          href: href("/admin/inventory", { search: row.targetLabel }),
          label: "این گونه در موجودی",
          permission: "inventory.read",
        };
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `summary` rendered as facts, never as JSON.
 *
 * Three shapes get special treatment because they carry almost all the meaning:
 *
 *  - `before` + `after` together become a THREE-COLUMN DIFF, which is the only
 *    rendering that answers the question an operator opens this row to ask.
 *    Unchanged fields are dimmed rather than hidden, so "the name is the same"
 *    is visible instead of merely absent.
 *  - `granted` / `revoked` are lists of permission CODES, rendered as codes and
 *    coloured by direction. The code is the durable identifier; the Persian
 *    name is added beside it when the catalogue is readable by this caller.
 *  - everything else is a definition list, one row per key.
 *
 * An unrecognised key is shown under its own raw name rather than being hidden.
 * A change an operator cannot see is a change they cannot review, and that is a
 * worse failure than an untranslated label.
 */
function SummaryView({
  summary,
  permissionLabels,
}: {
  summary: Record<string, unknown> | null;
  permissionLabels: Map<string, string>;
}) {
  if (summary === null || Object.keys(summary).length === 0) {
    return (
      <p className="mt-3 text-2xs text-ink-subtle">
        برای این رخداد جزئیاتی ثبت نشده است.
      </p>
    );
  }

  const before = summary["before"];
  const after = summary["after"];
  const hasDiff = isPlainObject(before) && isPlainObject(after);

  const rest = Object.entries(summary).filter(([key]) => {
    if (hasDiff && (key === "before" || key === "after")) return false;
    return true;
  });

  return (
    <div className="mt-3 rounded-md border border-line p-3">
      <p className="text-xs font-bold text-ink-muted">جزئیات تغییر</p>

      {hasDiff ? (
        <DiffTable
          before={before as Record<string, unknown>}
          after={after as Record<string, unknown>}
          permissionLabels={permissionLabels}
        />
      ) : null}

      {rest.length > 0 ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {rest.map(([key, value]) => (
            <div key={key} className="min-w-0 rounded-md bg-surface-muted p-2.5">
              <dt className="text-2xs text-ink-subtle">{auditSummaryKeyLabel(key)}</dt>
              <dd className="mt-1 min-w-0 text-xs text-ink">
                <ValueView
                  value={value}
                  permissionLabels={permissionLabels}
                  tone={key === "granted" ? "success" : key === "revoked" ? "danger" : "neutral"}
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function DiffTable({
  before,
  after,
  permissionLabels,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  permissionLabels: Map<string, string>;
}) {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];

  return (
    <div className="mt-2 space-y-2">
      {fields.map((field) => {
        const changed = JSON.stringify(before[field]) !== JSON.stringify(after[field]);
        return (
          <div
            key={field}
            className={
              changed
                ? "rounded-md border border-warning/40 bg-warning-soft/40 p-2.5"
                : "rounded-md bg-surface-muted p-2.5 opacity-70"
            }
          >
            <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-subtle">
              {auditSummaryKeyLabel(field)}
              {changed ? (
                <Badge size="sm" tone="warning">
                  تغییر کرد
                </Badge>
              ) : (
                <span>بدون تغییر</span>
              )}
            </p>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-2xs text-ink-subtle">پیش از تغییر</p>
                <div className="mt-0.5 min-w-0 text-xs text-ink">
                  <ValueView
                    value={before[field]}
                    permissionLabels={permissionLabels}
                    tone="neutral"
                  />
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-2xs text-ink-subtle">پس از تغییر</p>
                <div className="mt-0.5 min-w-0 text-xs text-ink">
                  <ValueView
                    value={after[field]}
                    permissionLabels={permissionLabels}
                    tone={changed ? "primary" : "neutral"}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One value, whatever shape it turned out to be.
 *
 * `depth` stops a pathological nested object from producing an unreadable wall:
 * below the limit the remaining structure is summarised by its key names rather
 * than expanded, which still tells the reader what is in there.
 */
function ValueView({
  value,
  permissionLabels,
  tone,
  depth = 0,
}: {
  value: unknown;
  permissionLabels: Map<string, string>;
  tone: "neutral" | "success" | "danger" | "primary";
  depth?: number;
}): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-subtle">(هیچ)</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((entry, index) => {
          const code = typeof entry === "string" ? entry : null;
          const name = code ? permissionLabels.get(code) : undefined;
          return (
            /*
              `max-w-full` + `break-words`: a permission code plus its Persian
              name is the longest string on this screen, and at 320px one chip
              would otherwise be wider than the column and push the PAGE into a
              horizontal scroll. It wraps inside the pill instead.
            */
            <Badge
              key={`${String(entry)}-${index}`}
              size="sm"
              tone={tone}
              className="max-w-full break-words"
            >
              {code ? (
                <>
                  <bdi dir="ltr">{code}</bdi>
                  {name ? <> — {name}</> : null}
                </>
              ) : (
                auditSummaryValueLabel(entry)
              )}
            </Badge>
          );
        })}
      </span>
    );
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-ink-subtle">(خالی)</span>;
    if (depth >= 2) {
      return (
        <span className="text-ink-subtle">
          {entries.map(([key]) => auditSummaryKeyLabel(key)).join("، ")}
        </span>
      );
    }
    return (
      <dl className="space-y-1">
        {entries.map(([key, nested]) => (
          <div key={key} className="flex flex-wrap items-baseline gap-1.5">
            <dt className="text-2xs text-ink-subtle">{auditSummaryKeyLabel(key)}:</dt>
            <dd className="min-w-0">
              <ValueView
                value={nested}
                permissionLabels={permissionLabels}
                tone={key === "granted" ? "success" : key === "revoked" ? "danger" : tone}
                depth={depth + 1}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const text = auditSummaryValueLabel(value);
  return typeof value === "number" ? (
    <bdi data-numeric="">{text}</bdi>
  ) : (
    <span className="break-words">{text}</span>
  );
}

"use client";

import { useMemo } from "react";

import { Badge, Skeleton, cx } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Checkbox, count } from "@/components/admin/ui";
import { fetchPermissionCatalogue } from "@/lib/admin-api";
import type { PermissionGroup, PermissionSpec } from "@/lib/admin-api";
import { RISK_LABEL, RISK_TONE } from "@/lib/permissions";

/**
 * THE PERMISSION CHECKLIST, and the reason it reads the catalogue from the API
 * rather than carrying forty Persian strings of its own.
 *
 * Each capability's label, its consequence sentence and its risk level are
 * defined once, in `apps/api/src/modules/auth/permissions/permission.catalog.ts`,
 * and served by `GET /admin/access/permissions`. Duplicating them here is how
 * the console and the server end up describing the same permission
 * differently — and the one the administrator reads would be the one nobody
 * updated.
 *
 * `orders.status.update` is never the primary label. The Persian description
 * is what an administrator is actually deciding about; the code appears as
 * small secondary text for the rare moment somebody is reading the API docs
 * alongside.
 */
export function usePermissionCatalogue() {
  const api = useApi();
  return useApiQuery((signal) => fetchPermissionCatalogue(api, { signal }), [api]);
}

/** Flattens the grouped catalogue into `code → spec`, for label lookups. */
export function usePermissionIndex(groups: PermissionGroup[] | undefined) {
  return useMemo(() => {
    const index = new Map<string, PermissionSpec & { groupTitle: string }>();
    for (const group of groups ?? []) {
      for (const permission of group.permissions) {
        index.set(permission.code, { ...permission, groupTitle: group.titleFa });
      }
    }
    return index;
  }, [groups]);
}

export function PermissionPicker({
  groups,
  selected,
  onChange,
  readOnly = false,
  /**
   * Capabilities the ACTOR does not hold themselves. The server refuses to let
   * anyone confer authority they lack (403 `PERMISSION_ESCALATION`), so
   * offering the checkbox would be offering a guaranteed failure.
   */
  beyondAuthority,
}: {
  groups: PermissionGroup[];
  selected: ReadonlySet<string>;
  onChange: (code: string, checked: boolean) => void;
  readOnly?: boolean;
  beyondAuthority?: ReadonlySet<string>;
}) {
  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const chosen = group.permissions.filter((permission) =>
          selected.has(permission.code),
        ).length;
        return (
          <section key={group.key}>
            <h3 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-ink">
              {group.titleFa}
              <Badge size="sm" tone={chosen > 0 ? "primary" : "neutral"}>
                <bdi data-numeric="">
                  {count(chosen)} از {count(group.permissions.length)}
                </bdi>
              </Badge>
            </h3>
            <div className="grid gap-2 lg:grid-cols-2">
              {group.permissions.map((permission) => {
                const blocked = beyondAuthority?.has(permission.code) ?? false;
                return (
                  <Checkbox
                    key={permission.code}
                    checked={selected.has(permission.code)}
                    disabled={readOnly || blocked}
                    onChange={(checked) => onChange(permission.code, checked)}
                    label={
                      <>
                        {permission.labelFa}
                        {permission.risk !== "normal" ? (
                          <Badge size="sm" tone={RISK_TONE[permission.risk] ?? "neutral"}>
                            {RISK_LABEL[permission.risk] ?? permission.risk}
                          </Badge>
                        ) : null}
                      </>
                    }
                    description={
                      <>
                        {permission.descriptionFa}
                        <bdi
                          dir="ltr"
                          className={cx(
                            "mt-1 block text-2xs",
                            blocked ? "text-danger" : "text-ink-subtle",
                          )}
                        >
                          {permission.code}
                        </bdi>
                        {blocked ? (
                          <span className="mt-1 block text-2xs text-danger">
                            شما خودتان این اختیار را ندارید، پس نمی‌توانید آن را به کسی بدهید.
                          </span>
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function PermissionPickerSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="kz-sr-only">در حال بارگذاری فهرست اختیارات</span>
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} shape="block" height="4rem" />
      ))}
    </div>
  );
}

/**
 * The permission codes a role holds, rendered as their Persian meanings and
 * grouped. Used wherever a set has to be READ rather than edited — the
 * read-only view of a built-in role, and the effective-permission summary on a
 * user's page.
 */
export function PermissionSummary({
  codes,
  groups,
  emptyLabel = "هیچ اختیاری ندارد.",
}: {
  codes: readonly string[];
  groups: PermissionGroup[] | undefined;
  emptyLabel?: string;
}) {
  const index = usePermissionIndex(groups);

  const byGroup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const code of codes) {
      const spec = index.get(code);
      const title = spec?.groupTitle ?? "سایر";
      const bucket = map.get(title);
      if (bucket) bucket.push(code);
      else map.set(title, [code]);
    }
    return [...map.entries()];
  }, [codes, index]);

  if (codes.length === 0) {
    return <p className="text-sm text-ink-subtle">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-4">
      {byGroup.map(([title, groupCodes]) => (
        <div key={title}>
          <h4 className="mb-1.5 text-xs font-bold text-ink-muted">{title}</h4>
          <ul className="space-y-1.5">
            {groupCodes.map((code) => {
              const spec = index.get(code);
              return (
                <li key={code} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="text-ink">{spec?.labelFa ?? code}</span>
                  <bdi dir="ltr" className="text-2xs text-ink-subtle">
                    {code}
                  </bdi>
                  {spec && spec.risk !== "normal" ? (
                    <Badge size="sm" tone={RISK_TONE[spec.risk] ?? "neutral"}>
                      {RISK_LABEL[spec.risk] ?? spec.risk}
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

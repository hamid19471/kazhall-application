"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button, ErrorState, Input } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination } from "@/components/common";
import {
  AdminPageHeader,
  DataTable,
  EmptyRow,
  FilterBar,
  Gate,
  Modal,
  RequirePermission,
  SearchField,
  Select,
  TableSkeleton,
  Td,
  Textarea,
  Th,
  Tr,
  count,
  useMutation,
} from "@/components/admin/ui";
import {
  AccountStatusBadge,
  MutationError,
  UsersListLink,
  pageInfoOf,
} from "@/components/admin/people-shared";
import { PlusIcon, StoreIcon } from "@/components/icons";
import { createBranch, fetchBranches } from "@/lib/admin-api";
import { adminBranchHref, adminBranchesHref } from "@/lib/routes";
import { boolParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;
const NAME_MIN = 2;

/**
 * THE SHOPS.
 *
 * A branch is what a POS sale is attributed to, which is the reason this screen
 * is not just a list of addresses: deactivating one stops sales at its till,
 * and the counts in the table are what tell a manager whether that would
 * strand anybody.
 *
 * Stock is NOT per branch anywhere in this system — the warehouse is shared
 * between the website and every shop — so nothing here counts inventory.
 */
export function AdminBranches({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["branches.read"]}>
      <BranchesBody filters={parseFilters(params)} />
    </RequirePermission>
  );
}

interface Filters {
  page: number;
  search?: string | undefined;
  isActive?: boolean | undefined;
}

function parseFilters(params: RawSearchParams): Filters {
  return {
    page: pageParam(params),
    search: textParam(params, "search"),
    // TRISTATE on purpose. An absent filter coerced to `false` would hide
    // every open shop by default, which is the opposite of useful.
    isActive: boolParam(params, "isActive"),
  };
}

function BranchesBody({ filters }: { filters: Filters }) {
  const api = useApi();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchBranches(api, { ...filters, limit: PAGE_SIZE }, { signal }),
    [api, JSON.stringify(filters)],
  );

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string): string | undefined => {
      const raw = form.get(name);
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim().slice(0, 200);
      return trimmed === "" ? undefined : trimmed;
    };
    router.push(
      adminBranchesHref({ search: field("search"), isActive: field("isActive") }),
    );
  }

  const header = (
    <AdminPageHeader
      title="شعبه‌ها"
      description="فروشگاه‌های حضوری. هر فروش صندوق به یک شعبه نسبت داده می‌شود؛ سفارش‌های اینترنتی شعبه ندارند. موجودی انبار بین سایت و همهٔ شعبه‌ها مشترک است و به تفکیک شعبه نگهداری نمی‌شود."
      actions={
        <Gate permissions={["branches.create"]}>
          <Button leadingIcon={<PlusIcon className="size-4" />} onClick={() => setCreating(true)}>
            شعبهٔ تازه
          </Button>
        </Gate>
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState
          error={error}
          title="فهرست شعبه‌ها خوانده نشد"
          description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد. هیچ شعبه‌ای تغییر نکرده است."
          onRetry={refetch}
        />
      </>
    );
  }

  return (
    <>
      {header}

      <FilterBar onSubmit={apply} onReset={() => router.push(adminBranchesHref())}>
        <SearchField
          label="جست‌وجو در نام و نشانی"
          defaultValue={filters.search ?? ""}
        />
        <Select
          name="isActive"
          label="وضعیت"
          key={`active-${filters.isActive ?? ""}`}
          defaultValue={filters.isActive === undefined ? "" : String(filters.isActive)}
          options={[
            { value: "", label: "فعال و غیرفعال" },
            { value: "true", label: "فقط شعبه‌های فعال" },
            { value: "false", label: "فقط شعبه‌های غیرفعال" },
          ]}
        />
      </FilterBar>

      {isLoading || !data ? (
        <TableSkeleton rows={5} columns={6} />
      ) : (
        <>
          <DataTable minWidth="60rem" caption="فهرست شعبه‌ها">
            <thead>
              <tr>
                <Th>نام شعبه</Th>
                <Th>نشانی</Th>
                <Th>تلفن</Th>
                <Th>وضعیت</Th>
                <Th numeric>کارکنان فعال</Th>
                <Th numeric>سفارش‌ها</Th>
                <Th numeric>سفارش‌های در جریان</Th>
                <Th>
                  <span className="kz-sr-only">اقدام</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.data.length === 0 ? (
                <EmptyRow colSpan={8}>
                  شعبه‌ای با این فیلترها پیدا نشد.
                </EmptyRow>
              ) : (
                data.data.map((branch) => (
                  <Tr key={branch.id}>
                    <Td>
                      <Link href={adminBranchHref(branch.id)} className="no-underline">
                        <span className="text-sm font-bold text-primary">{branch.name}</span>
                      </Link>
                    </Td>
                    <Td>
                      <span className="block max-w-[22rem] truncate text-xs text-ink-muted">
                        {branch.address ?? "—"}
                      </span>
                    </Td>
                    <Td>
                      {branch.phone ? (
                        <bdi dir="ltr" data-numeric="" className="text-xs">
                          {branch.phone}
                        </bdi>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <AccountStatusBadge isActive={branch.isActive} />
                    </Td>
                    <Td numeric>
                      <UsersListLink
                        query={{ branchId: branch.id, status: "active" }}
                        className="no-underline"
                      >
                        {count(branch.activeStaffCount)}
                      </UsersListLink>
                    </Td>
                    <Td numeric>{count(branch.orderCount)}</Td>
                    <Td numeric>
                      {branch.openOrderCount > 0 ? (
                        <span className="font-bold text-warning">
                          {count(branch.openOrderCount)}
                        </span>
                      ) : (
                        count(0)
                      )}
                    </Td>
                    <Td>
                      <Link href={adminBranchHref(branch.id)} className="whitespace-nowrap text-xs">
                        مدیریت شعبه ←
                      </Link>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>

          <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
            «سفارش‌های در جریان» سفارش‌هایی هستند که هنوز تعیین تکلیف نشده‌اند. غیرفعال‌کردن شعبه
            آن‌ها را لغو نمی‌کند.
          </p>

          <Pagination
            className="mt-8"
            pageInfo={pageInfoOf(data)}
            buildHref={(target) =>
              adminBranchesHref({
                search: filters.search,
                isActive: filters.isActive === undefined ? undefined : String(filters.isActive),
                ...(target > 1 ? { page: target } : {}),
              })
            }
          />
        </>
      )}

      <CreateBranchModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          refetch();
        }}
      />
    </>
  );
}

/**
 * The creation form.
 *
 * `phone` is validated by the API as a real Iranian number, so an empty field
 * is OMITTED rather than sent as `""` — an empty string is not a phone number
 * and would come back as a 400 that says nothing useful.
 */
function CreateBranchModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const api = useApi();
  const create = useMutation(createBranch);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");

  const ready = name.trim().length >= NAME_MIN;

  async function submit() {
    const result = await create.run(api, {
      name: name.trim(),
      ...(address.trim() === "" ? {} : { address: address.trim() }),
      ...(phone.trim() === "" ? {} : { phone: phone.trim() }),
    });
    if (result) {
      setName("");
      setAddress("");
      setPhone("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="شعبهٔ تازه"
      description="نام شعبه روی هر فروش حضوری آن ثبت می‌شود، پس نامی بگذارید که کارکنان صندوق هم همان را می‌شناسند."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            انصراف
          </Button>
          <Button onClick={submit} isLoading={create.isPending} disabled={!ready}>
            ساخت شعبه
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="نام شعبه"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          minLength={NAME_MIN}
          maxLength={120}
          hint="دست‌کم دو نویسه و در کل سامانه یگانه."
        />
        <Textarea
          label="نشانی (اختیاری)"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={500}
        />
        <Input
          label="تلفن (اختیاری)"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          numeric
          maxLength={20}
          hint="شمارهٔ تلفن ایران، مثلاً ۰۲۱۲۲۳۳۴۴۵۵. اگر معتبر نباشد سرور آن را رد می‌کند."
        />

        <Notice tone="neutral" icon={<StoreIcon className="size-5" />}>
          <p>
            شعبهٔ تازه <b>فعال</b> ساخته می‌شود، ولی هیچ کارمندی به آن تخصیص نمی‌یابد. برای اینکه
            کسی در آن بفروشد، شعبهٔ او را در صفحهٔ خودش تغییر دهید.
          </p>
        </Notice>

        <MutationError error={create.error} />
      </div>
    </Modal>
  );
}

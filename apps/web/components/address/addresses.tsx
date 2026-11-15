"use client";

import { useCallback, useState } from "react";
import type { FormEvent } from "react";

import type { Address, ApiError, CreateAddressBody } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Button, Card, EmptyState, Input, Skeleton, cx, toLatinDigits } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { PinIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { useSubmit } from "@/lib/hooks";

/**
 * Customer addresses.
 *
 * **Only `/me/addresses` is ever used here.** The API also exposes a
 * `super_admin` address directory at `/address`, which returns EVERY customer's
 * addresses; wiring a customer screen to it would be a data breach dressed up
 * as a convenience. The two are not interchangeable and the customer-owned
 * resource is the only correct one for this flow.
 *
 * Two field names are shipped API spellings and must not be "corrected":
 * `postal_code` (snake_case, exactly 10 characters) and `reciver_mobile`
 * (misspelled "receiver"). Renaming them client-side produces a 400 from the
 * whitelisting `ValidationPipe`, not a friendlier payload.
 */
export function useAddresses() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const { data, error, isLoading } = useApiQuery(
    // The customer-owned list. Page size is generous because an address book is
    // small and paging through it is pure friction.
    (signal) => api.address.listMine({ page: 1, limit: 50 }, { signal }),
    [api, nonce],
  );

  return { addresses: data?.items ?? [], isLoading, error, refresh };
}

// ---------------------------------------------------------------------------
// The address book (manage)
// ---------------------------------------------------------------------------

export function AddressBook() {
  const { addresses, isLoading, error, refresh } = useAddresses();
  const [editing, setEditing] = useState<Address | null>(null);
  const [creating, setCreating] = useState(false);

  if (isLoading) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="kz-sr-only">در حال بارگذاری نشانی‌ها</span>
        <Skeleton shape="block" height="6rem" />
        <Skeleton shape="block" height="6rem" />
      </div>
    );
  }

  if (error) {
    return (
      <Card tone="outlined">
        <p className="text-ink">فهرست نشانی‌ها بارگذاری نشد.</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>
          تلاش دوباره
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {addresses.length === 0 && !creating ? (
        <EmptyState
          icon={<PinIcon className="size-8" />}
          title="هنوز نشانی‌ای ثبت نکرده‌اید"
          description="برای ثبت سفارش، دست‌کم به یک نشانی تحویل نیاز دارید."
          action={
            <Button onClick={() => setCreating(true)} leadingIcon={<PlusIcon className="size-4" />}>
              افزودن نشانی
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {addresses.map((address) => (
            <li key={address.id}>
              {editing?.id === address.id ? (
                <AddressForm
                  initial={address}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    refresh();
                  }}
                />
              ) : (
                <AddressCard
                  address={address}
                  onEdit={() => setEditing(address)}
                  onDeleted={refresh}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <AddressForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : addresses.length > 0 ? (
        <Button
          variant="secondary"
          onClick={() => setCreating(true)}
          leadingIcon={<PlusIcon className="size-4" />}
        >
          افزودن نشانی تازه
        </Button>
      ) : null}
    </div>
  );
}

function AddressCard({
  address,
  onEdit,
  onDeleted,
}: {
  address: Address;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const api = useApi();
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const { run: remove, isPending } = useSubmit(async () => {
    setError(undefined);
    try {
      await api.address.deleteMine(address.id);
      onDeleted();
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <Card tone="outlined">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">
            {address.province}، {address.city}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{address.address}</p>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-subtle">
            <div className="flex gap-1">
              <dt>کد پستی</dt>
              <dd dir="ltr" data-numeric="">
                {address.postal_code}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>موبایل گیرنده</dt>
              <dd dir="ltr" data-numeric="">
                {address.reciver_mobile}
              </dd>
            </div>
          </dl>
          {address.description ? (
            <p className="mt-2 text-xs text-ink-subtle">{address.description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            ویرایش
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            leadingIcon={<TrashIcon className="size-4" />}
          >
            حذف
          </Button>
        </div>
      </div>

      {confirming ? (
        <Notice
          tone="warning"
          className="mt-4"
          title="این نشانی حذف شود؟"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="danger" isLoading={isPending} onClick={() => void remove()}>
                حذف کن
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                انصراف
              </Button>
            </div>
          }
        >
          <p>
            سفارش‌های قبلی شما تحت تأثیر قرار نمی‌گیرند: نشانی هر سفارش در لحظهٔ ثبت، جداگانه ذخیره
            شده است.
          </p>
        </Notice>
      ) : null}

      <FormError error={error} className="mt-3" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface FieldErrors {
  province?: string;
  city?: string;
  address?: string;
  postal_code?: string;
  reciver_mobile?: string;
}

export function AddressForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Address;
  onSaved: (address: Address) => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const [values, setValues] = useState<CreateAddressBody>({
    province: initial?.province ?? "",
    city: initial?.city ?? "",
    address: initial?.address ?? "",
    postal_code: initial?.postal_code ?? "",
    reciver_mobile: initial?.reciver_mobile ?? "",
    ...(initial?.description ? { description: initial.description } : {}),
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<ApiError | undefined>(undefined);

  function set<K extends keyof CreateAddressBody>(key: K, value: CreateAddressBody[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const { run: save, isPending } = useSubmit(async () => {
    setError(undefined);

    const problems = validate(values);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    const body: CreateAddressBody = {
      province: values.province.trim(),
      city: values.city.trim(),
      address: values.address.trim(),
      postal_code: toLatinDigits(values.postal_code).replace(/\D/g, ""),
      reciver_mobile: toLatinDigits(values.reciver_mobile).replace(/\D/g, ""),
      ...(values.description?.trim() ? { description: values.description.trim() } : {}),
    };

    try {
      const result = initial
        ? await api.address.updateMine(initial.id, body)
        : await api.address.createMine(body);
      onSaved(result.data);
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <Card tone="outlined" as="section">
      <h3 className="text-base font-bold text-ink">
        {initial ? "ویرایش نشانی" : "نشانی تازه"}
      </h3>

      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          label="استان"
          required
          value={values.province}
          onChange={(event) => set("province", event.target.value)}
          {...(fieldErrors.province ? { error: fieldErrors.province } : {})}
        />
        <Input
          label="شهر"
          required
          value={values.city}
          onChange={(event) => set("city", event.target.value)}
          {...(fieldErrors.city ? { error: fieldErrors.city } : {})}
        />

        <div className="sm:col-span-2">
          <Input
            label="نشانی کامل"
            required
            value={values.address}
            onChange={(event) => set("address", event.target.value)}
            {...(fieldErrors.address ? { error: fieldErrors.address } : {})}
          />
        </div>

        <Input
          label="کد پستی"
          numeric
          required
          maxLength={10}
          value={values.postal_code}
          onChange={(event) => set("postal_code", event.target.value)}
          hint="دقیقاً ۱۰ رقم"
          {...(fieldErrors.postal_code ? { error: fieldErrors.postal_code } : {})}
        />
        <Input
          label="موبایل گیرنده"
          numeric
          required
          value={values.reciver_mobile}
          onChange={(event) => set("reciver_mobile", event.target.value)}
          placeholder="09xxxxxxxxx"
          {...(fieldErrors.reciver_mobile ? { error: fieldErrors.reciver_mobile } : {})}
        />

        <div className="sm:col-span-2">
          <Input
            label="توضیح برای پیک (اختیاری)"
            value={values.description ?? ""}
            onChange={(event) => set("description", event.target.value)}
            placeholder="مثلاً: طبقهٔ سوم، واحد ۷"
          />
        </div>

        <div className="sm:col-span-2">
          <FormError error={error} />
        </div>

        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" isLoading={isPending}>
            {initial ? "ذخیرهٔ تغییرات" : "ثبت نشانی"}
          </Button>
          {onCancel ? (
            <Button type="button" variant="secondary" onClick={onCancel}>
              انصراف
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * Client-side validation.
 *
 * It mirrors the server's rules (10-digit postal code, Iranian mobile) so an
 * obvious typo is caught before a round trip — but it is not the authority.
 * Anything it lets through is still judged by the API, and the API's messages
 * are what the customer sees when the two disagree.
 */
function validate(values: CreateAddressBody): FieldErrors {
  const problems: FieldErrors = {};
  if (values.province.trim() === "") problems.province = "استان را وارد کنید.";
  if (values.city.trim() === "") problems.city = "شهر را وارد کنید.";
  if (values.address.trim() === "") problems.address = "نشانی را وارد کنید.";

  const postal = toLatinDigits(values.postal_code).replace(/\D/g, "");
  if (postal.length !== 10) problems.postal_code = "کد پستی باید دقیقاً ۱۰ رقم باشد.";

  const mobile = toLatinDigits(values.reciver_mobile).replace(/\D/g, "");
  if (!/^09\d{9}$/.test(mobile)) {
    problems.reciver_mobile = "شمارهٔ موبایل گیرنده را به شکل ۰۹xxxxxxxxx وارد کنید.";
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The picker (checkout)
// ---------------------------------------------------------------------------

export function AddressPicker({
  addresses,
  selectedId,
  onSelect,
  onAdded,
}: {
  addresses: Address[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState(addresses.length === 0);

  return (
    <div className="space-y-3">
      {addresses.length > 0 ? (
        <ul className="space-y-2">
          {addresses.map((address) => {
            const active = address.id === selectedId;
            return (
              <li key={address.id}>
                <label
                  className={cx(
                    "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors duration-150 ease-kz",
                    "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
                    active
                      ? "border-primary bg-primary-soft"
                      : "border-line-strong bg-surface hover:border-ink-subtle",
                  )}
                >
                  <input
                    type="radio"
                    name="delivery-address"
                    className="mt-1 size-4 shrink-0 accent-[color:var(--kz-primary)]"
                    checked={active}
                    onChange={() => onSelect(address.id)}
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">
                      {address.province}، {address.city}
                    </span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">
                      {address.address}
                    </span>
                    <span className="mt-1 block text-xs text-ink-subtle">
                      کد پستی{" "}
                      <bdi dir="ltr" data-numeric="">
                        {address.postal_code}
                      </bdi>{" "}
                      — گیرنده{" "}
                      <bdi dir="ltr" data-numeric="">
                        {address.reciver_mobile}
                      </bdi>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {adding ? (
        <AddressForm
          onCancel={addresses.length > 0 ? () => setAdding(false) : undefined}
          onSaved={(address) => {
            setAdding(false);
            onSelect(address.id);
            onAdded();
          }}
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setAdding(true)}
          leadingIcon={<PlusIcon className="size-4" />}
        >
          افزودن نشانی تازه
        </Button>
      )}
    </div>
  );
}

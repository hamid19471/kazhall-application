import type { Metadata } from "next";

import type { ProductSort } from "@kazhal/api-client";

import { Breadcrumbs, PageHeading } from "@/components/common";
import { CatalogView, type CatalogFilters } from "@/components/catalog/catalog-view";
import {
  boolParam,
  enumParam,
  intParam,
  pageParam,
  textParam,
  type RawSearchParams,
} from "@/lib/search-params";

export const metadata: Metadata = {
  title: "همهٔ کالاها",
  description: "چادر، کیسه خواب، کوله‌پشتی، پوشاک کوهنوردی، لوازم کمپینگ، شکار و ماهیگیری.",
};

const SORTS = ["newest", "price_asc", "price_desc"] as const satisfies readonly ProductSort[];

/**
 * The catalogue.
 *
 * `searchParams` is a Promise in Next 16 — the synchronous shim from 15 is
 * gone — so this is an async Server Component whose only job is to parse and
 * validate the URL. The fetching itself happens on the client (see
 * `components/providers.tsx` for why), and awaiting `searchParams` is what
 * makes the route dynamic, so `next build` never tries to prerender a
 * catalogue against an API that may not be running.
 *
 * The props are typed locally rather than with the generated `PageProps<...>`
 * global, matching the root layout's reasoning: the globals only exist after
 * `.next/types` has been written, and `.next/` is gitignored.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;

  const filters: CatalogFilters = {
    page: pageParam(params),
    ...(textParam(params, "search") !== undefined ? { search: textParam(params, "search")! } : {}),
    ...(intParam(params, "categoryId") !== undefined
      ? { categoryId: intParam(params, "categoryId")! }
      : {}),
    ...(intParam(params, "minPrice") !== undefined
      ? { minPrice: intParam(params, "minPrice")! }
      : {}),
    ...(intParam(params, "maxPrice") !== undefined
      ? { maxPrice: intParam(params, "maxPrice")! }
      : {}),
    ...(boolParam(params, "inStockOnly") ? { inStockOnly: true } : {}),
    ...(enumParam(params, "sort", SORTS) !== undefined
      ? { sort: enumParam(params, "sort", SORTS)! }
      : {}),
  };

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-6 md:px-6 md:py-10">
      <Breadcrumbs items={[{ label: "خانه", href: "/" }, { label: "کالاها" }]} />
      <PageHeading
        title="همهٔ کالاها"
        description="تجهیزات کوهنوردی، شکار، کمپینگ و آفرود و ماهیگیری. قیمت‌ها به ریال است."
      />
      <div className="mt-6">
        <CatalogView filters={filters} />
      </div>
    </div>
  );
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PosCatalogQueryDto } from './dto/pos-catalog-query.dto';
import { InventoryService } from './inventory.service';
import type {
  PosCatalogPage,
  PosCatalogProductView,
  PosCatalogVariantView,
} from './views/pos-catalog.view';

interface IdRow {
  id: number | string;
}

interface VariantRow {
  productId: number;
  productTitle: string;
  variantId: number;
  sku: string;
  variantCode: string;
  productCode: string;
  price: string | number | null;
  attributeValueId: number | null;
  attributeValue: string | null;
  attributeId: number | null;
  attributeName: string | null;
}

interface ImageRow {
  productId: number;
  id: number;
  url: string;
}

interface CategoryRow {
  productId: number;
  id: number;
  title: string;
}

/**
 * The till's catalogue.
 *
 * THE SHAPE OF THE PROBLEM. A counter needs, per page of tiles: the product,
 * its active variants, each variant's effective price and each variant's
 * `availableForPos`. `GET /products` gives none of the variant half and is
 * public, so it can never carry POS stock. Fetching detail per tile is one
 * request per product on every keystroke.
 *
 * So this resolves a page of PRODUCT IDS first, then loads everything those
 * products need in a fixed number of queries — four, regardless of page size —
 * and asks `InventoryService` once for the availability of every variant on the
 * page. Adding a product to the grid does not add a round trip.
 *
 * SEARCH covers product title, variant SKU and variant attribute value, because
 * those are the three things a cashier actually remembers about an item. It is
 * a case-insensitive substring, evaluated in Postgres against an id-only
 * subquery, so the page is cut before any row is hydrated.
 */
@Injectable()
export class PosCatalogService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * TypeORM's `query` is typed `Promise<any>`. Narrowing it once, here, keeps
   * every call site below genuinely typed instead of spreading `any` — or a
   * cast per call — through the method.
   */
  private rows<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return this.dataSource.query(sql, parameters);
  }

  /**
   * Browse the till grid FOR ONE BRANCH.
   *
   * `branchId` is EXPLICIT, never defaulted. `null` means "not scoped to a
   * branch" and is reachable only for an `admin`-audience session, which is
   * entitled to the whole catalogue through `GET /products/admin` anyway — see
   * `InventoryController.resolveBranchScope` for why that is not a hole. A
   * `pos` session is always a real branch id.
   *
   * Making the parameter REQUIRED (rather than optional with a default) is the
   * point: a caller that forgets it does not silently browse everything, it
   * fails to compile.
   *
   * The branch's own `isActive` is asserted by the CALLER before it gets here,
   * so an inactive branch produces one clear refusal instead of an empty grid
   * that looks like an empty shop.
   */
  async browse(
    query: PosCatalogQueryDto,
    branchId: number | null,
  ): Promise<PosCatalogPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 24;
    const search = query.search?.toLowerCase();

    const params: unknown[] = [];
    const where: string[] = [
      // A product with no ACTIVE variant has nothing sellable behind it, so it
      // never belongs on a till grid — not even as an "out of stock" tile.
      `EXISTS (SELECT 1 FROM product_variants av
                WHERE av."productId" = p.id AND av."isActive" = true)`,
    ];

    /*
     * THE BRANCH CHANNEL GATE (migration 0030).
     *
     * Pushed into the WHERE rather than filtered afterwards, so `COUNT(*)` and
     * the id page agree: filtering in TypeScript would paginate over rows the
     * cashier may not see and produce short, wrongly-numbered pages.
     *
     * `'all'` is matched as a MODE, never expanded into branch rows, which is
     * what lets a branch created next month inherit it with no catalogue
     * replay.
     */
    if (branchId !== null) {
      params.push(branchId);
      where.push(`(
        p."branchVisibility" = 'all'
        OR (
          p."branchVisibility" = 'selected'
          AND EXISTS (SELECT 1 FROM product_branch_visibility pbv
                       WHERE pbv."productId" = p.id
                         AND pbv."branchId" = $${params.length})
        )
      )`);
    }

    if (query.categoryId !== undefined) {
      params.push(query.categoryId);
      where.push(`EXISTS (SELECT 1 FROM product_category pc
                           WHERE pc.product_id = p.id
                             AND pc.category_id = $${params.length})`);
    }

    if (search) {
      params.push(`%${search}%`);
      const needle = `$${params.length}`;
      where.push(`(
        LOWER(p.title) LIKE ${needle}
        OR LOWER(p."productCode") LIKE ${needle}
        OR EXISTS (SELECT 1 FROM product_variants sv
                    WHERE sv."productId" = p.id
                      AND sv."isActive" = true
                      AND (LOWER(sv.sku) LIKE ${needle}
                           OR LOWER(sv."variantCode") LIKE ${needle}))
        OR EXISTS (SELECT 1 FROM product_variants sv2
                     JOIN variant_product_attribute_value sj
                       ON sj."productVariantsId" = sv2.id
                     JOIN product_attribute_value sav
                       ON sav.id = sj."productAttributeValueId"
                    WHERE sv2."productId" = p.id
                      AND sv2."isActive" = true
                      AND LOWER(sav.value) LIKE ${needle})
      )`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countRows = await this.rows<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM products p ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    if (total === 0 || (page - 1) * limit >= total) {
      return { data: [], total, page, limit, totalPages };
    }

    const idRows = await this.rows<IdRow>(
      `SELECT p.id FROM products p ${whereSql}
        ORDER BY p.id ASC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    const ids = idRows.map((r) => Number(r.id));
    if (ids.length === 0) {
      return { data: [], total, page, limit, totalPages };
    }

    const [variantRows, imageRows, categoryRows] = await Promise.all([
      this.rows<VariantRow>(
        `SELECT v."productId"        AS "productId",
                p.title              AS "productTitle",
                p."productCode"      AS "productCode",
                v.id                 AS "variantId",
                v.sku                AS sku,
                v."variantCode"      AS "variantCode",
                COALESCE(v.price, p."basePrice") AS price,
                av.id                AS "attributeValueId",
                av.value             AS "attributeValue",
                a.id                 AS "attributeId",
                a.name               AS "attributeName"
           FROM product_variants v
           JOIN products p ON p.id = v."productId"
           LEFT JOIN variant_product_attribute_value j
                  ON j."productVariantsId" = v.id
           LEFT JOIN product_attribute_value av
                  ON av.id = j."productAttributeValueId"
           LEFT JOIN product_attribute a ON a.id = av."attributeId"
          WHERE v."productId" = ANY($1::int[]) AND v."isActive" = true
          ORDER BY v.id ASC, a.id ASC NULLS LAST, av.id ASC`,
        [ids],
      ),
      this.rows<ImageRow>(
        `SELECT DISTINCT ON ("productId") "productId", id, url
           FROM product_images
          WHERE "productId" = ANY($1::int[])
          ORDER BY "productId", "sortOrder" NULLS LAST, id ASC`,
        [ids],
      ),
      this.rows<CategoryRow>(
        `SELECT pc.product_id AS "productId", c.id, c.title
           FROM product_category pc
           JOIN categories c ON c.id = pc.category_id
          WHERE pc.product_id = ANY($1::int[])
          ORDER BY c.id ASC`,
        [ids],
      ),
    ]);

    const variantIds = [
      ...new Set(variantRows.map((r) => Number(r.variantId))),
    ];
    const availability = await this.dataSource.transaction((manager) =>
      this.inventory.getAvailability(manager, variantIds),
    );

    const imageByProduct = new Map(
      imageRows.map((r) => [Number(r.productId), r]),
    );
    const categoriesByProduct = new Map<
      number,
      Array<{ id: number; title: string }>
    >();
    for (const row of categoryRows) {
      const list = categoriesByProduct.get(Number(row.productId)) ?? [];
      list.push({ id: Number(row.id), title: row.title });
      categoriesByProduct.set(Number(row.productId), list);
    }

    // One pass over the flattened variant x attribute join.
    const productTitle = new Map<number, string>();
    const productCode = new Map<number, string>();
    const variantsByProduct = new Map<
      number,
      Map<number, PosCatalogVariantView>
    >();
    for (const row of variantRows) {
      const productId = Number(row.productId);
      const variantId = Number(row.variantId);
      productTitle.set(productId, row.productTitle);
      productCode.set(productId, row.productCode);

      let byVariant = variantsByProduct.get(productId);
      if (!byVariant) {
        byVariant = new Map();
        variantsByProduct.set(productId, byVariant);
      }

      let variant = byVariant.get(variantId);
      if (!variant) {
        const snapshot = availability.get(variantId);
        const availableForPos = Math.max(snapshot?.availableForPos ?? 0, 0);
        variant = {
          id: variantId,
          sku: row.sku,
          variantCode: row.variantCode,
          price: row.price === null ? null : Number(row.price),
          attributeValues: [],
          availableForPos,
          inStock: availableForPos > 0,
        };
        byVariant.set(variantId, variant);
      }

      if (row.attributeValueId !== null && row.attributeValue !== null) {
        variant.attributeValues.push({
          id: Number(row.attributeValueId),
          value: row.attributeValue,
          ...(row.attributeId !== null && row.attributeName !== null
            ? {
                attribute: {
                  id: Number(row.attributeId),
                  name: row.attributeName,
                },
              }
            : {}),
        });
      }
    }

    // `ids` carries the page's order; the maps do not.
    const data: PosCatalogProductView[] = ids.map((id) => {
      const variants = [...(variantsByProduct.get(id)?.values() ?? [])];
      const prices = variants
        .map((v) => v.price)
        .filter((p): p is number => p !== null);
      const image = imageByProduct.get(id);
      return {
        id,
        title: productTitle.get(id) ?? '',
        productCode: productCode.get(id) ?? '',
        primaryImage: image ? { id: Number(image.id), url: image.url } : null,
        categories: categoriesByProduct.get(id) ?? [],
        effectivePrice: prices.length ? Math.min(...prices) : null,
        maxEffectivePrice: prices.length ? Math.max(...prices) : null,
        variants,
        inStock: variants.some((v) => v.inStock),
      };
    });

    return { data, total, page, limit, totalPages };
  }
}

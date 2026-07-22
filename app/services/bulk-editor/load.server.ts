/**
 * Bulk editor — row loading (docs/plans/PLAN_BULK_EDITOR.md §3.3).
 *
 * Server-only: reads one page of the content cache for a row type,
 * select-minimized to the fields the grid shows, with server-side search
 * (title + handle), filters (missing SEO halves, missing translation) and
 * sorting on DB-backed columns. The pure/client-safe pieces (descriptors,
 * diff, key format) live in columns.shared.ts; writing lives in
 * apply.server.ts.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import {
  type BulkRow,
  type BulkRowType,
  type BulkFilterId,
  type BulkSort,
  getColumnForType,
} from "./columns.shared";

export interface LoadBulkRowsOptions {
  type: BulkRowType;
  /** "" = primary locale. Only used by the missingTranslation filter in
   * Phase 1 (the locale selector itself lands in Phase 4). */
  locale: string;
  /** "" = global. Same Phase-4 note as `locale`. */
  marketId: string;
  search: string;
  filters: BulkFilterId[];
  sort: BulkSort | null;
  skip: number;
  take: number;
}

export interface LoadBulkRowsResult {
  rows: BulkRow[];
  total: number;
  /** True when the missingTranslation anti-join hit the notIn cap — the
   * filter result is approximate and the UI shows a hint banner (§3.3). */
  translationFilterApproximate: boolean;
}

/** Cap on the `id NOT IN (…)` list for the missing-translation anti-join.
 * Beyond this the filter is applied with the first 10k translated ids only
 * and flagged as approximate instead of shipping an unbounded list into the
 * query. */
const TRANSLATION_NOT_IN_CAP = 10_000;

const RESOURCE_TYPE_BY_ROW_TYPE: Record<BulkRowType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

interface BuiltWhere {
  /** AND-composed conditions, spread into the per-type where. */
  and: Record<string, unknown>[];
  translationFilterApproximate: boolean;
}

/** "field is missing" = NULL or empty string (§3.3). */
function missingField(field: string): Record<string, unknown> {
  return { OR: [{ [field]: null }, { [field]: "" }] };
}

async function buildWhere(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<BuiltWhere> {
  const and: Record<string, unknown>[] = [];
  let translationFilterApproximate = false;

  const search = opts.search.trim();
  if (search) {
    and.push({
      OR: [
        { title: { contains: search, mode: "insensitive" } },
        { handle: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  if (opts.filters.includes("missingSeoTitle")) and.push(missingField("seoTitle"));
  if (opts.filters.includes("missingSeoDescription")) and.push(missingField("seoDescription"));

  // Anti-join over ContentTranslation: ids WITH any translation row for
  // (locale, marketId) are excluded. Only meaningful with a concrete locale.
  if (opts.filters.includes("missingTranslation") && opts.locale !== "") {
    const translated = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceType: RESOURCE_TYPE_BY_ROW_TYPE[opts.type],
        locale: opts.locale,
        marketId: opts.marketId,
      },
      select: { resourceId: true },
      distinct: ["resourceId"],
      take: TRANSLATION_NOT_IN_CAP + 1,
    });
    let ids = translated.map((t) => t.resourceId);
    if (ids.length > TRANSLATION_NOT_IN_CAP) {
      ids = ids.slice(0, TRANSLATION_NOT_IN_CAP);
      translationFilterApproximate = true;
    }
    if (ids.length > 0) and.push({ id: { notIn: ids } });
  }

  return { and, translationFilterApproximate };
}

/** orderBy for a validated BulkSort — parseSortParam already guaranteed the
 * column is sortable for the type, so this just maps to the DB column.
 * Default stays title asc (the pre-rework behaviour). */
function buildOrderBy(type: BulkRowType, sort: BulkSort | null): Record<string, "asc" | "desc"> {
  if (sort) {
    const column = getColumnForType(type, sort.columnId);
    if (column?.sortKey) return { [column.sortKey]: sort.direction };
  }
  return { title: "asc" };
}

/**
 * One page of the content cache for `type`, select-minimized to the columns
 * the grid can show. Offset-paged via skip/take; all filtering/sorting is
 * server-side so 2.000-row catalogs stay usable (§3.3).
 */
export async function loadBulkRows(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  const { type, skip, take } = opts;
  const { and, translationFilterApproximate } = await buildWhere(db, shop, opts);
  const orderBy = buildOrderBy(type, opts.sort);

  switch (type) {
    case "product": {
      const where: Prisma.ProductWhereInput = { shop, AND: and as Prisma.ProductWhereInput[] };
      const select = {
        id: true,
        title: true,
        seoTitle: true,
        seoDescription: true,
        handle: true,
        descriptionHtml: true,
        productType: true,
        status: true,
        featuredImageUrl: true,
        featuredImageAlt: true,
      } as const;
      const [items, total] = await Promise.all([
        db.product.findMany({ where, select, orderBy, skip, take }),
        db.product.count({ where }),
      ]);
      return {
        rows: items.map((i) => ({
          id: i.id,
          type: "product" as const,
          title: i.title,
          seoTitle: i.seoTitle ?? "",
          seoDescription: i.seoDescription ?? "",
          handle: i.handle,
          descriptionHtml: i.descriptionHtml ?? "",
          productType: i.productType ?? "",
          status: i.status ?? "",
          imageUrl: i.featuredImageUrl ?? undefined,
          imageAlt: i.featuredImageAlt ?? undefined,
        })),
        total,
        translationFilterApproximate,
      };
    }
    case "collection": {
      const where: Prisma.CollectionWhereInput = { shop, AND: and as Prisma.CollectionWhereInput[] };
      const select = {
        id: true,
        title: true,
        seoTitle: true,
        seoDescription: true,
        handle: true,
        descriptionHtml: true,
        imageUrl: true,
        imageAltText: true,
      } as const;
      const [items, total] = await Promise.all([
        db.collection.findMany({ where, select, orderBy, skip, take }),
        db.collection.count({ where }),
      ]);
      return {
        rows: items.map((i) => ({
          id: i.id,
          type: "collection" as const,
          title: i.title,
          seoTitle: i.seoTitle ?? "",
          seoDescription: i.seoDescription ?? "",
          handle: i.handle,
          descriptionHtml: i.descriptionHtml ?? "",
          imageUrl: i.imageUrl ?? undefined,
          imageAlt: i.imageAltText ?? undefined,
        })),
        total,
        translationFilterApproximate,
      };
    }
    case "article": {
      const where: Prisma.ArticleWhereInput = { shop, AND: and as Prisma.ArticleWhereInput[] };
      const select = {
        id: true,
        title: true,
        seoTitle: true,
        seoDescription: true,
        handle: true,
        body: true,
        summary: true,
        imageUrl: true,
        imageAltText: true,
        blogTitle: true,
      } as const;
      const [items, total] = await Promise.all([
        db.article.findMany({ where, select, orderBy, skip, take }),
        db.article.count({ where }),
      ]);
      return {
        rows: items.map((i) => ({
          id: i.id,
          type: "article" as const,
          title: i.title,
          seoTitle: i.seoTitle ?? "",
          seoDescription: i.seoDescription ?? "",
          handle: i.handle,
          body: i.body ?? "",
          summary: i.summary ?? "",
          imageUrl: i.imageUrl ?? undefined,
          imageAlt: i.imageAltText ?? undefined,
          blogTitle: i.blogTitle ?? undefined,
        })),
        total,
        translationFilterApproximate,
      };
    }
    case "page": {
      const where: Prisma.PageWhereInput = { shop, AND: and as Prisma.PageWhereInput[] };
      const select = {
        id: true,
        title: true,
        seoTitle: true,
        seoDescription: true,
        handle: true,
        body: true,
      } as const;
      const [items, total] = await Promise.all([
        db.page.findMany({ where, select, orderBy, skip, take }),
        db.page.count({ where }),
      ]);
      return {
        rows: items.map((i) => ({
          id: i.id,
          type: "page" as const,
          title: i.title,
          seoTitle: i.seoTitle ?? "",
          seoDescription: i.seoDescription ?? "",
          handle: i.handle,
          body: i.body ?? "",
        })),
        total,
        translationFilterApproximate,
      };
    }
  }
}

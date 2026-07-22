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
import { isDefaultTitleOption } from "../../utils/shopify-product.utils";
import { debugLog } from "../../utils/debug";
import {
  type BulkRow,
  type BulkRowType,
  type BulkRowMetafield,
  type BulkRowOption,
  type BulkFilterId,
  type BulkSort,
  type MetafieldColumnSpec,
  type ProductColumnCaps,
  getColumnForType,
  metafieldColumnId,
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
  /** Phase 2 (product rows only): which dynamic cell payloads to load —
   * driven by the plan caps + the shop's enabled metafield columns
   * (columns.server.ts). Absent/empty = base fields only. */
  productCells?: {
    metafieldSpecs: MetafieldColumnSpec[];
    caps: ProductColumnCaps;
  };
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

/** Maps a ProductMetafield row set to the BulkRow.metafields record, keyed by
 * column id — only the enabled columns' keys are queried in the first place. */
function mapRowMetafields(
  metafields: { id: string; namespace: string; key: string; value: string; type: string }[] | undefined,
): Record<string, BulkRowMetafield> | undefined {
  if (!metafields || metafields.length === 0) return undefined;
  const record: Record<string, BulkRowMetafield> = {};
  for (const mf of metafields) {
    record[metafieldColumnId(mf.namespace, mf.key)] = { id: mf.id, value: mf.value, type: mf.type };
  }
  return record;
}

/** Parses ProductOption rows into the grid shape — both storage formats
 * ([{id,name}] and legacy ["string"]) exactly like sub-resources.action.ts /
 * the products loader, with the synthetic Title/Default Title option
 * filtered out. */
function mapRowOptions(
  options: { id: string; name: string; position: number; values: string; linkedMetafieldKey: string | null }[] | undefined,
): BulkRowOption[] | undefined {
  if (!options || options.length === 0) return undefined;
  const mapped: BulkRowOption[] = [];
  for (const opt of options) {
    let values: { id: string; name: string }[] = [];
    try {
      const parsed: unknown = JSON.parse(opt.values || "[]");
      if (Array.isArray(parsed)) {
        values = parsed.map((v: unknown) =>
          typeof v === "string"
            ? { id: "", name: v }
            : { id: String((v as { id?: unknown }).id ?? ""), name: String((v as { name?: unknown }).name ?? "") },
        );
      }
    } catch {
      values = [];
    }
    if (isDefaultTitleOption({ name: opt.name, values: values.map((v) => v.name) })) continue;
    mapped.push({
      id: opt.id,
      position: opt.position,
      name: opt.name,
      values,
      hasValueIds: values.length > 0 && values.every((v) => v.id !== ""),
      linked: !!opt.linkedMetafieldKey,
    });
  }
  return mapped.length > 0 ? mapped : undefined;
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
  const result = await loadBulkRowsInner(db, shop, opts);
  // §10.5: summaries only — never row/field values.
  debugLog.bulkLoad("page loaded", {
    type: opts.type,
    rows: result.rows.length,
    total: result.total,
    filters: opts.filters,
    hasSearch: opts.search.trim() !== "",
  });
  return result;
}

async function loadBulkRowsInner(
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
      const cells = opts.productCells;
      const metafieldSpecs = cells?.caps.metafields ? cells.metafieldSpecs : [];
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
        // Dynamic cell payloads (Phase 2), loaded only when the plan's cache
        // carries them (§10.7) — and for metafields only the ENABLED columns'
        // namespace/key pairs, not every metafield of the product.
        ...(metafieldSpecs.length > 0
          ? {
              metafields: {
                where: { OR: metafieldSpecs.map((s) => ({ namespace: s.namespace, key: s.key })) },
                select: { id: true, namespace: true, key: true, value: true, type: true },
              },
            }
          : {}),
        ...(cells?.caps.options
          ? {
              options: {
                orderBy: { position: "asc" as const },
                select: { id: true, name: true, position: true, values: true, linkedMetafieldKey: true },
              },
            }
          : {}),
        ...(cells?.caps.imageAlt
          ? {
              images: {
                orderBy: { position: "asc" as const },
                take: 1,
                select: { mediaId: true, altText: true },
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.product.findMany({ where, select, orderBy, skip, take }) as Promise<
          Array<
            Record<string, unknown> & {
              metafields?: { id: string; namespace: string; key: string; value: string; type: string }[];
              options?: { id: string; name: string; position: number; values: string; linkedMetafieldKey: string | null }[];
              images?: { mediaId: string | null; altText: string | null }[];
            }
          >
        >,
        db.product.count({ where }),
      ]);
      return {
        rows: items.map((i) => {
          const mainImage = i.images?.[0];
          return {
            id: i.id as string,
            type: "product" as const,
            title: i.title as string,
            seoTitle: (i.seoTitle as string | null) ?? "",
            seoDescription: (i.seoDescription as string | null) ?? "",
            handle: i.handle as string,
            descriptionHtml: (i.descriptionHtml as string | null) ?? "",
            productType: (i.productType as string | null) ?? "",
            status: (i.status as string | null) ?? "",
            imageUrl: (i.featuredImageUrl as string | null) ?? undefined,
            imageAlt: (i.featuredImageAlt as string | null) ?? undefined,
            metafields: mapRowMetafields(i.metafields),
            options: mapRowOptions(i.options),
            mainImage: mainImage
              ? { mediaId: mainImage.mediaId ?? null, alt: mainImage.altText ?? "" }
              : undefined,
          };
        }),
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

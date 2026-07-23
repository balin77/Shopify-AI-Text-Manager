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
import { translationKeysByColumnId } from "./translations.server";
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
  metaobjectColumnId,
} from "./columns.shared";

/** Minimal admin-client surface the blog live-fetch needs — the same shape
 * getShopCurrencyCode already accepts. */
export interface BulkAdminClient {
  graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response>;
}

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
  /** Restrict to exactly these row ids (CSV import, Plan §8.2 — the import
   * diffs against the CURRENT DB values of the referenced rows): content
   * types match on `id`, variant rows on `shopifyGid`. AND-combined with the
   * other filters. */
  ids?: string[];
  /** Phase 2 (product rows only): which dynamic cell payloads to load —
   * driven by the plan caps + the shop's enabled metafield columns
   * (columns.server.ts). Absent/empty = base fields only. */
  productCells?: {
    metafieldSpecs: MetafieldColumnSpec[];
    caps: ProductColumnCaps;
  };
  /** REQUIRED for type "blog" (Phase 5, Plan §7): blog containers have no DB
   * cache — they are live-fetched from Shopify in the loader. Blogs are a
   * two-digit population, so one un-paginated blogs(first:250) query per page
   * view is acceptable; search/filter/sort/pagination then run IN MEMORY on
   * the server so the semantics (URL params, counts) stay identical to the
   * DB-backed types. */
  admin?: BulkAdminClient;
  /** Metaobject rows only (Phase 5): restrict to ONE MetaobjectDefinition
   * type — the toolbar's mandatory type filter (metaobjects are only
   * schema-homogeneous per type). "" / absent = no restriction (used by the
   * CSV import, which resolves rows by id). */
  moType?: string;
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
  variant: "ProductVariant", // unused in practice — variant columns are never translatable
  collection: "Collection",
  article: "Article",
  page: "Page",
  blog: "Blog",
  policy: "ShopPolicy",
  metaobject: "Metaobject", // unused — metaobjects read MetaobjectTranslation instead
};

// ─── Shop currency (Phase 3 — Plan §5.2) ───────────────────────────────────

/** Shop → currencyCode memo. The currency is shop-wide and effectively never
 * changes (changing it is a support-gated Shopify operation), so a plain
 * process-lifetime cache is enough — one query per shop per boot. */
const currencyCodeCache = new Map<string, string>();

/** Shop-wide currency code ("EUR", "USD") shown as a suffix on the money
 * column headers. Degrades to "" on any error — the grid then shows the
 * plain header. */
export async function getShopCurrencyCode(
  admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
  shop: string,
): Promise<string> {
  const cached = currencyCodeCache.get(shop);
  if (cached !== undefined) return cached;
  try {
    const response = await admin.graphql(
      `#graphql
        query bulkEditorShopCurrency {
          shop {
            currencyCode
          }
        }`,
    );
    const data = (await response.json()) as { data?: { shop?: { currencyCode?: string | null } } };
    const code = data.data?.shop?.currencyCode ?? "";
    if (code) currencyCodeCache.set(shop, code);
    return code;
  } catch {
    return "";
  }
}

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
  /** DB columns the free-text search matches — policies have no handle (and
   * no SEO fields), so their branch narrows this to ["title"]. */
  searchFields: string[] = ["title", "handle"],
): Promise<BuiltWhere> {
  const and: Record<string, unknown>[] = [];
  let translationFilterApproximate = false;

  if (opts.ids) and.push({ id: { in: opts.ids } });

  const search = opts.search.trim();
  if (search) {
    and.push({
      OR: searchFields.map((field) => ({ [field]: { contains: search, mode: "insensitive" } })),
    });
  }

  // Policies/metaobjects have no SEO columns — their branches never receive
  // these filter ids (the FilterBar hides them), and a hand-crafted URL param
  // hitting them here would raise a Prisma unknown-column error rather than
  // silently lying, so the guard lives in the branch, not here.
  if (opts.filters.includes("missingSeoTitle")) and.push(missingField("seoTitle"));
  if (opts.filters.includes("missingSeoDescription")) and.push(missingField("seoDescription"));

  // Anti-join over ContentTranslation: ids WITH a translation row for
  // (locale, marketId) are excluded. Only meaningful with a concrete locale.
  // Phase 4 refinement: the join is restricted to the KEYS the grid's
  // translatable columns actually carry for this type (title, body_html, …) —
  // a stray row under some other key must not make a resource count as
  // "translated" for the grid's purposes.
  if (opts.filters.includes("missingTranslation") && opts.locale !== "") {
    const columnKeys = [...new Set(translationKeysByColumnId(opts.type).values())];
    const translated = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceType: RESOURCE_TYPE_BY_ROW_TYPE[opts.type],
        locale: opts.locale,
        marketId: opts.marketId,
        key: { in: columnKeys },
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
  if (opts.locale !== "") {
    await attachForeignValues(db, shop, opts, result.rows);
  }
  // §10.5: summaries only — never row/field values.
  debugLog.bulkLoad("page loaded", {
    type: opts.type,
    rows: result.rows.length,
    total: result.total,
    filters: opts.filters,
    locale: opts.locale,
    hasMarket: opts.marketId !== "",
    hasSearch: opts.search.trim() !== "",
  });
  return result;
}

/**
 * Fills BulkRow.foreignValues (`${locale}|${marketId}|${columnId}` → value)
 * from ContentTranslation for the page's rows (Phase 4). With a concrete
 * market selected, the GLOBAL rows (marketId "") are loaded too — the grid
 * shows the global value as the ghost under a market override, and the diff
 * baseline needs the market layer itself.
 */
async function attachForeignValues(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
  rows: BulkRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // Metaobject translations live in their OWN table
  // (MetaobjectTranslation, unique shop_metaobjectId_key_locale_marketId) —
  // not in ContentTranslation like every other content type.
  if (opts.type === "metaobject") {
    return attachMetaobjectForeignValues(db, shop, opts, rows);
  }
  const keyByColumnId = translationKeysByColumnId(opts.type);
  if (keyByColumnId.size === 0) return;
  // Reverse map: Shopify key → columnId (bijective per type — each key backs
  // exactly one column of a given row type).
  const columnIdByKey = new Map<string, string>();
  for (const [columnId, key] of keyByColumnId) columnIdByKey.set(key, columnId);

  const marketIds = opts.marketId !== "" ? ["", opts.marketId] : [""];
  const translations = await db.contentTranslation.findMany({
    where: {
      shop,
      resourceType: RESOURCE_TYPE_BY_ROW_TYPE[opts.type],
      resourceId: { in: rows.map((r) => r.id) },
      locale: opts.locale,
      marketId: { in: marketIds },
      key: { in: [...columnIdByKey.keys()] },
    },
    select: { resourceId: true, key: true, value: true, marketId: true },
  });
  if (translations.length === 0) return;

  const byRow = new Map<string, Record<string, string>>();
  for (const t of translations) {
    const columnId = columnIdByKey.get(t.key);
    if (!columnId) continue;
    let record = byRow.get(t.resourceId);
    if (!record) {
      record = {};
      byRow.set(t.resourceId, record);
    }
    record[`${opts.locale}|${t.marketId}|${columnId}`] = t.value;
  }
  for (const row of rows) {
    const record = byRow.get(row.id);
    if (record) row.foreignValues = record;
  }
}

async function loadBulkRowsInner(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  const { type, skip, take } = opts;
  // Variant rows join a different table shape (product context, price/sku
  // filters, nested sort) — they bypass the content-type where builder.
  if (type === "variant") {
    return loadVariantRows(db, shop, opts);
  }
  // Phase-5 shapes with their own sources: blog containers are LIVE-fetched
  // (no DB model), policies have no handle/SEO columns, metaobjects filter by
  // definition type and read MetaobjectTranslation.
  if (type === "blog") {
    return loadBlogRows(db, shop, opts);
  }
  if (type === "policy") {
    return loadPolicyRows(db, shop, opts);
  }
  if (type === "metaobject") {
    return loadMetaobjectRows(db, shop, opts);
  }
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

// ─── Variant rows (Phase 3 — Plan §5.3) ────────────────────────────────────

/** Decimal → normalized grid string ("1299.90"; "" = unset). The reverse
 * (Money string → Decimal) lives in product-variant-sync.server.ts — this is
 * pure read-side formatting of the already-normalized column. */
function decimalToGridValue(value: { toFixed(digits: number): string } | null): string {
  return value === null ? "" : value.toFixed(2);
}

/**
 * One page of variant rows: one row = one variant, with the product joined
 * for the read-only context columns (image, title) and the search. Search
 * matches variant title, SKU AND product title (Plan §5.3); the price/SKU
 * filters and all sorts are DB-side.
 */
async function loadVariantRows(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  const { skip, take } = opts;
  const and: Prisma.ProductVariantWhereInput[] = [];

  // Row ids of variant rows are the variant GIDs (shopifyGid), not the
  // numeric primary key — see the row mapping below.
  if (opts.ids) and.push({ shopifyGid: { in: opts.ids } });

  const search = opts.search.trim();
  if (search) {
    and.push({
      OR: [
        { title: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
        { product: { title: { contains: search, mode: "insensitive" } } },
      ],
    });
  }
  if (opts.filters.includes("missingSku")) {
    and.push({ OR: [{ sku: null }, { sku: "" }] });
  }
  if (opts.filters.includes("missingPrice")) {
    and.push({ price: null });
  }
  if (opts.filters.includes("compareAtNotAbovePrice")) {
    // The classic data error: a compare-at price that is not ABOVE the price
    // renders no strikethrough and confuses merchants. Column-to-column
    // comparison via Prisma field references (GA since Prisma 5).
    and.push({
      compareAtPrice: { not: null, lte: db.productVariant.fields.price },
      price: { not: null },
    });
  }

  const where: Prisma.ProductVariantWhereInput = { product: { shop }, AND: and };

  // DB-backed sorts only (§3.3): variant title/sku/price/compareAtPrice/
  // position plus the product title (nested). Default mirrors the Shopify
  // admin: product title, then variant position.
  let orderBy: Prisma.ProductVariantOrderByWithRelationInput[] = [
    { product: { title: "asc" } },
    { position: "asc" },
  ];
  if (opts.sort) {
    const column = getColumnForType("variant", opts.sort.columnId);
    const key = column?.sortKey;
    if (key === "productTitle") {
      orderBy = [{ product: { title: opts.sort.direction } }, { position: "asc" }];
    } else if (key === "title" || key === "sku" || key === "price" || key === "compareAtPrice" || key === "position") {
      orderBy = [{ [key]: opts.sort.direction }, { position: "asc" }];
    }
  }

  const select = {
    shopifyGid: true,
    title: true,
    sku: true,
    price: true,
    compareAtPrice: true,
    barcode: true,
    position: true,
    product: {
      select: {
        id: true,
        title: true,
        featuredImageUrl: true,
        featuredImageAlt: true,
        hasMoreVariants: true,
      },
    },
  } as const;

  const [items, total] = await Promise.all([
    db.productVariant.findMany({ where, select, orderBy, skip, take }),
    db.productVariant.count({ where }),
  ]);

  return {
    rows: items.map((v) => ({
      // The ROW id is the variant GID (shopifyGid) — ProductVariant.id is the
      // numeric Shopify id, and the diff validation requires GID shape.
      id: v.shopifyGid,
      type: "variant" as const,
      title: v.title,
      seoTitle: "",
      seoDescription: "",
      handle: "",
      productId: v.product.id,
      productTitle: v.product.title,
      imageUrl: v.product.featuredImageUrl ?? undefined,
      imageAlt: v.product.featuredImageAlt ?? undefined,
      sku: v.sku ?? "",
      price: decimalToGridValue(v.price),
      compareAtPrice: decimalToGridValue(v.compareAtPrice),
      barcode: v.barcode ?? "",
      position: v.position,
      hasMoreVariants: v.product.hasMoreVariants,
    })),
    total,
    translationFilterApproximate: false,
  };
}

// ─── Blog container rows (Phase 5 — Plan §7) ───────────────────────────────

/** Un-paginated ceiling of the live blogs query — matches app.blog.tsx. A
 * shop with 250+ blogs would be truncated; blogs are realistically two-digit
 * (that is WHY the live fetch is acceptable, Plan §7). */
const BLOGS_QUERY_FIRST = 250;

interface LiveBlogNode {
  id: string;
  title: string;
  handle: string;
  seoTitle?: { value: string } | null;
  seoDescription?: { value: string } | null;
}

/**
 * Blog containers have NO DB cache (Plan §0.3) — one live blogs(first:250)
 * query, then search/filters/sort/pagination IN MEMORY on the server
 * (documented decision: server-side like every other type, so URL params,
 * counts and CSV export behave identically; the population is tiny). SEO
 * title/description come from the global.title_tag / description_tag
 * METAFIELDS — same source the single editor reads (app.blog.tsx).
 */
async function loadBlogRows(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  if (!opts.admin) {
    throw new Error("Blog rows require a live Shopify fetch — no admin client was provided.");
  }
  const response = await opts.admin.graphql(
    `#graphql
      query bulkEditorBlogs {
        blogs(first: ${BLOGS_QUERY_FIRST}) {
          edges {
            node {
              id
              title
              handle
              seoTitle: metafield(namespace: "global", key: "title_tag") { value }
              seoDescription: metafield(namespace: "global", key: "description_tag") { value }
            }
          }
        }
      }`,
  );
  const data = (await response.json()) as {
    data?: { blogs?: { edges?: { node: LiveBlogNode }[] } };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  let rows: BulkRow[] = (data.data?.blogs?.edges ?? []).map(({ node }) => ({
    id: node.id,
    type: "blog" as const,
    title: node.title,
    seoTitle: node.seoTitle?.value ?? "",
    seoDescription: node.seoDescription?.value ?? "",
    handle: node.handle,
  }));

  if (opts.ids) {
    const wanted = new Set(opts.ids);
    rows = rows.filter((r) => wanted.has(r.id));
  }
  const search = opts.search.trim().toLowerCase();
  if (search) {
    rows = rows.filter(
      (r) => r.title.toLowerCase().includes(search) || r.handle.toLowerCase().includes(search),
    );
  }
  if (opts.filters.includes("missingSeoTitle")) rows = rows.filter((r) => r.seoTitle === "");
  if (opts.filters.includes("missingSeoDescription")) rows = rows.filter((r) => r.seoDescription === "");
  if (opts.filters.includes("missingTranslation") && opts.locale !== "" && rows.length > 0) {
    // Same anti-join as the DB-backed types, evaluated in memory: blogs WITH
    // a ContentTranslation row (resourceType "Blog", grid-relevant keys) for
    // the selected locale/market drop out.
    const columnKeys = [...new Set(translationKeysByColumnId("blog").values())];
    const translated = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceType: RESOURCE_TYPE_BY_ROW_TYPE.blog,
        resourceId: { in: rows.map((r) => r.id) },
        locale: opts.locale,
        marketId: opts.marketId,
        key: { in: columnKeys },
      },
      select: { resourceId: true },
      distinct: ["resourceId"],
    });
    const translatedIds = new Set(translated.map((t) => t.resourceId));
    rows = rows.filter((r) => !translatedIds.has(r.id));
  }

  // In-memory sort on the columns that declare a sortKey (title, handle) —
  // the same contract parseSortParam validated against.
  const sortColumn = opts.sort ? getColumnForType("blog", opts.sort.columnId) : undefined;
  const sortKey = sortColumn?.sortKey === "handle" ? "handle" : "title";
  const direction = opts.sort?.direction === "desc" ? -1 : 1;
  rows.sort((a, b) => direction * a[sortKey].localeCompare(b[sortKey]));

  const total = rows.length;
  return {
    rows: rows.slice(opts.skip, opts.skip + opts.take),
    total,
    translationFilterApproximate: false,
  };
}

// ─── Policy rows (Phase 5 — Plan §7) ───────────────────────────────────────

/**
 * ShopPolicy rows from the DB cache. Policies have NO handle and NO SEO
 * columns — search runs on the title only, and the SEO filter ids are
 * stripped (the FilterBar never offers them for this type; a hand-crafted
 * URL param must not become a Prisma unknown-column error). Title renders
 * read-only (§14: shopPolicyUpdate has no title input); only `body` edits.
 */
async function loadPolicyRows(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  const supported = opts.filters.filter((f) => f === "missingTranslation");
  const { and, translationFilterApproximate } = await buildWhere(
    db,
    shop,
    { ...opts, filters: supported },
    ["title"],
  );
  const where: Prisma.ShopPolicyWhereInput = { shop, AND: and as Prisma.ShopPolicyWhereInput[] };
  const orderBy = buildOrderBy("policy", opts.sort);
  const select = { id: true, title: true, body: true, type: true } as const;
  const [items, total] = await Promise.all([
    db.shopPolicy.findMany({ where, select, orderBy, skip: opts.skip, take: opts.take }),
    db.shopPolicy.count({ where }),
  ]);
  return {
    rows: items.map((i) => ({
      id: i.id,
      type: "policy" as const,
      title: i.title,
      seoTitle: "",
      seoDescription: "",
      handle: "",
      body: i.body ?? "",
    })),
    total,
    translationFilterApproximate,
  };
}

// ─── Metaobject rows (Phase 5 — Plan §7) ───────────────────────────────────

/**
 * Metaobject rows, restricted to ONE definition type via opts.moType (the
 * toolbar's mandatory type filter — without it the column set would be the
 * union of every definition). Field values come from the Metaobject.fields
 * JSON, keyed by column id ("mo.<type>.<key>"); the missingTranslation
 * anti-join runs against MetaobjectTranslation (not ContentTranslation).
 */
async function loadMetaobjectRows(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
): Promise<LoadBulkRowsResult> {
  const and: Prisma.MetaobjectWhereInput[] = [];
  if (opts.ids) and.push({ id: { in: opts.ids } });
  if (opts.moType) and.push({ type: opts.moType });
  const search = opts.search.trim();
  if (search) {
    and.push({
      OR: [
        { displayName: { contains: search, mode: "insensitive" } },
        { handle: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  let translationFilterApproximate = false;
  if (opts.filters.includes("missingTranslation") && opts.locale !== "") {
    const translated = await db.metaobjectTranslation.findMany({
      where: {
        shop,
        ...(opts.moType ? { type: opts.moType } : {}),
        locale: opts.locale,
        marketId: opts.marketId,
      },
      select: { metaobjectId: true },
      distinct: ["metaobjectId"],
      take: TRANSLATION_NOT_IN_CAP + 1,
    });
    let ids = translated.map((t) => t.metaobjectId);
    if (ids.length > TRANSLATION_NOT_IN_CAP) {
      ids = ids.slice(0, TRANSLATION_NOT_IN_CAP);
      translationFilterApproximate = true;
    }
    if (ids.length > 0) and.push({ id: { notIn: ids } });
  }

  const where: Prisma.MetaobjectWhereInput = { shop, AND: and };
  const sortColumn = opts.sort ? getColumnForType("metaobject", opts.sort.columnId) : undefined;
  const orderBy: Prisma.MetaobjectOrderByWithRelationInput =
    sortColumn?.sortKey === "handle"
      ? { handle: opts.sort!.direction }
      : sortColumn?.sortKey === "displayName"
        ? { displayName: opts.sort!.direction }
        : { displayName: "asc" };

  const select = { id: true, type: true, handle: true, displayName: true, fields: true } as const;
  const [items, total] = await Promise.all([
    db.metaobject.findMany({ where, select, orderBy, skip: opts.skip, take: opts.take }),
    db.metaobject.count({ where }),
  ]);

  return {
    rows: items.map((i) => {
      // fields JSON shape (metaobject-sync.service.ts): [{key, value, type}].
      const moFields: Record<string, string> = {};
      const fields = Array.isArray(i.fields) ? i.fields : [];
      for (const raw of fields) {
        if (!raw || typeof raw !== "object") continue;
        const field = raw as { key?: unknown; value?: unknown };
        if (typeof field.key !== "string") continue;
        moFields[metaobjectColumnId(i.type, field.key)] =
          typeof field.value === "string" ? field.value : "";
      }
      return {
        id: i.id,
        type: "metaobject" as const,
        title: i.displayName,
        seoTitle: "",
        seoDescription: "",
        handle: i.handle,
        moType: i.type,
        moFields,
      };
    }),
    total,
    translationFilterApproximate,
  };
}

/** MetaobjectTranslation → BulkRow.foreignValues, the metaobject counterpart
 * of the ContentTranslation attachment above (same key format
 * `${locale}|${marketId}|${columnId}`, same global-layer inclusion under a
 * market override). */
async function attachMetaobjectForeignValues(
  db: PrismaClient,
  shop: string,
  opts: LoadBulkRowsOptions,
  rows: BulkRow[],
): Promise<void> {
  const marketIds = opts.marketId !== "" ? ["", opts.marketId] : [""];
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const translations = await db.metaobjectTranslation.findMany({
    where: {
      shop,
      metaobjectId: { in: rows.map((r) => r.id) },
      locale: opts.locale,
      marketId: { in: marketIds },
    },
    select: { metaobjectId: true, key: true, value: true, marketId: true },
  });
  for (const t of translations) {
    const row = byId.get(t.metaobjectId);
    if (!row || !row.moType) continue;
    const columnId = metaobjectColumnId(row.moType, t.key);
    row.foreignValues = row.foreignValues ?? {};
    row.foreignValues[`${opts.locale}|${t.marketId}|${columnId}`] = t.value;
  }
}

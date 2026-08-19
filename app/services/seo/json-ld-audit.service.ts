/**
 * JSON-LD Batch Audit (Phase 5 of PLAN_SEO_SUITE_COMPLETION.md §7).
 *
 * Extends the existing structured-data feature (structured-data.service.ts)
 * from "one example item per type" to a catalog-wide QS report: every
 * Product / Collection / Article in the DB content cache gets its JSON-LD
 * built via the existing pure builders and run through the existing
 * `validateJsonLd`, then warnings are aggregated by code (count + capped
 * affected-item list) — the same bucket shape `analyzeStore` uses for the
 * dashboard's problem buckets (MAX_PROBLEM_BUCKET_ITEMS).
 *
 * DB-cache-first, same as every other SEO section (contract §3/§6): no live
 * GraphQL catalog sweep. Two consequences worth knowing before reading the
 * code below:
 *
 *  - Pages have no JSON-LD schema anywhere in this app (no `buildPageJsonLd`
 *    exists in structured-data.service.ts, and the storefront Liquid block
 *    — extensions/storefront/blocks/structured-data.liquid — never emits a
 *    WebPage type either). Adding a brand-new schema.org type end-to-end
 *    (service + storefront emission) is out of scope for "extend the
 *    existing feature" — this audit covers product/collection/article only.
 *  - Product availability (`ProductVariant` has no `availableForSale`/
 *    inventory column) and Article `publishedAt` (no such column on
 *    `Article` at all) are not in the DB cache, so both builders are called
 *    with `validateJsonLd(..., { previewMode: true })` — see the doc comment
 *    on `ValidateJsonLdOptions.previewMode` for why that's the honest choice
 *    over a report that's 100% false-positive noise on those two codes.
 */

import type { PrismaClient } from "@prisma/client";
import {
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  validateJsonLd,
  slugify,
  type ShopInfo,
  type JsonLdWarningCode,
} from "../structured-data.service";
import { MAX_AUDIT_ITEMS_PER_TYPE, MAX_PROBLEM_BUCKET_ITEMS } from "./audit.service";
import type { MarkupTypeStat } from "./markup-activation.shared";
import { loadCrawlMarkupPages } from "./crawl-markup-rows.server";

export type JsonLdAuditItemType = "product" | "collection" | "article";

export interface JsonLdAuditItemRef {
  type: JsonLdAuditItemType;
  id: string; // Shopify GID — editor deep-link (?select=<GID>)
  title: string;
  /** Absolute storefront URL, when the shop domain resolved it — feeds both
   *  the Google Rich Results Test deep-link and a "view live" link. Null
   *  only if the shop domain itself couldn't be determined. */
  url: string | null;
}

export interface JsonLdAuditBucket {
  code: JsonLdWarningCode;
  severity: "error" | "warning" | "info";
  /** TRUE total of affected items — never capped (mirrors AuditProblemBucket). */
  count: number;
  /** Affected item refs, capped at MAX_PROBLEM_BUCKET_ITEMS. */
  items: JsonLdAuditItemRef[];
}

export interface JsonLdAuditAggregate {
  generatedAt: string; // ISO
  totalScanned: number;
  totalAvailable: number;
  /** true when any type hit MAX_AUDIT_ITEMS_PER_TYPE — the report covers a
   *  prefix of the catalog, not the whole thing. */
  capped: boolean;
  buckets: JsonLdAuditBucket[];
}

export interface JsonLdAuditDeps {
  db: PrismaClient;
  /** Shop name/domain — same shape the structured-data preview route builds
   *  (fetchShopInfo), passed in here so this service stays DB-only/pure and
   *  testable without mocking admin.graphql. */
  shopInfo: ShopInfo;
  /** Shop-wide currency code ("EUR", "USD", …) — empty string when unknown
   *  (offerNoCurrency will then correctly fire for every product). */
  currencyCode: string;
  /** Called every `heartbeatEvery`-th item (default 100) and once more at the
   *  end, so the caller can bump Task.progress — the Task-row write itself IS
   *  the heartbeat (contract §8). Errors thrown here propagate to the caller. */
  onProgress?: (processed: number, total: number) => void | Promise<void>;
  heartbeatEvery?: number;
}

function newBucket(code: JsonLdWarningCode, severity: "error" | "warning" | "info"): JsonLdAuditBucket {
  return { code, severity, count: 0, items: [] };
}

function record(
  buckets: Map<JsonLdWarningCode, JsonLdAuditBucket>,
  warnings: { code: JsonLdWarningCode; severity: "error" | "warning" | "info" }[],
  ref: JsonLdAuditItemRef,
): void {
  for (const w of warnings) {
    let bucket = buckets.get(w.code);
    if (!bucket) {
      bucket = newBucket(w.code, w.severity);
      buckets.set(w.code, bucket);
    }
    bucket.count += 1;
    if (bucket.items.length < MAX_PROBLEM_BUCKET_ITEMS) bucket.items.push(ref);
  }
}

/**
 * Runs the batch JSON-LD QS report over the shop's cached catalog. Pure
 * DB-read + pure builders/validator — no Shopify API calls, no writes.
 */
export async function runJsonLdAudit(
  shop: string,
  deps: JsonLdAuditDeps,
): Promise<JsonLdAuditAggregate> {
  const { db, shopInfo, currencyCode, onProgress, heartbeatEvery = 100 } = deps;
  const take = MAX_AUDIT_ITEMS_PER_TYPE;

  // ---- Fetch everything up front (three DB-cache reads, no live calls) ----
  const [productCount, products] = await Promise.all([
    // ACTIVE only — deliberately NOT extended to UNLISTED the way
    // audit.service.ts was (AUDITABLE_PRODUCT_STATUSES). Structured data earns
    // its keep through rich results, and Shopify serves unlisted product pages
    // `noindex,nofollow` (measured — see sitemap.service.ts's header), so a
    // JSON-LD gap on one of them has no search-facing consequence to report.
    db.product.count({ where: { shop, status: "ACTIVE" } }),
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: {
        id: true,
        title: true,
        descriptionHtml: true,
        handle: true,
        seoDescription: true,
        featuredImageUrl: true,
        images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
      },
      orderBy: { lastSyncedAt: "desc" },
      take,
    }),
  ]);
  const productIds = products.map((p) => p.id);
  // One batched read for every product's first (lowest-position) variant —
  // avoids an N+1 of one findMany per product. Mirrors the groupBy technique
  // audit.service.ts uses for alt-coverage.
  const variantRows =
    productIds.length > 0
      ? await db.productVariant.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, position: true, price: true, barcode: true },
          orderBy: [{ productId: "asc" }, { position: "asc" }],
        })
      : [];
  const firstVariantByProduct = new Map<string, { price: unknown; barcode: string | null }>();
  for (const v of variantRows) {
    if (!firstVariantByProduct.has(v.productId)) {
      firstVariantByProduct.set(v.productId, { price: v.price, barcode: v.barcode });
    }
  }

  const [collectionCount, collections] = await Promise.all([
    db.collection.count({ where: { shop } }),
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true, descriptionHtml: true, handle: true, seoDescription: true },
      orderBy: { lastSyncedAt: "desc" },
      take,
    }),
  ]);

  const [articleCount, articles] = await Promise.all([
    db.article.count({ where: { shop } }),
    db.article.findMany({
      where: { shop },
      select: {
        id: true,
        title: true,
        body: true,
        summary: true,
        handle: true,
        blogTitle: true,
        imageUrl: true,
      },
      orderBy: { lastSyncedAt: "desc" },
      take,
    }),
  ]);

  const totalAvailable = productCount + collectionCount + articleCount;
  const capped =
    productCount > products.length ||
    collectionCount > collections.length ||
    articleCount > articles.length;
  const totalScanned = products.length + collections.length + articles.length;

  // ---- Build + validate every item, aggregating warnings by code ----------
  const buckets = new Map<JsonLdWarningCode, JsonLdAuditBucket>();
  let processed = 0;

  const heartbeat = async () => {
    processed += 1;
    if (onProgress && processed % heartbeatEvery === 0) {
      await onProgress(processed, totalScanned);
    }
  };

  for (const p of products) {
    const imageUrl = p.featuredImageUrl || p.images[0]?.url || null;
    const variant = firstVariantByProduct.get(p.id);
    const priceStr =
      variant?.price != null ? (variant.price as { toString(): string }).toString() : null;
    const jsonLd = buildProductJsonLd(
      {
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        handle: p.handle,
        seoDescription: p.seoDescription,
        featuredImageUrl: imageUrl,
        price: priceStr,
        currency: currencyCode || null,
        // Availability genuinely isn't in the DB cache — see file header.
        available: null,
        gtin: variant?.barcode ?? null,
      },
      shopInfo,
    );
    const warnings = validateJsonLd(jsonLd, { previewMode: true });
    record(buckets, warnings, {
      type: "product",
      id: p.id,
      title: p.title,
      url: typeof jsonLd.url === "string" ? jsonLd.url : null,
    });
    await heartbeat();
  }

  for (const c of collections) {
    const jsonLd = buildCollectionJsonLd(
      {
        title: c.title,
        descriptionHtml: c.descriptionHtml,
        handle: c.handle,
        seoDescription: c.seoDescription,
      },
      shopInfo,
    );
    const warnings = validateJsonLd(jsonLd, { previewMode: true });
    record(buckets, warnings, {
      type: "collection",
      id: c.id,
      title: c.title,
      url: typeof jsonLd.url === "string" ? jsonLd.url : null,
    });
    await heartbeat();
  }

  for (const a of articles) {
    const jsonLd = buildArticleJsonLd(
      {
        title: a.title,
        body: a.body,
        summary: a.summary,
        handle: a.handle,
        blogHandle: slugify(a.blogTitle || ""),
        imageUrl: a.imageUrl,
        // Article.publishedAt isn't cached anywhere (see file header) —
        // validateJsonLd is called with previewMode:true so its absence
        // doesn't fire articleNoDatePublished as noise.
        publishedAt: null,
        updatedAt: null,
      },
      shopInfo,
    );
    const warnings = validateJsonLd(jsonLd, { previewMode: true });
    record(buckets, warnings, {
      type: "article",
      id: a.id,
      title: a.title,
      url: typeof jsonLd.url === "string" ? jsonLd.url : null,
    });
    await heartbeat();
  }

  if (onProgress) await onProgress(totalScanned, totalScanned);

  // Deterministic ordering: worst-affecting-count first, ties broken by code
  // so the UI/test snapshot don't churn on Map iteration order.
  const bucketList = Array.from(buckets.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.code.localeCompare(b.code);
  });

  return {
    generatedAt: new Date().toISOString(),
    totalScanned,
    totalAvailable,
    capped,
    buckets: bucketList,
  };
}

// ── Live coverage from the last crawl (§ "is it actually served?") ─────────
//
// Everything above answers "is the markup the app would build correct?". It
// reads the DB cache and never sees a storefront page. That leaves the one
// question a merchant actually asks first — "is structured data on my pages at
// all?" — unanswered, and it is not answerable from the Admin API: what a
// storefront serves is the sum of the theme's own markup, this app's embed and
// any other app's, none of which is queryable.
//
// The crawler already downloads and parses every page, so it records the
// `@type` values it sees (SeoCrawlPage.jsonLdTypes). This section turns those
// rows into the coverage report. It therefore reports what IS served, never
// WHO served it — theme markup and app markup are indistinguishable in the
// delivered HTML, and pretending otherwise would be a guess.

/** Type expected on each crawled resource type. Pages have no schema in this
 *  app (no buildPageJsonLd exists, and the storefront block emits none), so
 *  they are counted but never reported as "missing". */
const EXPECTED_TYPE_BY_RESOURCE: Record<string, string[]> = {
  product: ["Product", "ProductGroup"],
  collection: ["CollectionPage"],
  article: ["BlogPosting", "Article"],
};

/**
 * schema.org types that describe the SAME thing about a page, collapsed onto
 * one canonical name before duplicates are counted.
 *
 * Exact @type matching missed the most common duplication there is: Dawn emits
 * `Article` for a blog post while this app emits `BlogPosting`. BlogPosting is
 * a subtype of Article, so both claim to be *the* article of that page and
 * Google has to pick one — a duplicate by every meaning that matters, invisible
 * to a string comparison. Same for Product/ProductGroup, where Shopify's own
 * structured_data filter emits the latter for products with variants.
 *
 * Deliberately narrow: only pairs where both types describe the page's primary
 * entity. Two different types that legitimately coexist (Organization and
 * BreadcrumbList, say) must never be folded together.
 */
const EQUIVALENT_TYPE: Record<string, string> = {
  ProductGroup: "Product",
  BlogPosting: "Article",
  NewsArticle: "Article",
};

/** Canonical name a type is counted under when looking for duplicates. */
/**
 * Types that legitimately appear MORE THAN ONCE on one page, so the duplicate
 * rule must not fire on them.
 *
 * The rule exists to catch the classic Shopify defect: the theme emits a
 * Product and an app emits a second one, and Google sees two claims about the
 * same page. A page with three product videos carries three VideoObjects for
 * the same reason it carries three videos — that is the markup working, not a
 * collision. Without this exception our own storefront block would trip our own
 * audit and blame the app for it.
 */
export const REPEATABLE_JSON_LD_TYPES = new Set(["VideoObject", "ImageObject"]);

export function canonicalJsonLdType(type: string): string {
  return EQUIVALENT_TYPE[type] ?? type;
}

export interface LiveJsonLdCoverageRow {
  resourceType: "product" | "collection" | "article";
  /** Crawled, successfully served pages of this type. */
  total: number;
  /**
   * How many of this type exist in the shop at all. A report that says
   * "15 pages have duplicate markup" while the crawl only reached 15 of 41
   * products understates the problem threefold and reads like a full result —
   * so the two numbers are shown side by side and never merged.
   */
  catalogTotal: number;
  /** …of which carry one of EXPECTED_TYPE_BY_RESOURCE. */
  withMarkup: number;
  /** Up to 5 example URLs that carry none — the actionable part. */
  missingExamples: string[];
}

export interface LiveJsonLdDuplicateRow {
  type: string;
  /** Pages serving this @type more than once. */
  pages: number;
  examples: string[];
  /**
   * …of which this app emitted one of the copies. `pages` minus this is the
   * number where the duplication is entirely between the theme and other apps
   * — a case turning our own toggle off would not fix, which is exactly the
   * wrong advice to give.
   */
  appIsOneCopy: number;
}

/**
 * Per canonical @type, everything the activation gate (PLAN_MARKUP_ACTIVATION
 * §1.2) needs to judge ONE switch: is the type served at all, do WE serve it,
 * and does any page carry it twice.
 *
 * Keyed by the CANONICAL name (ProductGroup folded into Product, BlogPosting
 * into Article — see canonicalJsonLdType): a theme emitting ProductGroup while
 * this app emits Product is exactly the collision the gate exists for, and a
 * raw-name comparison would walk right past it.
 *
 * The shape lives in markup-activation.shared.ts because the gate that reads it
 * runs in component scope, and importing this module there would drag Prisma
 * into the client bundle.
 */
export type LiveJsonLdTypeStat = MarkupTypeStat;

export interface LiveJsonLdSummary {
  /** When the crawl behind these numbers ran. */
  crawledAt: string;
  /** Crawl status — a capped/failed run measured only part of the shop. */
  crawlStatus: string;
  /** Successfully served pages the numbers are based on. */
  pagesChecked: number;
  /**
   * True when the snapshot predates jsonLdTypes (every row ""). Without this
   * flag an old snapshot would render as "no structured data anywhere", which
   * is a false alarm, not a finding.
   */
  notMeasured: boolean;
  coverage: LiveJsonLdCoverageRow[];
  /** Every @type served anywhere, with the number of pages serving it. */
  typeCounts: { type: string; pages: number }[];
  /**
   * The same pages counted by CANONICAL type, plus who emitted them. Feeds the
   * activation gate; `typeCounts` above stays raw because that is the list a
   * merchant reads.
   */
  typeStats: LiveJsonLdTypeStat[];
  /**
   * Judged pages per resourceType. A switch whose scope is missing here was
   * never measured, which is NOT the same as "nothing serves it" — see the
   * tally's comment in the builder and `activationGate`'s `scopeCovered`.
   */
  scopePages: Record<string, number>;
  duplicates: LiveJsonLdDuplicateRow[];
  /**
   * Whether this app's storefront block was seen emitting anything at all.
   * `null` = no page carried the marker AND none could have (snapshot predates
   * the marked block) — unknown, not "off". The Admin API cannot answer this
   * question at all, which is why the section used to call it "unknown".
   */
  appEmbedDetected: boolean | null;
}

const MAX_LIVE_EXAMPLES = 5;

/**
 * Summarize the structured data actually served, from the newest crawl
 * snapshot. Returns null when the shop has never completed a crawl — the UI
 * then points at the crawl section instead of showing empty numbers.
 */
export async function summarizeLiveJsonLd(
  db: PrismaClient,
  shop: string,
): Promise<LiveJsonLdSummary | null> {
  const loaded = await loadCrawlMarkupPages(db, shop);
  if (!loaded) return null;
  const { snapshot, judged } = loaded;

  // Catalog sizes, so the report can say "15 of 41 product pages crawled"
  // instead of presenting a partial crawl as the whole shop.
  const [productTotal, collectionTotal, articleTotal] = await Promise.all([
    db.product.count({ where: { shop } }).catch(() => 0),
    db.collection.count({ where: { shop } }).catch(() => 0),
    db.article.count({ where: { shop } }).catch(() => 0),
  ]);
  const catalogTotals: Record<string, number> = {
    product: productTotal,
    collection: collectionTotal,
    article: articleTotal,
  };

  const coverage: LiveJsonLdCoverageRow[] = [];
  const pagesByType = new Map<string, number>();
  const duplicatePages = new Map<string, string[]>();
  // The example lists are capped, so the page COUNT has to be tallied
  // separately or a shop with six duplicate pages would report five.
  //
  // All four tallies below are keyed by "<canonical type>\n<resourceType>",
  // never by the type alone. A shop-wide number cannot gate a page-scoped
  // switch: our block emits FAQPage only on PRODUCT pages, so a theme's
  // FAQPage on /pages/faq would otherwise read as "your theme already serves
  // this, leave the switch off" about two markups that never meet. The gate
  // sums the buckets a switch actually emits on (MarkupSwitch.scopes); a page
  // has exactly one resourceType, so summation is exact.
  const key = (type: string, resourceType: string) => `${type}\n${resourceType}`;
  const duplicateCounts = new Map<string, number>();
  /** Duplicated types where one of the copies is this app's. */
  const duplicateAppCounts = new Map<string, number>();
  /** Pages carrying a canonical type at all, and pages where WE carry it. */
  const canonicalPages = new Map<string, number>();
  const canonicalAppPages = new Map<string, number>();
  /**
   * Pages the crawl actually judged, per resourceType. This is the
   * discriminator between "the theme serves nothing here" and "we never looked
   * here" — without it a shop whose article pages were not crawled reads as a
   * clean zero, and the activation gate hands out a green "safe to switch on"
   * for a page kind it has no measurement of. Same rule as `indexabilityKnown`
   * and `attributesSyncedAt`: an empty column is never evidence.
   */
  const scopePages = new Map<string, number>();

  for (const row of judged) {
    const rt = row.resourceType || "unknown";
    scopePages.set(rt, (scopePages.get(rt) ?? 0) + 1);
    const types = row.jsonLdTypes ? row.jsonLdTypes.split(",").filter(Boolean) : [];
    // typeCounts keep the RAW names (a merchant wants to see "BlogPosting"
    // when that is what the page carries); only the duplicate tally collapses
    // them, see canonicalJsonLdType.
    const seen = new Set(types);
    for (const t of seen) pagesByType.set(t, (pagesByType.get(t) ?? 0) + 1);

    const appTypes = new Set(
      (row.jsonLdAppTypes ? row.jsonLdAppTypes.split(",").filter(Boolean) : []).map(
        canonicalJsonLdType,
      ),
    );
    const canonical = new Map<string, number>();
    for (const t of types) {
      const c = canonicalJsonLdType(t);
      canonical.set(c, (canonical.get(c) ?? 0) + 1);
    }
    for (const [t, n] of canonical) {
      const k = key(t, rt);
      canonicalPages.set(k, (canonicalPages.get(k) ?? 0) + 1);
      if (appTypes.has(t)) canonicalAppPages.set(k, (canonicalAppPages.get(k) ?? 0) + 1);
      if (n <= 1 || REPEATABLE_JSON_LD_TYPES.has(t)) continue;
      const list = duplicatePages.get(t) ?? [];
      if (list.length < MAX_LIVE_EXAMPLES) list.push(row.url);
      duplicatePages.set(t, list);
      duplicateCounts.set(k, (duplicateCounts.get(k) ?? 0) + 1);
      if (appTypes.has(t)) duplicateAppCounts.set(k, (duplicateAppCounts.get(k) ?? 0) + 1);
    }
  }

  const typeStats: LiveJsonLdTypeStat[] = [...canonicalPages.entries()]
    .map(([k, pages]) => {
      const [type, resourceType] = k.split("\n");
      return {
        type,
        resourceType,
        pages,
        appPages: canonicalAppPages.get(k) ?? 0,
        duplicatePages: duplicateCounts.get(k) ?? 0,
        appIsOneCopy: duplicateAppCounts.get(k) ?? 0,
        repeatable: REPEATABLE_JSON_LD_TYPES.has(type),
      };
    })
    .sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type));

  // The duplicate ROWS stay shop-wide: they are a report ("this type is served
  // twice on N pages"), not a gate, and splitting them by resourceType would
  // list one finding several times.
  const duplicateTotals = new Map<string, { pages: number; appIsOneCopy: number }>();
  for (const [k, pages] of duplicateCounts) {
    const type = k.split("\n")[0];
    const acc = duplicateTotals.get(type) ?? { pages: 0, appIsOneCopy: 0 };
    acc.pages += pages;
    acc.appIsOneCopy += duplicateAppCounts.get(k) ?? 0;
    duplicateTotals.set(type, acc);
  }

  // "Marker seen anywhere" is proof the embed is on. Its absence proves
  // nothing on its own: a snapshot crawled before the marked block shipped
  // looks identical to one from a shop with the embed switched off.
  const anyMarked = judged.some((r) => !!r.jsonLdAppTypes);
  const appEmbedDetected = anyMarked ? true : null;

  for (const [resourceType, expected] of Object.entries(EXPECTED_TYPE_BY_RESOURCE)) {
    const ofType = judged.filter((r) => r.resourceType === resourceType);
    if (ofType.length === 0) continue;
    const missingExamples: string[] = [];
    let withMarkup = 0;
    for (const row of ofType) {
      const types = row.jsonLdTypes ? row.jsonLdTypes.split(",") : [];
      if (types.some((t) => expected.includes(t))) withMarkup += 1;
      else if (missingExamples.length < MAX_LIVE_EXAMPLES) missingExamples.push(row.url);
    }
    coverage.push({
      resourceType: resourceType as LiveJsonLdCoverageRow["resourceType"],
      total: ofType.length,
      catalogTotal: catalogTotals[resourceType] ?? 0,
      withMarkup,
      missingExamples,
    });
  }

  return {
    crawledAt: (snapshot.finishedAt ?? snapshot.startedAt).toISOString(),
    crawlStatus: snapshot.status,
    pagesChecked: judged.length,
    // TWO conditions, and the first one is the one that used to be missing:
    // a snapshot with NO judged page at all (a password-protected storefront,
    // a shop under maintenance, a crawl the bot shield blocked end to end)
    // knows nothing, and reporting that as "no page serves any of these types"
    // handed the activation gate a green light for every switch.
    notMeasured: judged.length === 0 || judged.every((r) => !r.jsonLdTypes),
    coverage,
    typeCounts: [...pagesByType.entries()]
      .map(([type, pages]) => ({ type, pages }))
      .sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type)),
    typeStats,
    scopePages: Object.fromEntries(scopePages),
    duplicates: [...duplicateTotals.entries()]
      .map(([type, acc]) => ({
        type,
        pages: acc.pages,
        examples: duplicatePages.get(type) ?? [],
        appIsOneCopy: acc.appIsOneCopy,
      }))
      .sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type)),
    appEmbedDetected,
  };
}

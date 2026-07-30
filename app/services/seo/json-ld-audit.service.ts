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

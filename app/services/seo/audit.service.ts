/**
 * Store-wide SEO audit (Phase 1 of SEO_TAB_IMPLEMENTATION_PLAN.md, Anhang A2).
 *
 * Reads the DB content cache (Product / Collection / Article / Page + the
 * ProductImage alt-coverage) — never a live Admin-API catalog sweep — and scores
 * every item with the shared pure `computeSeoScore`, so the Dashboard and the
 * per-item SeoSidebar can never disagree on a saved item.
 *
 * Scale guard: queries are `select`-minimized and capped per type; alt coverage
 * is read with a single `groupBy` (no per-product include → no N+1 / OOM). When a
 * type is capped, `capped` is set and `totalAvailable` reports the real count so
 * the UI can tell the merchant what was left out.
 */

import type { PrismaClient } from "@prisma/client";
import { computeSeoScore, type SeoSeverity } from "../../utils/seo-score";
import { PLAN_CONFIG, type Plan, type ContentType } from "../../config/plans";
import { computeHeadDrift } from "./crawl.service";

export type AuditType = "product" | "collection" | "article" | "page";

/** Per-type cap. Keeps the largest shops bounded; reported via `capped`. */
export const MAX_AUDIT_ITEMS_PER_TYPE = 1000;

export interface AuditItemRow {
  id: string; // Shopify GID — used for the editor deep-link (?select=<GID>)
  type: AuditType;
  title: string;
  score: number;
  /** Number of error+warning findings (severity !== "success"). */
  issueCount: number;
  /** Bucket codes (dashboard i18n keys) this item triggers — same codes that
   * appear in `AuditAggregate.problems[].code`. Populated on every scored
   * row and threaded through worstOffenders so the dashboard's expandable
   * row can render per-finding rows + per-finding "Fix with AI" buttons
   * without cross-referencing bucket item lists (which are capped and
   * unordered). Empty array when the item has no non-success findings. */
  problems: string[];
}

export interface AuditTypeStat {
  type: AuditType;
  count: number;
  avgScore: number;
  good: number;
  medium: number;
  poor: number;
}

/** Per-bucket cap on how many affected-item refs are carried for the "Fix with
 * AI" bulk actions (SEO tab). `count` always stays the TRUE total — only the
 * `items` ref list is capped, so a bucket with thousands of affected items
 * still reports its real size while the bulk-fix handler gets a bounded,
 * cheap-to-persist batch to work from. */
export const MAX_PROBLEM_BUCKET_ITEMS = 100;

export interface AuditProblemBucket {
  /** i18n key under t.seo.dashboard.problems.* */
  code: string;
  /** Number of items affected (not findings) — the TRUE total, never capped. */
  count: number;
  /** Affected item refs, capped at MAX_PROBLEM_BUCKET_ITEMS. Consumed by the
   * "Fix with AI" bulk handler (seo-bulk-fix.handler.ts) to know WHICH items
   * to regenerate without trusting client-supplied ids, AND by the dashboard
   * UI to render the expandable per-bucket item list (deep-links per row). */
  items: { type: AuditType; id: string; title: string }[];
  /**
   * How the dashboard's bucket header button behaves (PLAN_SEO_SUITE_COMPLETION.md
   * §3.6). "fixWithAi" (default when absent, for backward compatibility with
   * snapshots written before this field existed) is the existing bulk-fix
   * path. "deepLink" buckets — the three crawl-derived ones below — have no
   * fix path here at all: they link to the crawl tab instead, where the
   * underlying live data (broken links / orphan pages / drifted titles)
   * lives.
   */
  action?: "fixWithAi" | "deepLink";
}

export interface AuditAggregate {
  totalScanned: number;
  totalAvailable: number;
  averageScore: number;
  distribution: { good: number; medium: number; poor: number };
  byType: AuditTypeStat[];
  problems: AuditProblemBucket[];
  worstOffenders: AuditItemRow[];
  capped: boolean;
}

/** Which content-cache type maps to which plan entitlement. */
const TYPE_TO_CONTENT_TYPE: Record<AuditType, ContentType> = {
  product: "products",
  collection: "collections",
  article: "articles",
  page: "pages",
};

// Finding code → dashboard problem-bucket key. Every non-success finding code
// computeSeoScore can emit must map to a bucket here, otherwise the item counts
// toward its score/worst-offender rank but is never explained in the "most
// common problems" list. Length issues (too short / too long) share one bucket.
const FINDING_TO_BUCKET: Record<string, string> = {
  titleTooShort: "titleLength",
  titleTooLong: "titleLength",
  seoTitleMissing: "seoTitleMissing",
  seoTitleTooLong: "seoTitleTooLong",
  // A too-short SEO title is now surfaced when the merchant sets a floor
  // (default seoTitleMin=30). Bucketed together with too-long so both feed
  // the same "seo title length" fix path.
  seoTitleTooShort: "seoTitleTooLong",
  descriptionMissing: "descriptionTooShort",
  descriptionTooShort: "descriptionTooShort",
  metaDescriptionMissing: "metaDescriptionMissing",
  metaDescriptionTooShort: "metaDescriptionLength",
  metaDescriptionTooLong: "metaDescriptionLength",
  someImagesMissingAlt: "imagesMissingAlt",
};

/** Normalize a value for cross-item duplicate comparison (trim + lowercase). */
function normalizeForDuplicateCheck(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Append `id` to the group keyed by `key` in `map` — empty keys are never grouped. */
function addToDuplicateGroup(map: Map<string, string[]>, key: string, id: string): void {
  if (!key) return;
  const group = map.get(key);
  if (group) group.push(id);
  else map.set(key, [id]);
}

/** Order the worst-offender / problem lists deterministically. */
const WORST_OFFENDERS_CAP = 50;

interface ScoredItem {
  row: AuditItemRow;
  buckets: Set<string>;
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function scoreOne(
  type: AuditType,
  id: string,
  title: string,
  input: {
    description: string;
    seoTitle: string;
    metaDescription: string;
    totalImages: number;
    imagesWithAlt: number;
  },
  seoTitleEffectiveLimit: number,
  seoLimits: Partial<import("~/utils/character-limits").SeoLimits> | null,
): ScoredItem {
  const result = computeSeoScore({
    title,
    description: input.description,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    totalImages: input.totalImages,
    imagesWithAlt: input.imagesWithAlt,
    seoTitleEffectiveLimit,
    limits: seoLimits,
  });

  const buckets = new Set<string>();
  let issueCount = 0;
  for (const f of result.findings) {
    if ((f.severity as SeoSeverity) !== "success") issueCount += 1;
    const bucket = FINDING_TO_BUCKET[f.code];
    if (bucket) buckets.add(bucket);
  }

  return {
    row: { id, type, title, score: result.score, issueCount, problems: [...buckets] },
    buckets,
  };
}

export interface AnalyzeStoreDeps {
  db: PrismaClient;
  /**
   * Sparse merchant overrides for the SEO character limits (Pro+). Passed
   * through to the scorer so a shop that widened `titleMax` doesn't get
   * "title too long" warnings for values it explicitly allows. `null` (or
   * omitted) falls back to the built-in defaults. */
  seoLimits?: Partial<import("~/utils/character-limits").SeoLimits> | null;
  /** `seoTitleSuffix ? 60 - suffix.length : 60`, computed by the caller. */
  seoTitleEffectiveLimit: number;
  plan: Plan;
  /**
   * Shop display name — ONLY used to strip the "– ShopName" suffix when
   * comparing crawled `<title>` text against the DB title for the
   * `headDrift` dashboard bucket (§3.6). Best-effort: an empty string just
   * means the suffix-strip is skipped (a false positive per page that
   * carries the theme's shop-name suffix), never a hard failure. Not needed
   * for anything else in this function.
   */
  shopName?: string;
  /**
   * Foreign locale to score against (empty/undefined = primary locale, the
   * historic behavior). When set, every scoring input (`title`, `description`,
   * `seoTitle`, `metaDescription`) is sourced from ContentTranslation rows
   * (keys `title`, `body_html`, `meta_title`, `meta_description`) for this
   * (shop, locale, resourceType, resourceId); missing rows count as an empty
   * value, so the same scoring rules that fire for "primary meta description
   * missing" also fire for "foreign meta description missing". Product image
   * alt coverage is sourced from ProductImageAltTranslation for the same
   * locale. Collection/Article featured-image alt is not currently persisted
   * per-locale in this app, so `imagesMissingAlt` is skipped for those types
   * on foreign locales (its bucket-fix path would have nowhere to write).
   */
  locale?: string;
}

/** Keys ContentTranslation stores for the four audited fields — mirrors the
 * TRANSLATION_KEYS list in hreflang.service.ts, minus `handle`. */
const TRANSLATION_KEY_TITLE = "title";
const TRANSLATION_KEY_BODY = "body_html";
const TRANSLATION_KEY_META_TITLE = "meta_title";
const TRANSLATION_KEY_META_DESCRIPTION = "meta_description";

/** resourceType strings ContentTranslation uses per AuditType. Same map as
 * hreflang.service.ts's own (unexported) RESOURCE_TYPE. */
const AUDIT_RESOURCE_TYPE: Record<AuditType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

interface TranslationOverlay {
  title: string;
  body: string;
  metaTitle: string;
  metaDescription: string;
}

/**
 * Batch-load foreign-locale ContentTranslation rows for every item passed in.
 * One findMany across all resource types (resourceId is a globally-unique
 * Shopify GID). Returns an id -> { title, body, metaTitle, metaDescription }
 * map with empty strings for missing rows so the scorer can treat missing
 * translations the same way it treats an empty primary value.
 */
async function loadTranslationOverlays(
  db: PrismaClient,
  shop: string,
  locale: string,
  ids: string[],
): Promise<Map<string, TranslationOverlay>> {
  const map = new Map<string, TranslationOverlay>();
  if (ids.length === 0) return map;

  const rows = await db.contentTranslation.findMany({
    where: {
      shop,
      locale,
      resourceId: { in: ids },
      key: {
        in: [
          TRANSLATION_KEY_TITLE,
          TRANSLATION_KEY_BODY,
          TRANSLATION_KEY_META_TITLE,
          TRANSLATION_KEY_META_DESCRIPTION,
        ],
      },
      // Global rows only for the audit (marketId="" sentinel). Market-specific
      // overrides would balloon the surface without the UI to switch between
      // them; foreign-locale coverage is already what merchants ask about first.
      marketId: "",
    },
    select: { resourceId: true, key: true, value: true },
  });

  for (const r of rows) {
    let overlay = map.get(r.resourceId);
    if (!overlay) {
      overlay = { title: "", body: "", metaTitle: "", metaDescription: "" };
      map.set(r.resourceId, overlay);
    }
    switch (r.key) {
      case TRANSLATION_KEY_TITLE:
        overlay.title = r.value;
        break;
      case TRANSLATION_KEY_BODY:
        overlay.body = r.value;
        break;
      case TRANSLATION_KEY_META_TITLE:
        overlay.metaTitle = r.value;
        break;
      case TRANSLATION_KEY_META_DESCRIPTION:
        overlay.metaDescription = r.value;
        break;
    }
  }
  return map;
}

/**
 * For a given foreign locale, count how many of each product's gallery images
 * have a persisted alt translation. `ProductImageAltTranslation` is the only
 * per-locale alt store in this app; Collection/Article featured-image alt has
 * no per-locale table, so the audit skips its imagesMissingAlt bucket for
 * those types (there'd be no fix path to act on the finding).
 *
 * Returns a productId -> imagesWithAltForLocale count. Not present = 0.
 */
async function loadProductAltCoverageForLocale(
  db: PrismaClient,
  locale: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (productIds.length === 0) return map;

  const rows = await db.productImageAltTranslation.groupBy({
    by: ["imageId"],
    where: {
      locale,
      marketId: "",
      altText: { not: "" },
      image: { productId: { in: productIds } },
    },
    _count: { _all: true },
  });
  if (rows.length === 0) return map;

  // We grouped by imageId — bring back the productId for each so we can bucket
  // per product. One extra select-minimized lookup, cheaper than joining in
  // the groupBy directly.
  const imageIds = rows.map((r) => r.imageId);
  const imgs = await db.productImage.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, productId: true },
  });
  const productByImage = new Map(imgs.map((i) => [i.id, i.productId]));

  for (const r of rows) {
    const pid = productByImage.get(r.imageId);
    if (!pid) continue;
    map.set(pid, (map.get(pid) ?? 0) + r._count._all);
  }
  return map;
}

/**
 * Builds the three crawl-derived dashboard buckets (§3.6): `brokenLinks`,
 * `orphanPages`, `headDrift`. Reads the latest completed/capped
 * SeoCrawlSnapshot + its SeoCrawlPage/SeoCrawlBrokenLink rows — a cheap,
 * already-DB-cached read (the crawl itself is the one live fetch this app
 * makes; this function makes none). Returns `[]` when no snapshot exists yet
 * (free plan / never crawled) — no special-casing needed by the caller.
 */
async function buildCrawlProblemBuckets(
  db: PrismaClient,
  shop: string,
  shopName: string,
): Promise<AuditProblemBucket[]> {
  const snapshot = await db.seoCrawlSnapshot.findFirst({
    where: { shop, status: { in: ["completed", "capped"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true },
  });
  if (!snapshot) return [];

  const pages = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshot.id },
    select: {
      url: true,
      title: true,
      statusCode: true,
      resourceType: true,
      resourceId: true,
      locale: true,
      inboundCount: true,
    },
  });
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));

  const buckets: AuditProblemBucket[] = [];

  // --- brokenLinks: the FROM page of each broken edge is the affected item.
  // 403/429 targets are bot-firewall artifacts, not broken links (see
  // `isBotBlockStatus` in crawl.service.ts). New crawls never persist them;
  // the filter keeps snapshots written before that split out of the bucket.
  const brokenLinks = await db.seoCrawlBrokenLink.findMany({
    where: { shop, snapshotId: snapshot.id, statusCode: { notIn: [403, 429] } },
    select: { fromUrl: true },
  });
  const brokenAffected = new Map<string, { type: AuditType; id: string; title: string }>();
  for (const bl of brokenLinks) {
    const from = pageByUrl.get(bl.fromUrl);
    if (!from?.resourceId || !from.resourceType || from.resourceType === "unknown") continue;
    const key = `${from.resourceType}:${from.resourceId}`;
    if (!brokenAffected.has(key)) {
      brokenAffected.set(key, { type: from.resourceType as AuditType, id: from.resourceId, title: from.title || "" });
    }
  }
  if (brokenAffected.size > 0) {
    buckets.push({
      code: "brokenLinks",
      count: brokenAffected.size,
      items: Array.from(brokenAffected.values()).slice(0, MAX_PROBLEM_BUCKET_ITEMS),
      action: "deepLink",
    });
  }

  // --- orphanPages: only valid when the crawl wasn't capped (§3.1) — a
  // capped crawl produces phantom orphans on any large shop.
  if (snapshot.status !== "capped") {
    const orphans = pages.filter(
      (p) => p.resourceId && p.resourceType && p.resourceType !== "unknown" && p.inboundCount === 0,
    );
    if (orphans.length > 0) {
      buckets.push({
        code: "orphanPages",
        count: orphans.length,
        items: orphans
          .slice(0, MAX_PROBLEM_BUCKET_ITEMS)
          .map((p) => ({ type: p.resourceType as AuditType, id: p.resourceId as string, title: p.title || "" })),
        action: "deepLink",
      });
    }
  }

  // --- headDrift: crawled <title> vs. stored SEO title, primary locale only
  // (§3.1) — same comparison rule the crawl runner used for
  // SeoCrawlSnapshot.headDriftCount (crawl.service.ts's computeHeadDrift),
  // reused here so there is exactly one drift rule, not two.
  const headDriftCandidates = pages
    .filter(
      (p) =>
        p.resourceId &&
        p.resourceType &&
        p.resourceType !== "unknown" &&
        p.locale === "" &&
        p.statusCode >= 200 &&
        p.statusCode < 300,
    )
    .map((p) => ({
      resourceType: p.resourceType as AuditType,
      resourceId: p.resourceId as string,
      crawledTitle: p.title,
    }));
  const headDrift = await computeHeadDrift(db, shop, headDriftCandidates, shopName, MAX_PROBLEM_BUCKET_ITEMS);
  if (headDrift.count > 0) {
    buckets.push({
      code: "headDrift",
      count: headDrift.count,
      items: headDrift.items.map((i) => ({ type: i.type, id: i.id, title: i.title })),
      action: "deepLink",
    });
  }

  return buckets;
}

export async function analyzeStore(
  shop: string,
  { db, seoTitleEffectiveLimit, plan, locale, seoLimits = null, shopName = "" }: AnalyzeStoreDeps,
): Promise<AuditAggregate> {
  // Normalize "" / undefined to "primary". Consumers pass the sentinel "" for
  // primary snapshots so the audit + snapshot table share one call shape.
  const foreignLocale = locale && locale.length > 0 ? locale : null;
  const allowed = new Set(PLAN_CONFIG[plan].contentTypes);
  const wants = (type: AuditType) => allowed.has(TYPE_TO_CONTENT_TYPE[type]);

  const scored: ScoredItem[] = [];
  const byType: AuditTypeStat[] = [];
  let totalAvailable = 0;
  let capped = false;

  // Store-wide duplicate detection (finding #5): key = normalized value,
  // value = ids of every item sharing it. A key groups ANY item whose
  // effective SEO title / SEO description normalizes to it, regardless of
  // content type — a product and a page with the same SEO title are just as
  // duplicate to Google as two products would be.
  const seoTitleGroups = new Map<string, string[]>();
  const seoDescriptionGroups = new Map<string, string[]>();

  const take = MAX_AUDIT_ITEMS_PER_TYPE;

  // ---- Products (+ alt coverage via groupBy) ----------------------------
  if (wants("product")) {
    const [count, products] = await Promise.all([
      // Only ACTIVE products are storefront-publishable — DRAFT/ARCHIVED ones
      // can't rank and shouldn't be audited. Mirrors hreflang.service.ts.
      db.product.count({ where: { shop, status: "ACTIVE" } }),
      db.product.findMany({
        where: { shop, status: "ACTIVE" },
        select: {
          id: true,
          title: true,
          descriptionHtml: true,
          seoTitle: true,
          seoDescription: true,
          featuredImageUrl: true,
          featuredImageAlt: true,
        },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    totalAvailable += count;
    if (count > products.length) capped = true;

    const productIds = products.map((p) => p.id);
    // Alt coverage in two grouped reads (no per-product include).
    //
    // R-audit-9 (assessed; intentionally NOT changed): this `not: ""` check
    // does not TRIM, so a gallery image whose alt is whitespace-only (" ")
    // counts as "has alt" here, while the featured-image fallback below (via
    // `nonEmpty()`, which does trim) would treat the same value as missing.
    // Prisma's typed groupBy has no server-side trim; fixing it needs a raw
    // SQL query, which is disproportionate for what is a rare edge case
    // (whitespace-only alt text is not something any real editor UI writes
    // unprompted). Documenting the discrepancy here rather than "fixing" it by
    // loosening the featured-image check, since the featured-image path's
    // trim is free (single value, no SQL) and IS the more correct behavior.
    const [totalByProduct, withAltByProduct] = await Promise.all([
      db.productImage.groupBy({
        by: ["productId"],
        where: { productId: { in: productIds } },
        _count: { _all: true },
      }),
      db.productImage.groupBy({
        by: ["productId"],
        where: {
          productId: { in: productIds },
          AND: [{ altText: { not: null } }, { altText: { not: "" } }],
        },
        _count: { _all: true },
      }),
    ]);
    const totalMap = new Map(totalByProduct.map((g) => [g.productId, g._count._all]));
    const withAltMap = new Map(withAltByProduct.map((g) => [g.productId, g._count._all]));

    // Foreign-locale overlay: ContentTranslation values replace the primary
    // scoring inputs; ProductImageAltTranslation counts substitute the primary
    // alt coverage. The featured-image fallback still uses the primary alt
    // for now (the app doesn't persist a per-locale featured-image alt outside
    // of the gallery table), so a shop that only ever uses a featured image
    // still gets non-zero coverage in the foreign audit rather than 0/0 noise.
    const overlays = foreignLocale
      ? await loadTranslationOverlays(db, shop, foreignLocale, productIds)
      : null;
    const altByProductForLocale = foreignLocale
      ? await loadProductAltCoverageForLocale(db, foreignLocale, productIds)
      : null;

    const stat = newStat("product");
    for (const p of products) {
      let totalImages = totalMap.get(p.id) ?? 0;
      let imagesWithAlt = altByProductForLocale
        ? altByProductForLocale.get(p.id) ?? 0
        : withAltMap.get(p.id) ?? 0;
      // Mirror the editor: fall back to the featured image when no gallery rows.
      if (totalImages === 0 && nonEmpty(p.featuredImageUrl)) {
        totalImages = 1;
        // For foreign locales we currently have no per-locale featured-image
        // alt store, so this row falls back to the primary alt — same signal
        // the storefront ships when no translation is registered.
        imagesWithAlt = nonEmpty(p.featuredImageAlt) ? 1 : 0;
      }
      const overlay = overlays?.get(p.id);
      const effectiveTitle = overlay ? overlay.title : p.title;
      const effectiveDescription = overlay ? overlay.body : p.descriptionHtml ?? "";
      const effectiveSeoTitle = overlay ? overlay.metaTitle : p.seoTitle ?? "";
      const effectiveMetaDescription = overlay
        ? overlay.metaDescription
        : p.seoDescription ?? "";
      // For foreign locales, score the TRANSLATED values so titleLength /
      // seoTitleMissing / metaDescription-* findings fire on the actual
      // storefront copy for this locale. Missing translation = "" = missing
      // finding, exactly like an empty primary field.
      const item = scoreOne(
        "product",
        p.id,
        effectiveTitle,
        {
          description: effectiveDescription,
          seoTitle: effectiveSeoTitle,
          metaDescription: effectiveMetaDescription,
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
        seoLimits,
      );
      // Keep the DISPLAY title = primary so worst-offenders rows read like
      // the merchant expects (they recognize products by their primary name).
      // The row.title change is display-only; scoring already used the
      // effective title above.
      if (foreignLocale) item.row.title = p.title;
      scored.push(item);
      tallyStat(stat, item.row.score);
      // SERP title falls back to the item title when no seoTitle is set —
      // that's what Google actually shows, so that's what must match/collide.
      // For foreign locale, the effective (translated) values are what the
      // storefront serves for that locale — that's the correct duplicate
      // surface.
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(
          nonEmpty(effectiveSeoTitle) ? effectiveSeoTitle : effectiveTitle,
        ),
        p.id,
      );
      addToDuplicateGroup(
        seoDescriptionGroups,
        normalizeForDuplicateCheck(effectiveMetaDescription),
        p.id,
      );
    }
    finalizeStat(stat);
    if (stat.count > 0) byType.push(stat);
  }

  // ---- Collections ------------------------------------------------------
  // NOTE (finding #6): Collection has no `published`/status column in
  // schema.prisma (unlike Product's "ACTIVE"/"DRAFT"/"ARCHIVED"), so there is
  // nothing to filter on here — every cached row is audited, as before.
  if (wants("collection")) {
    const [count, collections] = await Promise.all([
      db.collection.count({ where: { shop } }),
      db.collection.findMany({
        where: { shop },
        select: {
          id: true,
          title: true,
          descriptionHtml: true,
          seoTitle: true,
          seoDescription: true,
          imageUrl: true,
          imageAltText: true,
        },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    totalAvailable += count;
    if (count > collections.length) capped = true;

    const collectionOverlays = foreignLocale
      ? await loadTranslationOverlays(db, shop, foreignLocale, collections.map((c) => c.id))
      : null;

    const stat = newStat("collection");
    for (const c of collections) {
      const overlay = collectionOverlays?.get(c.id);
      const effectiveTitle = overlay ? overlay.title : c.title;
      const effectiveDescription = overlay ? overlay.body : c.descriptionHtml ?? "";
      const effectiveSeoTitle = overlay ? overlay.metaTitle : c.seoTitle ?? "";
      const effectiveMetaDescription = overlay ? overlay.metaDescription : c.seoDescription ?? "";
      // Collection featured-image alt has no per-locale store in this app,
      // so foreign audits fall back to the primary alt (same value the
      // storefront ships when no translation is registered).
      const totalImages = nonEmpty(c.imageUrl) ? 1 : 0;
      const imagesWithAlt = nonEmpty(c.imageAltText) ? 1 : 0;
      const item = scoreOne(
        "collection",
        c.id,
        effectiveTitle,
        {
          description: effectiveDescription,
          seoTitle: effectiveSeoTitle,
          metaDescription: effectiveMetaDescription,
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
        seoLimits,
      );
      if (foreignLocale) item.row.title = c.title;
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(
          nonEmpty(effectiveSeoTitle) ? effectiveSeoTitle : effectiveTitle,
        ),
        c.id,
      );
      addToDuplicateGroup(
        seoDescriptionGroups,
        normalizeForDuplicateCheck(effectiveMetaDescription),
        c.id,
      );
    }
    finalizeStat(stat);
    if (stat.count > 0) byType.push(stat);
  }

  // ---- Articles ---------------------------------------------------------
  // NOTE (finding #6): Article has no `published`/status column in
  // schema.prisma, so (as with Collection) every cached row is audited.
  if (wants("article")) {
    const [count, articles] = await Promise.all([
      db.article.count({ where: { shop } }),
      db.article.findMany({
        where: { shop },
        select: {
          id: true,
          title: true,
          body: true,
          seoTitle: true,
          seoDescription: true,
          imageUrl: true,
          imageAltText: true,
        },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    totalAvailable += count;
    if (count > articles.length) capped = true;

    const articleOverlays = foreignLocale
      ? await loadTranslationOverlays(db, shop, foreignLocale, articles.map((a) => a.id))
      : null;

    const stat = newStat("article");
    for (const a of articles) {
      const overlay = articleOverlays?.get(a.id);
      const effectiveTitle = overlay ? overlay.title : a.title;
      const effectiveDescription = overlay ? overlay.body : a.body ?? "";
      const effectiveSeoTitle = overlay ? overlay.metaTitle : a.seoTitle ?? "";
      const effectiveMetaDescription = overlay ? overlay.metaDescription : a.seoDescription ?? "";
      const totalImages = nonEmpty(a.imageUrl) ? 1 : 0;
      const imagesWithAlt = nonEmpty(a.imageAltText) ? 1 : 0;
      const item = scoreOne(
        "article",
        a.id,
        effectiveTitle,
        {
          description: effectiveDescription,
          seoTitle: effectiveSeoTitle,
          metaDescription: effectiveMetaDescription,
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
        seoLimits,
      );
      if (foreignLocale) item.row.title = a.title;
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(
          nonEmpty(effectiveSeoTitle) ? effectiveSeoTitle : effectiveTitle,
        ),
        a.id,
      );
      addToDuplicateGroup(
        seoDescriptionGroups,
        normalizeForDuplicateCheck(effectiveMetaDescription),
        a.id,
      );
    }
    finalizeStat(stat);
    if (stat.count > 0) byType.push(stat);
  }

  // ---- Pages (no images) ------------------------------------------------
  // NOTE (finding #6): Page has no `published`/status column in
  // schema.prisma either, so every cached row is audited.
  if (wants("page")) {
    const [count, pages] = await Promise.all([
      db.page.count({ where: { shop } }),
      db.page.findMany({
        where: { shop },
        select: {
          id: true,
          title: true,
          body: true,
          seoTitle: true,
          seoDescription: true,
        },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    totalAvailable += count;
    if (count > pages.length) capped = true;

    const pageOverlays = foreignLocale
      ? await loadTranslationOverlays(db, shop, foreignLocale, pages.map((pg) => pg.id))
      : null;

    const stat = newStat("page");
    for (const pg of pages) {
      const overlay = pageOverlays?.get(pg.id);
      const effectiveTitle = overlay ? overlay.title : pg.title;
      const effectiveDescription = overlay ? overlay.body : pg.body ?? "";
      const effectiveSeoTitle = overlay ? overlay.metaTitle : pg.seoTitle ?? "";
      const effectiveMetaDescription = overlay ? overlay.metaDescription : pg.seoDescription ?? "";
      const item = scoreOne(
        "page",
        pg.id,
        effectiveTitle,
        {
          description: effectiveDescription,
          seoTitle: effectiveSeoTitle,
          metaDescription: effectiveMetaDescription,
          totalImages: 0,
          imagesWithAlt: 0,
        },
        seoTitleEffectiveLimit,
        seoLimits,
      );
      if (foreignLocale) item.row.title = pg.title;
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(
          nonEmpty(effectiveSeoTitle) ? effectiveSeoTitle : effectiveTitle,
        ),
        pg.id,
      );
      addToDuplicateGroup(
        seoDescriptionGroups,
        normalizeForDuplicateCheck(effectiveMetaDescription),
        pg.id,
      );
    }
    finalizeStat(stat);
    if (stat.count > 0) byType.push(stat);
  }

  // ---- Aggregate --------------------------------------------------------
  const totalScanned = scored.length;
  const distribution = { good: 0, medium: 0, poor: 0 };
  const bucketCounts = new Map<string, number>();
  // Capped, per-bucket item refs — see MAX_PROBLEM_BUCKET_ITEMS. Kept separate
  // from bucketCounts so the count stays the TRUE total even once a bucket's
  // item list has filled up.
  const bucketItems = new Map<string, { type: AuditType; id: string; title: string }[]>();
  // id -> type/title lookup so the duplicate-SEO buckets below (built from
  // seoTitleGroups/seoDescriptionGroups, which only track ids) can also carry
  // typed item refs, same as every other bucket.
  const typeById = new Map<string, AuditType>();
  const titleById = new Map<string, string>();
  let scoreSum = 0;

  const addBucketItem = (code: string, type: AuditType, id: string, title: string) => {
    let items = bucketItems.get(code);
    if (!items) {
      items = [];
      bucketItems.set(code, items);
    }
    if (items.length < MAX_PROBLEM_BUCKET_ITEMS) items.push({ type, id, title });
  };

  for (const { row, buckets } of scored) {
    scoreSum += row.score;
    if (row.score >= 70) distribution.good += 1;
    else if (row.score >= 40) distribution.medium += 1;
    else distribution.poor += 1;
    typeById.set(row.id, row.type);
    titleById.set(row.id, row.title);
    for (const b of buckets) {
      bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
      addBucketItem(b, row.type, row.id, row.title);
    }
  }

  const averageScore = totalScanned > 0 ? Math.round(scoreSum / totalScanned) : 0;

  // rowById lets the duplicate loops below tag each affected row's
  // AuditItemRow.problems with the duplicate bucket code — worstOffenders
  // otherwise wouldn't know about duplicate-SEO findings (they're
  // detected AFTER the scored loop).
  const rowById = new Map<string, AuditItemRow>();
  for (const s of scored) rowById.set(s.row.id, s.row);

  // Finding #5: store-wide duplicate SEO title / description. An item is
  // "affected" if it shares its (normalized, non-empty) value with at least
  // one other item — a group of size 1 is unique, not a duplicate.
  let duplicateSeoTitleCount = 0;
  for (const ids of seoTitleGroups.values()) {
    if (ids.length > 1) {
      duplicateSeoTitleCount += ids.length;
      for (const id of ids) {
        const type = typeById.get(id);
        if (type) {
          addBucketItem("duplicateSeoTitle", type, id, titleById.get(id) ?? "");
          const r = rowById.get(id);
          if (r && !r.problems.includes("duplicateSeoTitle")) r.problems.push("duplicateSeoTitle");
        }
      }
    }
  }
  let duplicateSeoDescriptionCount = 0;
  for (const ids of seoDescriptionGroups.values()) {
    if (ids.length > 1) {
      duplicateSeoDescriptionCount += ids.length;
      for (const id of ids) {
        const type = typeById.get(id);
        if (type) {
          addBucketItem("duplicateSeoDescription", type, id, titleById.get(id) ?? "");
          const r = rowById.get(id);
          if (r && !r.problems.includes("duplicateSeoDescription"))
            r.problems.push("duplicateSeoDescription");
        }
      }
    }
  }
  if (duplicateSeoTitleCount > 0) {
    bucketCounts.set("duplicateSeoTitle", duplicateSeoTitleCount);
  }
  if (duplicateSeoDescriptionCount > 0) {
    bucketCounts.set("duplicateSeoDescription", duplicateSeoDescriptionCount);
  }

  const problems: AuditProblemBucket[] = [...bucketCounts.entries()]
    .map(([code, count]) => ({ code, count, items: bucketItems.get(code) ?? [], action: "fixWithAi" as const }))
    .sort((a, b) => b.count - a.count);

  // §3.6: three additional buckets sourced from the latest Phase-1 crawl
  // snapshot, not from the DB-cache scan above. Primary-locale scans only —
  // the crawl only ever inspects the primary storefront (§3.1 explicitly
  // scopes head-drift to locale==""), so a foreign-locale audit run has
  // nothing valid to add here.
  if (!foreignLocale) {
    // Best-effort: a crawl-table read failure (missing delegate on an older
    // test stub, a transient DB error) must never sink the whole dashboard
    // scan — the three crawl buckets are additive, not load-bearing.
    const crawlBuckets = await buildCrawlProblemBuckets(db, shop, shopName).catch(() => []);
    if (crawlBuckets.length > 0) {
      problems.push(...crawlBuckets);
      problems.sort((a, b) => b.count - a.count);
    }
  }

  const worstOffenders = scored
    .filter((s) => s.row.issueCount > 0)
    .map((s) => s.row)
    // Lowest score first, then most issues; id as a stable tiebreaker so the
    // list order is deterministic across reloads.
    .sort((a, b) => a.score - b.score || b.issueCount - a.issueCount || a.id.localeCompare(b.id))
    .slice(0, WORST_OFFENDERS_CAP);

  return {
    totalScanned,
    totalAvailable,
    averageScore,
    distribution,
    // Strip the internal accumulator so it never leaks into the loader JSON.
    byType: byType.map(({ type, count, avgScore, good, medium, poor }) => ({
      type,
      count,
      avgScore,
      good,
      medium,
      poor,
    })),
    problems,
    worstOffenders,
    capped,
  };
}

// --- small mutable accumulators (kept local; not exported) ---------------

interface MutStat extends AuditTypeStat {
  _sum: number;
}

function newStat(type: AuditType): MutStat {
  return { type, count: 0, avgScore: 0, good: 0, medium: 0, poor: 0, _sum: 0 };
}

function tallyStat(stat: MutStat, score: number): void {
  stat.count += 1;
  stat._sum += score;
  if (score >= 70) stat.good += 1;
  else if (score >= 40) stat.medium += 1;
  else stat.poor += 1;
}

function finalizeStat(stat: MutStat): void {
  stat.avgScore = stat.count > 0 ? Math.round(stat._sum / stat.count) : 0;
}

// ─── Snapshot persistence (SEO Audit Dashboard caching, Anhang B) ──────────
//
// analyzeStore() is a full content-cache scan (up to 4×MAX_AUDIT_ITEMS_PER_TYPE
// rows + groupBys) — too expensive to run on every dashboard visit. These
// helpers let the "seoAudit" Task runner (seo-audit.handler.ts) persist a
// point-in-time result and let the dashboard loader read the latest one
// instead of re-scanning synchronously.

/** Keep only the newest N snapshots per shop — a history, not an unbounded log. */
export const MAX_SNAPSHOTS_PER_SHOP = 30;

export interface AuditSnapshot {
  audit: AuditAggregate;
  createdAt: Date;
}

/**
 * Persist one snapshot and prune older rows beyond MAX_SNAPSHOTS_PER_SHOP for
 * this (shop, locale). Prune happens here (not a cron) so retention is
 * enforced at the single write path, with no separate scheduled job to keep in
 * sync. Retention is per-locale: adding an English snapshot never displaces
 * the German trend, and vice versa.
 *
 * `locale` sentinel: "" (default) = primary-locale snapshot. Non-empty = a
 * shop-locale code like "en" / "fr". Mirrors ContentTranslation.marketId's
 * "" = global convention so the DB column is never NULL and unique/index
 * lookups stay deterministic across engines.
 */
export async function saveAuditSnapshot(
  db: PrismaClient,
  shop: string,
  audit: AuditAggregate,
  locale: string = "",
): Promise<void> {
  await db.seoScoreSnapshot.create({
    data: {
      shop,
      locale,
      averageScore: audit.averageScore,
      totalScanned: audit.totalScanned,
      totalAvailable: audit.totalAvailable,
      capped: audit.capped,
      payload: JSON.stringify(audit),
    },
  });

  // Prune: find the id of the Nth-newest row (for this locale) and delete
  // everything older. Two small queries beat a single DELETE ... OFFSET
  // (not portable in Prisma) and keep the cap exact even under concurrent
  // writes.
  const keep = await db.seoScoreSnapshot.findMany({
    where: { shop, locale },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: MAX_SNAPSHOTS_PER_SHOP,
  });
  if (keep.length === MAX_SNAPSHOTS_PER_SHOP) {
    await db.seoScoreSnapshot.deleteMany({
      where: { shop, locale, id: { notIn: keep.map((r) => r.id) } },
    });
  }
}

/**
 * Latest snapshot for a (shop, locale), or null if none exists yet or the
 * stored payload is corrupt (defensive JSON.parse — a bad row must never 500
 * the dashboard, just fall back to "no snapshot"). `locale` = "" for the
 * primary-locale snapshot.
 */
export async function getLatestAuditSnapshot(
  db: PrismaClient,
  shop: string,
  locale: string = "",
): Promise<AuditSnapshot | null> {
  const row = await db.seoScoreSnapshot.findFirst({
    where: { shop, locale },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;

  try {
    const audit = JSON.parse(row.payload) as AuditAggregate;
    return { audit, createdAt: row.createdAt };
  } catch {
    return null;
  }
}

export interface AuditTrendPoint {
  createdAt: Date;
  averageScore: number;
  totalScanned: number;
}

/**
 * Lightweight history for the dashboard's trend chart — select-minimized
 * (never touches `payload`) so this stays cheap even with the full 30-row cap.
 * Returned oldest -> newest (chart reading order).
 */
export async function getAuditTrend(
  db: PrismaClient,
  shop: string,
  locale: string = "",
  limit: number = MAX_SNAPSHOTS_PER_SHOP,
): Promise<AuditTrendPoint[]> {
  const rows = await db.seoScoreSnapshot.findMany({
    where: { shop, locale },
    select: { createdAt: true, averageScore: true, totalScanned: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

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
   * to regenerate without trusting client-supplied ids. */
  items: { type: AuditType; id: string }[];
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
): ScoredItem {
  const result = computeSeoScore({
    title,
    description: input.description,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    totalImages: input.totalImages,
    imagesWithAlt: input.imagesWithAlt,
    seoTitleEffectiveLimit,
  });

  const buckets = new Set<string>();
  let issueCount = 0;
  for (const f of result.findings) {
    if ((f.severity as SeoSeverity) !== "success") issueCount += 1;
    const bucket = FINDING_TO_BUCKET[f.code];
    if (bucket) buckets.add(bucket);
  }

  return { row: { id, type, title, score: result.score, issueCount }, buckets };
}

export interface AnalyzeStoreDeps {
  db: PrismaClient;
  /** `seoTitleSuffix ? 60 - suffix.length : 60`, computed by the caller. */
  seoTitleEffectiveLimit: number;
  plan: Plan;
}

export async function analyzeStore(
  shop: string,
  { db, seoTitleEffectiveLimit, plan }: AnalyzeStoreDeps,
): Promise<AuditAggregate> {
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

    const stat = newStat("product");
    for (const p of products) {
      let totalImages = totalMap.get(p.id) ?? 0;
      let imagesWithAlt = withAltMap.get(p.id) ?? 0;
      // Mirror the editor: fall back to the featured image when no gallery rows.
      if (totalImages === 0 && nonEmpty(p.featuredImageUrl)) {
        totalImages = 1;
        imagesWithAlt = nonEmpty(p.featuredImageAlt) ? 1 : 0;
      }
      const item = scoreOne(
        "product",
        p.id,
        p.title,
        {
          description: p.descriptionHtml ?? "",
          seoTitle: p.seoTitle ?? "",
          metaDescription: p.seoDescription ?? "",
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
      );
      scored.push(item);
      tallyStat(stat, item.row.score);
      // SERP title falls back to the item title when no seoTitle is set —
      // that's what Google actually shows, so that's what must match/collide.
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(nonEmpty(p.seoTitle) ? p.seoTitle : p.title),
        p.id,
      );
      addToDuplicateGroup(seoDescriptionGroups, normalizeForDuplicateCheck(p.seoDescription), p.id);
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

    const stat = newStat("collection");
    for (const c of collections) {
      const totalImages = nonEmpty(c.imageUrl) ? 1 : 0;
      const imagesWithAlt = nonEmpty(c.imageAltText) ? 1 : 0;
      const item = scoreOne(
        "collection",
        c.id,
        c.title,
        {
          description: c.descriptionHtml ?? "",
          seoTitle: c.seoTitle ?? "",
          metaDescription: c.seoDescription ?? "",
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
      );
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(nonEmpty(c.seoTitle) ? c.seoTitle : c.title),
        c.id,
      );
      addToDuplicateGroup(seoDescriptionGroups, normalizeForDuplicateCheck(c.seoDescription), c.id);
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

    const stat = newStat("article");
    for (const a of articles) {
      const totalImages = nonEmpty(a.imageUrl) ? 1 : 0;
      const imagesWithAlt = nonEmpty(a.imageAltText) ? 1 : 0;
      const item = scoreOne(
        "article",
        a.id,
        a.title,
        {
          description: a.body ?? "",
          seoTitle: a.seoTitle ?? "",
          metaDescription: a.seoDescription ?? "",
          totalImages,
          imagesWithAlt,
        },
        seoTitleEffectiveLimit,
      );
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(nonEmpty(a.seoTitle) ? a.seoTitle : a.title),
        a.id,
      );
      addToDuplicateGroup(seoDescriptionGroups, normalizeForDuplicateCheck(a.seoDescription), a.id);
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

    const stat = newStat("page");
    for (const pg of pages) {
      const item = scoreOne(
        "page",
        pg.id,
        pg.title,
        {
          description: pg.body ?? "",
          seoTitle: pg.seoTitle ?? "",
          metaDescription: pg.seoDescription ?? "",
          totalImages: 0,
          imagesWithAlt: 0,
        },
        seoTitleEffectiveLimit,
      );
      scored.push(item);
      tallyStat(stat, item.row.score);
      addToDuplicateGroup(
        seoTitleGroups,
        normalizeForDuplicateCheck(nonEmpty(pg.seoTitle) ? pg.seoTitle : pg.title),
        pg.id,
      );
      addToDuplicateGroup(seoDescriptionGroups, normalizeForDuplicateCheck(pg.seoDescription), pg.id);
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
  const bucketItems = new Map<string, { type: AuditType; id: string }[]>();
  // id -> type lookup so the duplicate-SEO buckets below (built from
  // seoTitleGroups/seoDescriptionGroups, which only track ids) can also carry
  // typed item refs, same as every other bucket.
  const typeById = new Map<string, AuditType>();
  let scoreSum = 0;

  const addBucketItem = (code: string, type: AuditType, id: string) => {
    let items = bucketItems.get(code);
    if (!items) {
      items = [];
      bucketItems.set(code, items);
    }
    if (items.length < MAX_PROBLEM_BUCKET_ITEMS) items.push({ type, id });
  };

  for (const { row, buckets } of scored) {
    scoreSum += row.score;
    if (row.score >= 70) distribution.good += 1;
    else if (row.score >= 40) distribution.medium += 1;
    else distribution.poor += 1;
    typeById.set(row.id, row.type);
    for (const b of buckets) {
      bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
      addBucketItem(b, row.type, row.id);
    }
  }

  const averageScore = totalScanned > 0 ? Math.round(scoreSum / totalScanned) : 0;

  // Finding #5: store-wide duplicate SEO title / description. An item is
  // "affected" if it shares its (normalized, non-empty) value with at least
  // one other item — a group of size 1 is unique, not a duplicate.
  let duplicateSeoTitleCount = 0;
  for (const ids of seoTitleGroups.values()) {
    if (ids.length > 1) {
      duplicateSeoTitleCount += ids.length;
      for (const id of ids) {
        const type = typeById.get(id);
        if (type) addBucketItem("duplicateSeoTitle", type, id);
      }
    }
  }
  let duplicateSeoDescriptionCount = 0;
  for (const ids of seoDescriptionGroups.values()) {
    if (ids.length > 1) {
      duplicateSeoDescriptionCount += ids.length;
      for (const id of ids) {
        const type = typeById.get(id);
        if (type) addBucketItem("duplicateSeoDescription", type, id);
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
    .map(([code, count]) => ({ code, count, items: bucketItems.get(code) ?? [] }))
    .sort((a, b) => b.count - a.count);

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
 * this shop. Prune happens here (not a cron) so retention is enforced at the
 * single write path, with no separate scheduled job to keep in sync.
 */
export async function saveAuditSnapshot(
  db: PrismaClient,
  shop: string,
  audit: AuditAggregate,
): Promise<void> {
  await db.seoScoreSnapshot.create({
    data: {
      shop,
      averageScore: audit.averageScore,
      totalScanned: audit.totalScanned,
      totalAvailable: audit.totalAvailable,
      capped: audit.capped,
      payload: JSON.stringify(audit),
    },
  });

  // Prune: find the id of the Nth-newest row and delete everything older.
  // Two small queries beat a single DELETE ... OFFSET (not portable in
  // Prisma) and keep the cap exact even under concurrent writes.
  const keep = await db.seoScoreSnapshot.findMany({
    where: { shop },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: MAX_SNAPSHOTS_PER_SHOP,
  });
  if (keep.length === MAX_SNAPSHOTS_PER_SHOP) {
    await db.seoScoreSnapshot.deleteMany({
      where: { shop, id: { notIn: keep.map((r) => r.id) } },
    });
  }
}

/**
 * Latest snapshot for a shop, or null if none exists yet or the stored
 * payload is corrupt (defensive JSON.parse — a bad row must never 500 the
 * dashboard, just fall back to "no snapshot").
 */
export async function getLatestAuditSnapshot(
  db: PrismaClient,
  shop: string,
): Promise<AuditSnapshot | null> {
  const row = await db.seoScoreSnapshot.findFirst({
    where: { shop },
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

// ─── Locale-aware audit (SEO tab: "Translation SEO" card) ──────────────────
//
// analyzeStore() only ever scores the primary-locale fields. This is a
// separate, much lighter presence check for ONE secondary locale at a time:
// does a translation row exist (with a non-empty value) for title /
// meta_title / meta_description? It does not judge quality (length, etc.) —
// computeSeoScore already owns that for the primary locale, and re-running it
// per secondary locale would need the SAME translated value substituted into
// the scorer, which is a bigger feature than a coverage audit needs right now.
//
// DB-cache-only, same plan-type gating + per-type cap as analyzeStore, and
// runs live in the dashboard loader (no snapshot) — it's a single groupBy
// against ContentTranslation plus the four id/title reads, not a full rescan.

/** ContentTranslation.resourceType strings, keyed by AuditType. Mirrors
 * hreflang.service.ts's own (unexported) RESOURCE_TYPE map — kept as a local
 * copy here rather than a shared import so each read-only audit stays
 * self-contained. */
const RESOURCE_TYPE: Record<AuditType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

/** The three SEO-relevant fields this audit checks per item. */
export type LocaleAuditField = "title" | "metaTitle" | "metaDescription";

/** LocaleAuditField -> the exact ContentTranslation.key string the sync
 * pipeline writes (verified in content-sync.service.ts / hreflang.service.ts:
 * "title", "meta_title", "meta_description" — the same TRANSLATION_KEYS
 * subset hreflang.service.ts tracks, minus body_html which isn't an SEO
 * field). */
const FIELD_TO_KEY: Record<LocaleAuditField, string> = {
  title: "title",
  metaTitle: "meta_title",
  metaDescription: "meta_description",
};

export const LOCALE_AUDIT_FIELDS: LocaleAuditField[] = ["title", "metaTitle", "metaDescription"];

/** Per-field cap on how many missing-item refs are carried for deep-linking —
 * mirrors MAX_PROBLEM_BUCKET_ITEMS / hreflang.service.ts's MISSING_LIST_CAP. */
export const MAX_LOCALE_MISSING_ITEMS = 50;

export interface LocaleMissingItemRef {
  type: AuditType;
  id: string; // Shopify GID — used for the editor deep-link (?select=<GID>)
  title: string; // primary-locale title, reused for display (this IS the untranslated one)
}

export interface LocaleFieldCoverage {
  translated: number;
  total: number;
  /** Rounded translated/total, but never shown as a false 100% while items
   * are still missing (capped at 99 — mirrors hreflang.service.ts). */
  coveragePct: number;
  /** TRUE total of items missing this field — never capped. */
  missingTotal: number;
  /** Affected item refs, capped at MAX_LOCALE_MISSING_ITEMS. */
  missing: LocaleMissingItemRef[];
}

export interface LocaleAudit {
  locale: string;
  /** Items actually scanned (post plan/cap gating) — the shared denominator
   * for every field below, since title/meta_title/meta_description apply to
   * all four content types alike. */
  totalItems: number;
  /** True item count across the plan's allowed types, pre-cap (mirrors
   * analyzeStore's totalAvailable). */
  totalAvailable: number;
  /** True when a type's item set exceeded MAX_AUDIT_ITEMS_PER_TYPE. */
  capped: boolean;
  totals: Record<LocaleAuditField, LocaleFieldCoverage>;
}

export interface AnalyzeLocaleDeps {
  db: PrismaClient;
  plan: Plan;
}

function emptyFieldCoverage(): LocaleFieldCoverage {
  return { translated: 0, total: 0, coveragePct: 0, missingTotal: 0, missing: [] };
}

/**
 * Presence audit (not quality) of title / meta_title / meta_description
 * translations for ONE secondary `locale`. Respects the same plan-type
 * gating and MAX_AUDIT_ITEMS_PER_TYPE cap as analyzeStore so this can never
 * report on a type the shop's plan doesn't include, or scan unboundedly on a
 * huge catalog.
 */
export async function analyzeLocale(
  shop: string,
  locale: string,
  { db, plan }: AnalyzeLocaleDeps,
): Promise<LocaleAudit> {
  const allowed = new Set(PLAN_CONFIG[plan].contentTypes);
  const wants = (type: AuditType) => allowed.has(TYPE_TO_CONTENT_TYPE[type]);
  const take = MAX_AUDIT_ITEMS_PER_TYPE;

  const items: { type: AuditType; id: string; title: string }[] = [];
  let totalAvailable = 0;
  let capped = false;

  const pushType = (type: AuditType, rows: { id: string; title: string }[], total: number) => {
    for (const r of rows) items.push({ type, id: r.id, title: r.title });
    totalAvailable += total;
    if (total > rows.length) capped = true;
  };

  if (wants("product")) {
    const [count, rows] = await Promise.all([
      // Mirrors analyzeStore: only ACTIVE products are storefront-publishable.
      db.product.count({ where: { shop, status: "ACTIVE" } }),
      db.product.findMany({
        where: { shop, status: "ACTIVE" },
        select: { id: true, title: true },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    pushType("product", rows, count);
  }
  if (wants("collection")) {
    const [count, rows] = await Promise.all([
      db.collection.count({ where: { shop } }),
      db.collection.findMany({
        where: { shop },
        select: { id: true, title: true },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    pushType("collection", rows, count);
  }
  if (wants("article")) {
    const [count, rows] = await Promise.all([
      db.article.count({ where: { shop } }),
      db.article.findMany({
        where: { shop },
        select: { id: true, title: true },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    pushType("article", rows, count);
  }
  if (wants("page")) {
    const [count, rows] = await Promise.all([
      db.page.count({ where: { shop } }),
      db.page.findMany({
        where: { shop },
        select: { id: true, title: true },
        orderBy: { lastSyncedAt: "desc" },
        take,
      }),
    ]);
    pushType("page", rows, count);
  }

  const totals: Record<LocaleAuditField, LocaleFieldCoverage> = {
    title: emptyFieldCoverage(),
    metaTitle: emptyFieldCoverage(),
    metaDescription: emptyFieldCoverage(),
  };

  if (items.length === 0) {
    return { locale, totalItems: 0, totalAvailable, capped, totals };
  }

  // One groupBy for all three fields across every resourceType: resourceId is
  // a globally-unique Shopify GID (same reasoning as hreflang.service.ts), so
  // grouping by (resourceId, key) alone maps cleanly back to `items` without
  // also grouping by resourceType. `value: { not: "" }` excludes rows that
  // exist but were saved empty — those count as missing, not translated.
  const groups = await db.contentTranslation.groupBy({
    by: ["resourceId", "key"],
    where: {
      shop,
      locale,
      resourceType: { in: Object.values(RESOURCE_TYPE) },
      key: { in: Object.values(FIELD_TO_KEY) },
      value: { not: "" },
    },
  });

  // key -> set of resourceIds with a non-empty translation for that key.
  const translatedIdsByKey = new Map<string, Set<string>>();
  for (const g of groups) {
    let set = translatedIdsByKey.get(g.key);
    if (!set) {
      set = new Set();
      translatedIdsByKey.set(g.key, set);
    }
    set.add(g.resourceId);
  }

  for (const field of LOCALE_AUDIT_FIELDS) {
    const translatedIds = translatedIdsByKey.get(FIELD_TO_KEY[field]) ?? new Set<string>();
    const coverage = totals[field];
    coverage.total = items.length;
    for (const item of items) {
      if (translatedIds.has(item.id)) {
        coverage.translated += 1;
      } else {
        coverage.missingTotal += 1;
        if (coverage.missing.length < MAX_LOCALE_MISSING_ITEMS) {
          coverage.missing.push({ type: item.type, id: item.id, title: item.title });
        }
      }
    }
    coverage.coveragePct =
      coverage.total > 0 ? Math.round((coverage.translated / coverage.total) * 100) : 0;
    // Same "never a false 100% while items are missing" guard as hreflang.service.ts.
    if (coverage.coveragePct === 100 && coverage.missingTotal > 0) coverage.coveragePct = 99;
  }

  return { locale, totalItems: items.length, totalAvailable, capped, totals };
}

/**
 * Lightweight history for the dashboard's trend chart — select-minimized
 * (never touches `payload`) so this stays cheap even with the full 30-row cap.
 * Returned oldest -> newest (chart reading order).
 */
export async function getAuditTrend(
  db: PrismaClient,
  shop: string,
  limit: number = MAX_SNAPSHOTS_PER_SHOP,
): Promise<AuditTrendPoint[]> {
  const rows = await db.seoScoreSnapshot.findMany({
    where: { shop },
    select: { createdAt: true, averageScore: true, totalScanned: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

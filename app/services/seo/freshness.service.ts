/**
 * Content-Freshness audit (Phase 3 of PLAN_SEO_SUITE_COMPLETION.md §5).
 *
 * Crossmatches the per-page GSC rollup (SeoGscPageStat — written daily by
 * enrichPageStatsFromGsc / gsc-auto-sync.service.ts, §5.1 option b) against
 * `shopifyUpdatedAt` on Product/Collection/Article/Page: "this page ranks and
 * gets traffic, but hasn't been touched in months → refresh candidate."
 *
 * DB-cache-first, no live Shopify or GSC calls (SEO_SECTION_CONTRACT.md §3/§6)
 * — SeoGscPageStat is itself a DB cache the daily sync populates; this service
 * only reads it and the existing content caches.
 *
 * "Refresh candidate" (§5.2), thresholds as service constants (not
 * UI-configurable in v1):
 *   - avg GSC position ≤ FRESHNESS_MAX_POSITION (ranks at all),
 *   - impressions ≥ FRESHNESS_MIN_IMPRESSIONS in the 90-day window
 *     SeoGscPageStat carries (not a dead page),
 *   - shopifyUpdatedAt older than FRESHNESS_STALE_DAYS.
 *
 * Bonus signal: CTR under-performing for its position band doubles priority.
 * Reuses `findCtrOpportunities` (google-search-console.server.ts) — the exact
 * position/impressions banding the existing Quick-wins panel already uses to
 * decide "this ranks decently but a title/meta rewrite has leverage here" —
 * instead of re-declaring a second position→expected-CTR curve.
 */

import type { PrismaClient } from "@prisma/client";
import { findCtrOpportunities } from "../google-search-console.server";

/** Ranks at all — page 1-2 of results, roughly. */
export const FRESHNESS_MAX_POSITION = 20;
/** Floor so a page with a handful of stray impressions doesn't qualify. */
export const FRESHNESS_MIN_IMPRESSIONS = 100;
/** Content untouched for this long is a refresh candidate, GSC signals permitting. */
export const FRESHNESS_STALE_DAYS = 180;

export type FreshnessResourceType = "Product" | "Collection" | "Article" | "Page";

export interface FreshnessCandidate {
  resourceType: FreshnessResourceType;
  resourceId: string; // Shopify GID
  title: string;
  handle: string;
  page: string; // GSC page URL
  position: number;
  ctr: number;
  impressions: number;
  clicks: number;
  shopifyUpdatedAt: Date;
  daysSinceUpdate: number;
  /** 2 = CTR bonus signal fired (double priority), 1 = normal. Sort key. */
  priority: 1 | 2;
}

export interface FreshnessResult {
  candidates: FreshnessCandidate[];
}

export interface FreshnessDeps {
  db: PrismaClient;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RESOURCE_TYPES: FreshnessResourceType[] = ["Product", "Collection", "Article", "Page"];

interface CachedItem {
  title: string;
  handle: string;
  shopifyUpdatedAt: Date;
}

/**
 * Read-only join over SeoGscPageStat × the content caches. Pure aside from
 * the two DB reads — safe to call from a route loader (SEO_SECTION_CONTRACT.md
 * §8: this is NOT a long operation, no Task needed).
 */
export async function analyzeFreshness(shop: string, deps: FreshnessDeps): Promise<FreshnessResult> {
  const { db } = deps;
  const now = deps.now ?? new Date();

  // Push the position/impressions half of the rule into the query itself —
  // cheaper than fetching every page stat row and filtering in memory.
  const pageStats = await db.seoGscPageStat.findMany({
    where: {
      shop,
      resourceType: { not: null },
      resourceId: { not: null },
      position: { lte: FRESHNESS_MAX_POSITION },
      impressions: { gte: FRESHNESS_MIN_IMPRESSIONS },
    },
  });
  if (pageStats.length === 0) return { candidates: [] };

  const idsByType: Record<FreshnessResourceType, string[]> = {
    Product: [],
    Collection: [],
    Article: [],
    Page: [],
  };
  for (const stat of pageStats) {
    const type = stat.resourceType as FreshnessResourceType | null;
    if (type && stat.resourceId && RESOURCE_TYPES.includes(type)) {
      idsByType[type].push(stat.resourceId);
    }
  }

  const [products, collections, articles, pages] = await Promise.all([
    idsByType.Product.length
      ? db.product.findMany({
          where: { shop, id: { in: idsByType.Product } },
          select: { id: true, title: true, handle: true, shopifyUpdatedAt: true },
        })
      : Promise.resolve([]),
    idsByType.Collection.length
      ? db.collection.findMany({
          where: { shop, id: { in: idsByType.Collection } },
          select: { id: true, title: true, handle: true, shopifyUpdatedAt: true },
        })
      : Promise.resolve([]),
    idsByType.Article.length
      ? db.article.findMany({
          where: { shop, id: { in: idsByType.Article } },
          select: { id: true, title: true, handle: true, shopifyUpdatedAt: true },
        })
      : Promise.resolve([]),
    idsByType.Page.length
      ? db.page.findMany({
          where: { shop, id: { in: idsByType.Page } },
          select: { id: true, title: true, handle: true, shopifyUpdatedAt: true },
        })
      : Promise.resolve([]),
  ]);

  // Keyed by `${resourceType}::${id}` — a Product and an Article can share a
  // cuid-free Shopify GID space, but GIDs already embed the type
  // ("gid://shopify/Product/123" vs ".../Article/123"), so a plain id map
  // would be safe too; the composite key just makes that non-collision
  // explicit rather than relying on it.
  const byKey = new Map<string, CachedItem>();
  const fill = (type: FreshnessResourceType, rows: Array<{ id: string; title: string; handle: string; shopifyUpdatedAt: Date }>) => {
    for (const row of rows) {
      byKey.set(`${type}::${row.id}`, { title: row.title, handle: row.handle, shopifyUpdatedAt: row.shopifyUpdatedAt });
    }
  };
  fill("Product", products);
  fill("Collection", collections);
  fill("Article", articles);
  fill("Page", pages);

  const staleCutoff = now.getTime() - FRESHNESS_STALE_DAYS * DAY_MS;

  const candidates: FreshnessCandidate[] = [];
  for (const stat of pageStats) {
    const type = stat.resourceType as FreshnessResourceType | null;
    if (!type || !stat.resourceId) continue;
    const item = byKey.get(`${type}::${stat.resourceId}`);
    if (!item) continue; // resolved id no longer in the content cache (deleted/renamed)
    if (item.shopifyUpdatedAt.getTime() > staleCutoff) continue; // touched recently — not a candidate

    // Bonus signal (§5.2): feed this single row through the existing
    // Quick-wins filter (position band + impression floor) rather than
    // re-declaring a second "expected CTR for this position" rule. A
    // non-empty result means the row itself would qualify as a Quick win.
    const isCtrOpportunity =
      findCtrOpportunities(
        [{ keys: ["", stat.page], clicks: stat.clicks, impressions: stat.impressions, ctr: stat.ctr, position: stat.position }],
        1,
      ).length > 0;

    candidates.push({
      resourceType: type,
      resourceId: stat.resourceId,
      title: item.title,
      handle: item.handle,
      page: stat.page,
      position: stat.position,
      ctr: stat.ctr,
      impressions: stat.impressions,
      clicks: stat.clicks,
      shopifyUpdatedAt: item.shopifyUpdatedAt,
      daysSinceUpdate: Math.floor((now.getTime() - item.shopifyUpdatedAt.getTime()) / DAY_MS),
      priority: isCtrOpportunity ? 2 : 1,
    });
  }

  // Highest priority first, then worst (lowest) position within a tier.
  candidates.sort((a, b) => b.priority - a.priority || a.position - b.position);

  return { candidates };
}

/** Composite dismissed-list key (AISettings.seoFreshnessDismissed, §5.3/§5.5). */
export function freshnessDismissKey(resourceType: FreshnessResourceType, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

/** Filter out candidates the merchant already dismissed. Pure/exported for unit testing. */
export function excludeDismissed(
  candidates: FreshnessCandidate[],
  dismissed: readonly string[],
): FreshnessCandidate[] {
  if (dismissed.length === 0) return candidates;
  const dismissedSet = new Set(dismissed);
  return candidates.filter((c) => !dismissedSet.has(freshnessDismissKey(c.resourceType, c.resourceId)));
}

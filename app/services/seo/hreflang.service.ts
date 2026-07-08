/**
 * hreflang audit (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 4 / A5).
 *
 * Shopify Markets injects `<link rel="alternate" hreflang>` natively, so we do
 * NOT generate hreflang — the value is an AUDIT that finds the gaps that break
 * it: published secondary locales whose items are not actually translated, so
 * the alternate points at untranslated/identical content.
 *
 * Read-only and DB-cache-first: published locales come from the existing 60s
 * shop-locales cache; coverage is derived from the ContentTranslation cache
 * (there is no per-locale "published" flag in Shopify, so "publishable but
 * untranslated" is the signal). No new model, no new scope.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { getCachedShopLocales } from "../../utils/shop-locales-cache.server";

export type HreflangType = "product" | "collection" | "article" | "page";

/** ContentTranslation.resourceType values, keyed by our short type. */
const RESOURCE_TYPE: Record<HreflangType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

/**
 * A resource counts as "translated" in a locale if any of these keys is present.
 * These are exactly the Shopify translation keys the pipeline writes for the
 * audited resource types (A5). (`body` is only written for ShopPolicy, which we
 * don't audit, so it is deliberately omitted.)
 */
const TRANSLATION_KEYS = ["title", "body_html", "meta_title", "meta_description"];

/** Per-type publishable scan cap (id+title only — bounds memory on huge shops). */
export const PUBLISHABLE_SCAN_CAP = 2000;
/** Max missing items listed per locale (the coverage % still reflects the scan). */
export const MISSING_LIST_CAP = 500;

export interface MissingItem {
  resourceType: HreflangType;
  resourceId: string; // Shopify GID — editor deep-link
  title: string;
}

export interface LocaleCoverage {
  locale: string;
  name: string;
  publishableScanned: number;
  translated: number;
  coveragePct: number;
  missing: MissingItem[]; // capped at MISSING_LIST_CAP
  missingTotal: number;
}

export interface HreflangResult {
  primaryLocale: string | null;
  /** x-default is satisfied when the shop has a primary locale. */
  hasXDefault: boolean;
  secondaryLocales: Array<{ locale: string; name: string }>;
  /** True when there are no published secondary locales to audit. */
  localesUnavailable: boolean;
  /** True when a type's publishable set exceeded the scan cap. */
  capped: boolean;
  totalPublishable: number;
  coverage: LocaleCoverage[];
}

interface PublishableItem {
  resourceType: HreflangType;
  id: string;
  title: string;
}

export interface AnalyzeHreflangDeps {
  db: PrismaClient;
  admin: AdminApiContext;
}

export async function analyzeHreflang(
  shop: string,
  { db, admin }: AnalyzeHreflangDeps,
): Promise<HreflangResult> {
  const locales = await getCachedShopLocales(admin, shop);
  const primary = locales.find((l) => l.primary) || null;
  const secondary = locales.filter((l) => l.published && !l.primary);

  const base: HreflangResult = {
    primaryLocale: primary?.locale ?? null,
    hasXDefault: !!primary,
    secondaryLocales: secondary.map((l) => ({ locale: l.locale, name: l.name })),
    localesUnavailable: secondary.length === 0,
    capped: false,
    totalPublishable: 0,
    coverage: [],
  };

  if (secondary.length === 0) return base;

  // ---- Publishable set (id + title) per type, DB-cache-first ----
  const items: PublishableItem[] = [];
  let capped = false;

  const pushType = (
    type: HreflangType,
    rows: Array<{ id: string; title: string }>,
    total: number,
  ) => {
    for (const r of rows) items.push({ resourceType: type, id: r.id, title: r.title });
    if (total > rows.length) capped = true;
  };

  const [
    productCount,
    products,
    collectionCount,
    collections,
    articleCount,
    articles,
    pageCount,
    pages,
  ] = await Promise.all([
    // Products: only ACTIVE products are storefront-publishable.
    db.product.count({ where: { shop, status: "ACTIVE" } }),
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { id: true, title: true },
      orderBy: { lastSyncedAt: "desc" },
      take: PUBLISHABLE_SCAN_CAP,
    }),
    // Collections/Articles/Pages have no status field → treat all cache rows live.
    db.collection.count({ where: { shop } }),
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true },
      orderBy: { lastSyncedAt: "desc" },
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.article.count({ where: { shop } }),
    db.article.findMany({
      where: { shop },
      select: { id: true, title: true },
      orderBy: { lastSyncedAt: "desc" },
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.page.count({ where: { shop } }),
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true },
      orderBy: { lastSyncedAt: "desc" },
      take: PUBLISHABLE_SCAN_CAP,
    }),
  ]);

  pushType("product", products, productCount);
  pushType("collection", collections, collectionCount);
  pushType("article", articles, articleCount);
  pushType("page", pages, pageCount);

  base.totalPublishable = items.length;
  base.capped = capped;

  if (items.length === 0) return base;

  const resourceTypes = Object.values(RESOURCE_TYPE);

  // ---- Coverage per secondary locale ----
  const coverage: LocaleCoverage[] = [];
  for (const loc of secondary) {
    // One grouped read per locale: resourceIds that have at least one of the
    // tracked keys translated in this locale. GIDs are globally unique, so
    // grouping by resourceId (with a resourceType filter) maps cleanly to items.
    const groups = await db.contentTranslation.groupBy({
      by: ["resourceId"],
      where: {
        shop,
        locale: loc.locale,
        resourceType: { in: resourceTypes },
        key: { in: TRANSLATION_KEYS },
      },
    });
    const translatedIds = new Set(groups.map((g) => g.resourceId));

    const missing: MissingItem[] = [];
    let translated = 0;
    let missingTotal = 0;
    for (const item of items) {
      if (translatedIds.has(item.id)) {
        translated += 1;
      } else {
        missingTotal += 1;
        if (missing.length < MISSING_LIST_CAP) {
          missing.push({
            resourceType: item.resourceType,
            resourceId: item.id,
            title: item.title,
          });
        }
      }
    }

    // Never show a green 100% while items are still missing: rounding 997/1000
    // up to 100 next to a non-empty missing list is contradictory. Cap at 99
    // until coverage is truly complete.
    let coveragePct = items.length > 0 ? Math.round((translated / items.length) * 100) : 0;
    if (coveragePct === 100 && missingTotal > 0) coveragePct = 99;

    coverage.push({
      locale: loc.locale,
      name: loc.name,
      publishableScanned: items.length,
      translated,
      coveragePct,
      missing,
      missingTotal,
    });
  }

  base.coverage = coverage;
  return base;
}

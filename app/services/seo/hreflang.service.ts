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
 *
 * The coverage this produces is the app's ONE language-coverage number — it
 * answers "what exactly is missing in this language" per TYPE and per FIELD
 * here rather than in a second dashboard, which would repeat the
 * catalog-readiness/analyzeStore mistake (two numbers for one product in two
 * tabs). The arithmetic lives in hreflang-coverage.shared.ts; this module only
 * reads the cache and hands it over.
 *
 * QUERY COUNT, as a function of the L published secondary locales: 13 + L.
 * Thirteen fixed catalog reads, all issued together — per audited type a
 * publishable count, a page of rows and an id-only "which of these have a body"
 * read, plus one unfiltered product count — and then exactly ONE grouped
 * translation read per locale, grouping by (resourceId, key) so the per-type
 * AND per-field gaps both fall out of that single read. Never fan out per
 * (locale, type): that is L x 4 round trips for an answer one query contains.
 *
 * The "stale" dimension of the roadmap entry is deliberately NOT here:
 * ContentTranslation has a `digest` column but no `outdated` one, so whether a
 * translation's source text has moved on is not derivable from the cache
 * (findStaleTranslations needs Shopify data). Adding a live sweep would break
 * this module's DB-cache-first contract and put an API cost on every render;
 * the sound route is a persisted marker written where the digest comparison
 * already proves it, i.e. a migration — the owner's call, not this module's.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getCachedShopLocales } from "../../utils/shop-locales-cache.server";
import {
  HREFLANG_TYPES,
  TRANSLATION_KEYS,
  computeLocaleCoverage,
  requiredKeysFor,
  type HreflangType,
  type LocaleCoverage,
  type PublishableItem,
  type TypeScan,
} from "./hreflang-coverage.shared";

export type {
  FieldGap,
  HreflangType,
  LocaleCoverage,
  MissingItem,
  TranslationKey,
  TypeCoverage,
  TypeScan,
} from "./hreflang-coverage.shared";
export { HREFLANG_TYPES, TRANSLATION_KEYS } from "./hreflang-coverage.shared";

/** ContentTranslation.resourceType values, keyed by our short type. */
const RESOURCE_TYPE: Record<HreflangType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

/**
 * Per-type publishable scan cap.
 *
 * The row payload stays SMALL — id, title and the two SEO fields, which Shopify
 * itself bounds at roughly a title and a meta description. `descriptionHtml` /
 * `body` are deliberately NOT selected: they are unbounded TEXT, and pulling up
 * to four times this many article bodies into a web request to derive one
 * boolean per row is the memory blow-up the original "id+title only" note was
 * about. Their presence comes from an id-only companion read instead.
 */
export const PUBLISHABLE_SCAN_CAP = 2000;
/** Max missing items listed per locale (the coverage % still reflects the scan). */
export const MISSING_LIST_CAP = 500;

/**
 * The order EVERY read of a type uses — the scanned page and its id-only body
 * companion alike, and TOTAL (the id breaks ties) rather than merely by
 * timestamp.
 *
 * That is what lets the companion read carry its own `take`: a row inside the
 * scanned page can only be preceded, in the filtered order, by rows that also
 * sit inside it, so the companion's first CAP ids cover every scanned row that
 * has a body. Two rows sharing a `lastSyncedAt` under a partial order could
 * land on either side of that boundary in one query and not the other, which
 * would silently read as "this product has no description".
 */
const SCAN_ORDER = [{ lastSyncedAt: "desc" as const }, { id: "asc" as const }];

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
  /**
   * Per locale. Each entry carries its own per-type and per-field breakdown —
   * including the types whose cache is empty, which read as unknown there
   * rather than as complete. There is deliberately no second, locale-free copy
   * of the scan facts in this payload: one of the two would end up rendered and
   * the other would drift.
   */
  coverage: LocaleCoverage[];
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

  // ---- Publishable set per type, DB-cache-first ----
  const items: PublishableItem[] = [];
  const typeScans: TypeScan[] = [];

  const pushType = (
    type: HreflangType,
    rows: Array<{
      id: string;
      title: string;
      seoTitle?: string | null;
      seoDescription?: string | null;
    }>,
    total: number,
    /** Ids of the rows whose body/description carries something. */
    withBody: Array<{ id: string }>,
    /** Cached rows of this type BEFORE the publishable filter. */
    anyCached: number,
  ) => {
    const bodyIds = new Set(withBody.map((r) => r.id));
    for (const r of rows) {
      items.push({
        resourceType: type,
        id: r.id,
        title: r.title,
        // Only keys whose PRIMARY value exists can be missing — a meta
        // description that is empty in the primary locale is not a translation
        // gap, it is content nobody wrote.
        requiredKeys: requiredKeysFor({
          title: r.title,
          body: bodyIds.has(r.id) ? "x" : null, // presence only; the text is never loaded
          seoTitle: r.seoTitle ?? null,
          seoDescription: r.seoDescription ?? null,
        }),
      });
    }
    typeScans.push({
      resourceType: type,
      cachedTotal: total,
      scanned: rows.length,
      capped: total > rows.length,
      // An empty cache is never evidence: a type nobody ever synced looks
      // exactly like a shop that has none of them, so it stays UNKNOWN. Asked
      // WITHOUT the publishable filter, so a catalogue that is entirely DRAFT
      // is known (and simply has nothing to translate) rather than unscanned.
      known: anyCached > 0,
    });
  };

  const [
    anyProductCount,
    productCount,
    products,
    productsWithBody,
    collectionCount,
    collections,
    collectionsWithBody,
    articleCount,
    articles,
    articlesWithBody,
    pageCount,
    pages,
    pagesWithBody,
  ] = await Promise.all([
    // Products: ACTIVE only — deliberately NOT extended to UNLISTED the way
    // audit.service.ts was (AUDITABLE_PRODUCT_STATUSES). hreflang annotations
    // exist to tell a search engine which localized URL to serve for a page it
    // indexes; Shopify serves unlisted product pages `noindex,nofollow` and
    // omits them from sitemap.xml (measured — see sitemap.service.ts's header),
    // so there is no indexed page for an alternate to point at. Auditing
    // hreflang coverage for them would report a defect that is correct to leave
    // as it is. DRAFT/ARCHIVED are not storefront-reachable at all — but they
    // still answer "has this type ever been synced", which is why the first
    // count carries no status filter.
    db.product.count({ where: { shop } }),
    db.product.count({ where: { shop, status: "ACTIVE" } }),
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { id: true, title: true, seoTitle: true, seoDescription: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.product.findMany({
      where: { shop, status: "ACTIVE", descriptionHtml: { not: null }, NOT: { descriptionHtml: "" } },
      select: { id: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    // Collections/Articles/Pages have no status field → treat all cache rows
    // live, so their publishable count IS their cached count.
    db.collection.count({ where: { shop } }),
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true, seoTitle: true, seoDescription: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.collection.findMany({
      where: { shop, descriptionHtml: { not: null }, NOT: { descriptionHtml: "" } },
      select: { id: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.article.count({ where: { shop } }),
    db.article.findMany({
      where: { shop },
      select: { id: true, title: true, seoTitle: true, seoDescription: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.article.findMany({
      where: { shop, body: { not: null }, NOT: { body: "" } },
      select: { id: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.page.count({ where: { shop } }),
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true, seoTitle: true, seoDescription: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
    db.page.findMany({
      where: { shop, body: { not: null }, NOT: { body: "" } },
      select: { id: true },
      orderBy: SCAN_ORDER,
      take: PUBLISHABLE_SCAN_CAP,
    }),
  ]);

  pushType("product", products, productCount, productsWithBody, anyProductCount);
  pushType("collection", collections, collectionCount, collectionsWithBody, collectionCount);
  pushType("article", articles, articleCount, articlesWithBody, articleCount);
  pushType("page", pages, pageCount, pagesWithBody, pageCount);

  // Keep the scans in the audit's reading order regardless of push order.
  typeScans.sort(
    (a, b) => HREFLANG_TYPES.indexOf(a.resourceType) - HREFLANG_TYPES.indexOf(b.resourceType),
  );

  base.totalPublishable = items.length;
  base.capped = typeScans.some((s) => s.capped);

  if (items.length === 0) return base;

  const resourceTypes = Object.values(RESOURCE_TYPE);
  const trackedKeys: string[] = [...TRANSLATION_KEYS];

  // ---- Coverage per secondary locale ----
  const coverage: LocaleCoverage[] = [];
  for (const loc of secondary) {
    // ONE grouped read per locale — the whole per-type/per-field answer comes
    // out of this single query. Grouping by (resourceId, key) rather than by
    // resourceId alone is what makes the field dimension free: GIDs are
    // globally unique, so the resourceId maps cleanly back to the scanned item
    // and carries its type with it.
    //
    // A row whose value is empty is NOT a translation: the storefront falls
    // back to the primary either way (the same rule removeAndVerify follows),
    // and crediting one would report a field as done that reads untranslated.
    // Stated residual: the DB filter cannot TRIM, while the primary side does,
    // so a whitespace-only translation still counts as present. Both halves
    // therefore err toward not reporting a defect, which is the safe direction
    // for a list a merchant works through.
    //
    // GLOBAL layer only. A market override is a second wording of the same
    // locale for one market, and it does not translate the locale's ordinary
    // URL — which is exactly the URL the hreflang alternate points at. Counting
    // one as coverage would report a language as done while most visitors in it
    // are served the primary text.
    const groups = await db.contentTranslation.groupBy({
      by: ["resourceId", "key"],
      where: {
        shop,
        locale: loc.locale,
        marketId: "",
        resourceType: { in: resourceTypes },
        key: { in: trackedKeys },
        NOT: { value: "" },
      },
    });

    const translatedKeys = new Map<string, Set<string>>();
    for (const g of groups) {
      let set = translatedKeys.get(g.resourceId);
      if (!set) {
        set = new Set<string>();
        translatedKeys.set(g.resourceId, set);
      }
      set.add(g.key);
    }

    coverage.push(
      computeLocaleCoverage({
        locale: loc.locale,
        name: loc.name,
        items,
        typeScans,
        translatedKeys,
        missingListCap: MISSING_LIST_CAP,
      }),
    );
  }

  base.coverage = coverage;
  return base;
}

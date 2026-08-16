/**
 * Builds the on-page report from one crawl snapshot
 * (PLAN_SEO_CRAWL_EXPANSION §3.7).
 *
 * Extracted from the former `/app/seo/onpage` route when the two reports became
 * two STEPS of one crawl tab rather than two nav entries: the crawl route now
 * calls this only when the merchant is actually looking at step 2, so the
 * expensive half (all snapshot rows + head drift + the shop name) is never paid
 * for by someone reading the delivery report.
 */

import type { PrismaClient } from "@prisma/client";
import {
  analyzeIndexability,
  analyzeCanonicals,
  analyzeHeadings,
  findMissingMetaDescriptions,
  findImagesWithoutAlt,
  findThinPages,
  canonicalHostFromPages,
  selfCanonicalPages,
  THIN_MIN_SAMPLE,
  type OnPageRow,
  type IndexabilityFinding,
  type CanonicalFinding,
  type OnPageIssueRow,
  type ThinPageRow,
} from "./onpage.service";
import { loadExpectedNoindexReasons } from "./crawl-snapshot.server";
import {
  computeHeadDrift,
  groupDuplicateTitles,
  groupDuplicateValues,
  normalizeMetaDescription,
} from "./crawl.service";
import { fetchPrimaryDomain } from "../../utils/shop-domain.server";
import type { AuditType } from "./audit.service";

const UI_ROW_CAP = 100;

const SHOP_NAME_QUERY = `#graphql
  query seoOnPageShopName {
    shop { name }
  }
`;

async function fetchShopName(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.name || fallbackShop.replace(/\.myshopify\.com$/, "");
  } catch {
    return fallbackShop.replace(/\.myshopify\.com$/, "");
  }
}

export interface HeadDriftRow {
  url: string;
  resourceType: AuditType;
  resourceId: string;
  title: string;
  crawledTitle: string;
  dbTitle: string;
}

export interface DuplicateGroupRow {
  title: string;
  urls: Array<{
    url: string;
    resourceType: string | null;
    resourceId: string | null;
    locale: string;
  }>;
}

/** Every list the on-page report renders, empty — used by the gated and
 *  never-scanned responses so a new category can't be forgotten in one. */
export const EMPTY_ONPAGE_REPORT = {
  indexabilityProblems: [] as IndexabilityFinding[],
  indexabilityExpected: [] as IndexabilityFinding[],
  nofollowOnly: [] as IndexabilityFinding[],
  indexabilityUnknown: 0,
  indexabilityConsidered: 0,
  canonicals: [] as CanonicalFinding[],
  h1Missing: [] as OnPageIssueRow[],
  h1Multiple: [] as OnPageIssueRow[],
  h1SameAsTitle: [] as OnPageIssueRow[],
  metaMissing: [] as OnPageIssueRow[],
  metaDuplicates: [] as DuplicateGroupRow[],
  thin: [] as ThinPageRow[],
  thinSkippedTypes: [] as Array<{ resourceType: string; pageCount: number }>,
  images: [] as OnPageIssueRow[],
  headDrift: [] as HeadDriftRow[],
  duplicates: [] as DuplicateGroupRow[],
  thinMinSample: THIN_MIN_SAMPLE,
  parseStateKnown: false,
  totals: {
    indexability: 0,
    indexabilityExpected: 0,
    nofollowOnly: 0,
    canonicals: 0,
    h1: 0,
    h1Missing: 0,
    h1Multiple: 0,
    h1SameAsTitle: 0,
    meta: 0,
    thin: 0,
    images: 0,
    headDrift: 0,
    duplicates: 0,
    metaDuplicates: 0,
  },
};

export type OnPageReport = typeof EMPTY_ONPAGE_REPORT;

export async function buildOnPageReport(
  db: PrismaClient,
  admin: any,
  shop: string,
  snapshotId: string,
): Promise<OnPageReport> {
  // ALL rows, not just the 2xx ones: "canonical points at a 404" is only
  // answerable if the 404 row is in the map. Only 2xx rows are ever JUDGED
  // (every rule filters on the status itself) — the rest are lookup targets.
  const pages: OnPageRow[] = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshotId },
    select: {
      url: true,
      title: true,
      metaDesc: true,
      canonical: true,
      metaRobots: true,
      xRobotsTag: true,
      indexabilityKnown: true,
      h1Count: true,
      h1First: true,
      wordCount: true,
      imgCount: true,
      imgMissingAlt: true,
      statusCode: true,
      redirectHops: true,
      resourceType: true,
      resourceId: true,
      locale: true,
    },
  });

  // §3.2 — what makes a `noindex` EXPECTED rather than a finding.
  const expectedByResource = await loadExpectedNoindexReasons(db, shop);

  const [shopName, primaryDomain] = await Promise.all([
    fetchShopName(admin, shop),
    fetchPrimaryDomain(admin, shop),
  ]);

  const indexability = analyzeIndexability(pages, expectedByResource);
  // The host comes from the crawled URLs, never from `fetchPrimaryDomain` —
  // that one falls back to the myshopify host on a throttled Admin call, and
  // every canonical would then read as "foreign domain". The looked-up domain
  // is passed as an ALIAS instead, so a canonical spelled either way collapses.
  const canonicalHost = canonicalHostFromPages(pages);
  const canonicals = canonicalHost
    ? analyzeCanonicals(pages, canonicalHost, [shop, primaryDomain])
    : [];
  const headings = analyzeHeadings(pages);
  const metaMissing = findMissingMetaDescriptions(pages);
  const images = findImagesWithoutAlt(pages);
  const thin = findThinPages(pages);

  const okPages = pages.filter((p) => p.statusCode >= 200 && p.statusCode < 300);
  // Duplicates are judged ONLY on pages Google would index under their own URL.
  // Shopify answers 200 for a translated product under its primary handle
  // behind every locale prefix (/es/products/<german-handle>, /fr/…), each
  // serving the untranslated title and canonicalising to the properly
  // translated URL — so grouping by title alone reports one product as five
  // duplicates on every multilingual shop.
  const indexablePages = selfCanonicalPages(okPages, canonicalHost, [shop, primaryDomain]);
  // Totals BEFORE the slice — taking `.length` of an already-sliced array is
  // how a tile ends up reporting the cap ("100") as the answer.
  const duplicatesAll = groupDuplicateTitles(
    indexablePages.map((p) => ({ url: p.url, title: p.title })),
    shopName,
  );
  const metaDuplicatesAll = groupDuplicateValues(
    indexablePages.map((p) => ({ url: p.url, value: p.metaDesc })),
    normalizeMetaDescription,
  );

  // Each grouped URL carries its resource back, so a duplicate row can offer
  // the editor directly instead of making the merchant hunt for the product.
  const rowByUrl = new Map(pages.map((p) => [p.url, p]));
  const withResources = (groups: { title: string; urls: string[] }[]): DuplicateGroupRow[] =>
    groups.map((group) => ({
      title: group.title,
      urls: group.urls.map((url) => {
        const row = rowByUrl.get(url);
        return {
          url,
          resourceType: row?.resourceType ?? null,
          resourceId: row?.resourceId ?? null,
          locale: row?.locale ?? "",
        };
      }),
    }));
  const duplicates = withResources(duplicatesAll.slice(0, UI_ROW_CAP));
  const metaDuplicates = withResources(metaDuplicatesAll.slice(0, UI_ROW_CAP));

  // §3.8 — head drift moved over from the crawl tab, comparison rule unchanged.
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
  // `count` is the TRUE total, `items` the capped slice — the tile must show
  // the former, or every shop past 100 findings reads exactly "100".
  const headDriftResult = await computeHeadDrift(db, shop, headDriftCandidates, shopName, UI_ROW_CAP);
  const urlByResource = new Map(
    pages
      .filter((p) => p.resourceId && p.resourceType)
      .map((p) => [`${p.resourceType}:${p.resourceId}`, p.url]),
  );
  const headDrift: HeadDriftRow[] = headDriftResult.items.map((i) => ({
    url: urlByResource.get(`${i.type}:${i.id}`) || "",
    resourceType: i.type,
    resourceId: i.id,
    title: i.title,
    crawledTitle: i.crawledTitle,
    dbTitle: i.dbTitle,
  }));

  return {
    indexabilityProblems: indexability.problems.slice(0, UI_ROW_CAP),
    indexabilityExpected: indexability.expected.slice(0, UI_ROW_CAP),
    nofollowOnly: indexability.nofollowOnly.slice(0, UI_ROW_CAP),
    indexabilityUnknown: indexability.unknownCount,
    indexabilityConsidered: indexability.consideredCount,
    canonicals: canonicals.slice(0, UI_ROW_CAP),
    h1Missing: headings.missing.slice(0, UI_ROW_CAP),
    h1Multiple: headings.multiple.slice(0, UI_ROW_CAP),
    h1SameAsTitle: headings.sameAsTitle.slice(0, UI_ROW_CAP),
    metaMissing: metaMissing.slice(0, UI_ROW_CAP),
    metaDuplicates,
    thin: thin.pages.slice(0, UI_ROW_CAP),
    thinSkippedTypes: thin.skippedTypes,
    images: images.slice(0, UI_ROW_CAP),
    headDrift,
    duplicates,
    thinMinSample: THIN_MIN_SAMPLE,
    // §2.2/§2.3 — this snapshot records whether a page's body was parsed. The
    // two categories built on the NEW columns (images, "H1 equals title") are
    // unmeasurable without it and must say "unknown" rather than "none found".
    parseStateKnown: headings.sameAsTitleKnown,
    // TRUE totals, before every UI_ROW_CAP slice above: the tiles and the
    // "showing N of M" notices both read these, so neither can quietly report
    // the cap as the answer.
    totals: {
      indexability: indexability.problems.length,
      indexabilityExpected: indexability.expected.length,
      nofollowOnly: indexability.nofollowOnly.length,
      canonicals: canonicals.length,
      h1: headings.missing.length + headings.multiple.length,
      h1Missing: headings.missing.length,
      h1Multiple: headings.multiple.length,
      h1SameAsTitle: headings.sameAsTitle.length,
      meta: metaMissing.length,
      thin: thin.pages.length,
      images: images.length,
      headDrift: headDriftResult.count,
      duplicates: duplicatesAll.length,
      metaDuplicates: metaDuplicatesAll.length,
    },
  };
}

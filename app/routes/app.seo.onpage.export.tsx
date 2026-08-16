/**
 * Resource route: CSV export of one on-page/indexability category
 * (PLAN_SEO_CRAWL_EXPANSION §5).
 *
 * Same shape and the same gate rationale as `app.seo.crawl.export.tsx` — see
 * its header for why the plan check has to live in the route itself.
 *
 * The findings are recomputed here from the snapshot rather than cached: the
 * rules are pure functions over rows we have to load anyway, and a second
 * (drifting) copy of "what counts as a finding" is the thing the pure-function
 * split exists to prevent.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { toCsv, csvFilename, type CsvColumn } from "../services/seo/csv-export";
import {
  analyzeIndexability,
  analyzeCanonicals,
  analyzeHeadings,
  findMissingMetaDescriptions,
  findImagesWithoutAlt,
  findThinPages,
  type OnPageRow,
} from "../services/seo/onpage.service";
import type { AuditType } from "../services/seo/audit.service";

const SHOP_NAME_QUERY = `#graphql
  query seoOnPageExportShopName {
    shop { name }
  }
`;

/** The shop's display name, needed to strip the theme's "– ShopName" suffix
 *  before comparing titles. Getting this wrong doesn't degrade the head-drift
 *  and duplicate-title results — it INVERTS them (every page drifts), so the
 *  export asks Shopify rather than guessing from the myshopify handle. */
async function fetchShopName(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.name || fallbackShop.replace(/\.myshopify\.com$/, "");
  } catch {
    return fallbackShop.replace(/\.myshopify\.com$/, "");
  }
}

const CATEGORIES = [
  "indexability",
  "canonicals",
  "h1",
  "meta",
  "thin",
  "images",
  "headDrift",
  "duplicates",
] as const;
type Category = (typeof CATEGORIES)[number];

/** One flat row shape for every category — a CSV per category with its own
 *  column set would make the export harder to use than the tab it replaces. */
interface ExportRow {
  url: string;
  finding: string;
  detail: string;
  title: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

const COLUMNS: CsvColumn<ExportRow>[] = [
  { header: "url", value: (r) => r.url },
  { header: "finding", value: (r) => r.finding },
  { header: "detail", value: (r) => r.detail },
  { header: "title", value: (r) => r.title },
  { header: "resource_type", value: (r) => r.resourceType },
  { header: "resource_id", value: (r) => r.resourceId },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ error: "plan_required" }, { status: 403 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("category") as Category | null;
  const category: Category = requested && CATEGORIES.includes(requested) ? requested : "indexability";
  const filename = csvFilename(`onpage-${category}`, shop);

  const snapshot = await db.seoCrawlSnapshot.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!snapshot) return json({ csv: "", filename, rowCount: 0 });

  const pages: OnPageRow[] = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshot.id },
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

  const rows = await buildRows(category, pages, { db, admin, shop });
  return json({ csv: toCsv(rows, COLUMNS), filename, rowCount: rows.length });
};

async function buildRows(
  category: Category,
  pages: OnPageRow[],
  ctx: { db: any; admin: any; shop: string },
): Promise<ExportRow[]> {
  const flat = (page: { url: string; title: string | null; resourceType: string | null; resourceId: string | null }, finding: string, detail = ""): ExportRow => ({
    url: page.url,
    finding,
    detail,
    title: page.title,
    resourceType: page.resourceType,
    resourceId: page.resourceId,
  });

  switch (category) {
    case "indexability": {
      const exclusions = await ctx.db.seoSitemapExclusion.findMany({
        where: { shop: ctx.shop, status: "applied" },
        select: { resourceType: true, resourceId: true },
      });
      const excluded = new Set<string>(
        exclusions.map((e: { resourceType: string; resourceId: string }) => `${e.resourceType}:${e.resourceId}`),
      );
      const report = analyzeIndexability(pages, excluded);
      // The export carries the EXPECTED ones too, tagged: the whole point of a
      // CSV is that the merchant can check our filtering rather than trust it.
      return [
        ...report.problems.map((f) => flat(f, "noindex_unexpected", f.localePrefixed ? "locale_prefixed" : "")),
        ...report.expected.map((f) => flat(f, "noindex_expected", f.expectedReason ?? "")),
        ...report.nofollowOnly.map((f) => flat(f, "nofollow_only", "")),
      ];
    }
    case "canonicals": {
      const { fetchPrimaryDomain } = await import("../utils/shop-domain.server");
      const primaryDomain = await fetchPrimaryDomain(ctx.admin, ctx.shop);
      return analyzeCanonicals(pages, primaryDomain, [ctx.shop]).map((f) => ({
        url: f.url,
        finding: `canonical_${f.issue}`,
        detail: f.target ?? "",
        title: null,
        resourceType: f.resourceType,
        resourceId: f.resourceId,
      }));
    }
    case "h1": {
      const report = analyzeHeadings(pages);
      return [
        ...report.missing.map((r) => flat(r, "h1_missing")),
        ...report.multiple.map((r) => flat(r, "h1_multiple", r.detail ?? "")),
        ...report.sameAsTitle.map((r) => flat(r, "h1_equals_title", r.detail ?? "")),
      ];
    }
    case "meta": {
      const { groupDuplicateValues, normalizeMetaDescription } = await import("../services/seo/crawl.service");
      const missing = findMissingMetaDescriptions(pages).map((r) => flat(r, "meta_description_missing"));
      const duplicates = groupDuplicateValues(
        pages
          .filter((p) => p.statusCode >= 200 && p.statusCode < 300)
          .map((p) => ({ url: p.url, value: p.metaDesc })),
        normalizeMetaDescription,
      ).flatMap((group) =>
        group.urls.map((u) => ({
          url: u,
          finding: "meta_description_duplicate",
          detail: group.title,
          title: null,
          resourceType: null,
          resourceId: null,
        })),
      );
      return [...missing, ...duplicates];
    }
    case "thin":
      return findThinPages(pages).pages.map((r) => ({
        url: r.url,
        finding: "thin_content",
        detail: `${r.wordCount} words (vs ${r.comparedType})`,
        title: r.title,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
      }));
    case "images":
      return findImagesWithoutAlt(pages).map((r) => flat(r, "images_without_alt", r.detail ?? ""));
    case "headDrift": {
      const { computeHeadDrift } = await import("../services/seo/crawl.service");
      const shopName = await fetchShopName(ctx.admin, ctx.shop);
      const candidates = pages
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
      const urlByResource = new Map(
        pages
          .filter((p) => p.resourceId && p.resourceType)
          .map((p) => [`${p.resourceType}:${p.resourceId}`, p.url]),
      );
      const drift = await computeHeadDrift(ctx.db, ctx.shop, candidates, shopName, Infinity);
      return drift.items.map((i) => ({
        url: urlByResource.get(`${i.type}:${i.id}`) || "",
        finding: "head_drift",
        detail: `html: ${i.crawledTitle} | stored: ${i.dbTitle}`,
        title: i.title,
        resourceType: i.type,
        resourceId: i.id,
      }));
    }
    case "duplicates": {
      const { groupDuplicateTitles } = await import("../services/seo/crawl.service");
      const shopName = await fetchShopName(ctx.admin, ctx.shop);
      return groupDuplicateTitles(
        pages
          .filter((p) => p.statusCode >= 200 && p.statusCode < 300)
          .map((p) => ({ url: p.url, title: p.title })),
        shopName,
      ).flatMap((group) =>
        group.urls.map((u) => ({
          url: u,
          finding: "duplicate_title",
          detail: group.title,
          title: null,
          resourceType: null,
          resourceId: null,
        })),
      );
    }
    default:
      return [];
  }
}

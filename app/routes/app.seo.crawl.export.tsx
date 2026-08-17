/**
 * Resource route: CSV export of one crawl-report category
 * (PLAN_SEO_CRAWL_EXPANSION §5).
 *
 * Loaded through `useFetcher().load()` and Blob-downloaded on the client, for
 * the same reason as `app.seo.redirects.export.tsx`: a top-level navigation
 * inside the embedded app lands on the App Bridge HTML shell instead of the
 * CSV body.
 *
 * §5.2 — THE GATE: a resource route is directly reachable by GET. The plan gate
 * on the crawl TAB does nothing for a merchant who guesses this URL, and
 * without the check here the export would hand a Free shop the full crawl the
 * tab only shows as a static example. Same class of hole as the /api/ai
 * handlers, which check their own plan for the same reason.
 *
 * No row cap on purpose: `UI_ROW_CAP` is a rendering limit, not a data limit,
 * and getting past it is exactly why a merchant exports. 2000 pages × a dozen
 * columns is well under a megabyte — nothing to stream.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { toCsv, csvFilename, type CsvColumn } from "../services/seo/csv-export";
import { classifyLinkStatus, isBotBlockStatus } from "../services/seo/crawl.service";
import { EXTERNAL_NOT_CHECKED } from "../services/seo/external-links.shared";
import { isAuditType } from "../services/seo/resource-types.shared";

const CATEGORIES = [
  "allPages",
  "broken",
  "serverErrors",
  "blocked",
  "orphans",
  "slowest",
  "external",
] as const;
type Category = (typeof CATEGORIES)[number];

interface ExportPage {
  url: string;
  title: string | null;
  statusCode: number;
  responseMs: number;
  redirectedTo: string | null;
  redirectHops: number;
  resourceType: string | null;
  resourceId: string | null;
  locale: string;
  inboundCount: number;
  outboundCount: number;
}

const PAGE_COLUMNS: CsvColumn<ExportPage>[] = [
  { header: "url", value: (p) => p.url },
  { header: "title", value: (p) => p.title },
  // -1 is the crawler's marker for a redirect loop, not an HTTP status.
  { header: "status", value: (p) => (p.statusCode === -1 ? "redirect_loop" : p.statusCode) },
  { header: "status_class", value: (p) => classifyLinkStatus(p.statusCode) },
  { header: "response_ms", value: (p) => p.responseMs },
  { header: "redirected_to", value: (p) => p.redirectedTo },
  { header: "redirect_hops", value: (p) => p.redirectHops },
  { header: "resource_type", value: (p) => p.resourceType },
  { header: "resource_id", value: (p) => p.resourceId },
  { header: "locale", value: (p) => p.locale },
  { header: "inbound_links", value: (p) => p.inboundCount },
  { header: "outbound_links", value: (p) => p.outboundCount },
];

interface ExportExternalLink {
  url: string;
  statusCode: number;
  finalUrl: string | null;
  sourceCount: number;
  sampleSources: string;
  anchor: string | null;
}

const EXTERNAL_COLUMNS: CsvColumn<ExportExternalLink>[] = [
  { header: "url", value: (r) => r.url },
  // -2/-1/0 are the crawler's sentinels, not HTTP statuses. They get the same
  // words the UI uses, or a CSV reader has to guess what "-2" means.
  {
    header: "status",
    value: (r) =>
      r.statusCode === EXTERNAL_NOT_CHECKED
        ? "not_checked"
        : r.statusCode === -1
          ? "redirect_loop"
          : r.statusCode === 0
            ? "unreachable"
            : r.statusCode,
  },
  { header: "final_url", value: (r) => r.finalUrl },
  { header: "linked_from_pages", value: (r) => r.sourceCount },
  // Newlines survive inside a quoted cell; the sample list stays one column.
  { header: "sample_sources", value: (r) => r.sampleSources },
  { header: "anchor", value: (r) => r.anchor },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ error: "plan_required" }, { status: 403 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("category") as Category | null;
  const category: Category = requested && CATEGORIES.includes(requested) ? requested : "allPages";

  const snapshot = await db.seoCrawlSnapshot.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true },
  });
  if (!snapshot) {
    return json({ csv: "", filename: csvFilename(`crawl-${category}`, shop), rowCount: 0 });
  }

  // §6.4 — external links have their own column set; nothing about a foreign
  // URL fits the crawled-page shape (no resource, no response time of ours).
  if (category === "external") {
    const rows = await db.seoCrawlExternalLink.findMany({
      where: { shop, snapshotId: snapshot.id },
      select: {
        url: true,
        statusCode: true,
        finalUrl: true,
        sourceCount: true,
        sampleSources: true,
        anchor: true,
      },
      orderBy: [{ statusCode: "asc" }, { sourceCount: "desc" }],
    });
    return json({
      csv: toCsv(rows, EXTERNAL_COLUMNS),
      filename: csvFilename("crawl-external", shop),
      rowCount: rows.length,
    });
  }

  const pages: ExportPage[] = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshot.id },
    select: {
      url: true,
      title: true,
      statusCode: true,
      responseMs: true,
      redirectedTo: true,
      redirectHops: true,
      resourceType: true,
      resourceId: true,
      locale: true,
      inboundCount: true,
      outboundCount: true,
    },
  });

  let rows: ExportPage[];
  switch (category) {
    case "broken":
      rows = pages.filter((p) => classifyLinkStatus(p.statusCode) === "broken");
      break;
    case "serverErrors":
      rows = pages.filter((p) => classifyLinkStatus(p.statusCode) === "server_error");
      break;
    case "blocked":
      rows = pages.filter((p) => isBotBlockStatus(p.statusCode));
      break;
    case "orphans":
      // Same rule as the tab: a capped crawl produces phantom orphans, so it
      // exports none rather than a list the merchant would act on.
      rows =
        snapshot.status === "capped"
          ? []
          : pages.filter(
              // Same narrowing as the tab and the persisted orphanCount.
              (p) => p.resourceId && isAuditType(p.resourceType) && p.inboundCount === 0,
            );
      break;
    case "slowest":
      rows = pages
        .filter((p) => classifyLinkStatus(p.statusCode) === "ok")
        .sort((a, b) => b.responseMs - a.responseMs);
      break;
    default:
      rows = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  }

  return json({
    csv: toCsv(rows, PAGE_COLUMNS),
    filename: csvFilename(`crawl-${category}`, shop),
    rowCount: rows.length,
  });
};

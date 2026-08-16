/**
 * Storefront crawler / site audit section (PLAN_SEO_SUITE_COMPLETION.md §3.4,
 * Phase 1) — Pro+.
 *
 * Reads the latest SeoCrawlSnapshot (any status — a "failed"/"capped" run is
 * still shown, with an explanatory banner) plus its SeoCrawlPage /
 * SeoCrawlBrokenLink rows. "Jetzt scannen" kicks off the detached "seoCrawl"
 * Task through the shared /api/ai route (same fire-and-forget + poll pattern
 * as the SEO dashboard's rescan and the JSON-LD batch check).
 *
 * Scope (PLAN_SEO_CRAWL_EXPANSION §0.1): this tab is DELIVERY HEALTH — is the
 * shop reachable, fast, unbroken. On-page quality (indexability, canonicals,
 * H1, meta, thin content, head drift, duplicate titles) lives in
 * `/app/seo/onpage`, which reads the SAME snapshot. Head drift and duplicate
 * titles moved there in §3.8, which also took two DB round-trips and one Admin
 * API call off this loader.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { CrawlSnapshotHeader } from "../components/seo/CrawlSnapshotHeader";
import {
  ReportGrid,
  ReportRow,
  CapNotice,
  Indent,
  EditAction,
  PageRowLine,
  CsvExportButton,
  PAGE_COLUMNS,
  STATUS_COLUMNS,
  ACTION_COLUMNS,
  type CrawledPageRow,
} from "../components/seo/crawl/ReportTable";
import { Tile } from "../components/seo/crawl/Tile";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import type { AuditType } from "../services/seo/audit.service";
import { isBotBlockStatus, classifyLinkStatus } from "../services/seo/crawl.service";
// Client-safe module on purpose: the component renders this threshold, and
// importing it from crawl.service would pull url-resolver.server into the
// client bundle and break the production build.
import { SLOW_PAGE_WARN_MS, type SnapshotHeaderView } from "../services/seo/crawl.shared";
import { BLOCK_SOURCE_TEXT_KEY } from "../utils/task-error-text";

const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

const UI_ROW_CAP = 100;

/** Broken-link EDGES are only used to explain *why* a broken page is reachable
 *  ("linked from …"), so the query needs more rows than the page list itself:
 *  one broken page can be linked from many others. */
const MAX_BROKEN_LINK_ROWS = 500;
/** Link sources rendered per broken page before the "+N more" summary. */
const MAX_SOURCES_PER_PAGE = 5;

/** The report's sections. Ids double as the `?tab=` deep-link values the SEO
 *  dashboard's problem buckets navigate with — keep them in sync with
 *  CRAWL_TAB_FOR_PROBLEM in app.seo._index.tsx. */
const CATEGORY_IDS = [
  "allPages",
  "okPages",
  "broken",
  "serverErrors",
  "blocked",
  "orphans",
  "slowest",
] as const;
type CategoryId = (typeof CATEGORY_IDS)[number];

/** Tab → the `?category=` the export route understands. "okPages" has no
 *  export of its own: "everything that answered fine" is the all-pages file
 *  minus a filter the merchant can apply in their spreadsheet. */
const EXPORT_CATEGORY: Record<CategoryId, string> = {
  allPages: "allPages",
  okPages: "allPages",
  broken: "broken",
  serverErrors: "serverErrors",
  blocked: "blocked",
  orphans: "orphans",
  slowest: "slowest",
};

/** The header half comes from the shared `SnapshotHeaderView`; this adds the
 *  counts only this tab's tiles render. */
interface SnapshotView extends SnapshotHeaderView {
  id: string;
  pagesOk: number;
  pagesBroken: number;
  /** Both derived from the crawl pages, not stored on the snapshot row. */
  pagesServerError: number;
  pagesBlocked: number;
  orphanCount: number;
}

interface BlockedRow {
  url: string;
  statusCode: number;
}

interface ServerErrorRow {
  url: string;
  statusCode: number;
  responseMs: number;
  resourceType: AuditType | null;
  resourceId: string | null;
}

interface BrokenLinkRow {
  fromUrl: string;
  toUrl: string;
  statusCode: number;
  anchor: string | null;
  fromResourceType: AuditType | null;
  fromResourceId: string | null;
}

/**
 * A page that answered 4xx (or ran into a redirect loop). This — not the link
 * edge list — is what the "broken" tile counts: a broken URL found only in the
 * sitemap has no inbound link edge, so an edge-only section showed "none found"
 * while the tile reported a non-zero count.
 */
interface BrokenPageRow {
  url: string;
  statusCode: number;
  resourceType: AuditType | null;
  resourceId: string | null;
  /** Internal pages linking here — capped at MAX_SOURCES_PER_PAGE. */
  sources: {
    fromUrl: string;
    anchor: string | null;
    fromResourceType: AuditType | null;
    fromResourceId: string | null;
  }[];
  /** Total inbound broken-link edges found, so the UI can say "+N more". */
  sourceTotal: number;
}

interface OrphanRow {
  url: string;
  title: string | null;
  resourceType: AuditType;
  resourceId: string;
}

interface SlowRow {
  url: string;
  responseMs: number;
  statusCode: number;
}

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return (settings?.subscriptionPlan || "free") as Plan;
}

// Static, non-shop-specific example shown to Free/Basic merchants alongside
// the upgrade card (§3.7) — never touches the DB.
const EXAMPLE_SNAPSHOT: SnapshotView = {
  id: "example",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: "completed",
  errorCode: null,
  blockedBy: null,
  pagesCrawled: 412,
  totalDiscovered: 412,
  pagesOk: 398,
  pagesBroken: 6,
  pagesServerError: 0,
  pagesBlocked: 0,
  orphanCount: 3,
};

/** Every list the report renders, empty — used by the gated and never-scanned
 *  responses so a new section can't be forgotten in one of them. */
const EMPTY_LISTS = {
  allPages: [] as CrawledPageRow[],
  okPages: [] as CrawledPageRow[],
  brokenPages: [] as BrokenPageRow[],
  brokenLinks: [] as BrokenLinkRow[],
  serverErrors: [] as ServerErrorRow[],
  blocked: [] as BlockedRow[],
  orphans: [] as OrphanRow[],
  slowest: [] as SlowRow[],
  /** Row counts before the UI_ROW_CAP slice, for the "showing N of M" hint. */
  totals: { allPages: 0, okPages: 0, brokenPages: 0 },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({
      gated: true,
      running: false,
      snapshot: EXAMPLE_SNAPSHOT,
      ...EMPTY_LISTS,
    });
  }

  // §0.3 — the shared "latest crawl" read, so this tab and /app/seo/onpage can
  // never disagree about which run they are showing or whether one is running.
  const { loadLatestSnapshot } = await import("../services/seo/crawl-snapshot.server");
  const latest = await loadLatestSnapshot(db, shop);
  const snapshotRow = latest.row;

  if (!snapshotRow) {
    return json({
      gated: false,
      running: latest.running,
      snapshot: null,
      ...EMPTY_LISTS,
    });
  }

  const pages = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshotRow.id },
    select: {
      url: true,
      title: true,
      statusCode: true,
      responseMs: true,
      resourceType: true,
      resourceId: true,
      locale: true,
      inboundCount: true,
      redirectHops: true,
    },
  });
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));

  // ok/broken/blocked are recomputed from the persisted pages rather than read
  // off the snapshot row, so snapshots written before 403/429 got their own
  // bucket stop reporting firewall blocks as broken.
  const blocked: BlockedRow[] = pages
    .filter((p) => isBotBlockStatus(p.statusCode))
    .slice(0, UI_ROW_CAP)
    .map((p) => ({ url: p.url, statusCode: p.statusCode }));
  const blockedTotal = pages.filter((p) => isBotBlockStatus(p.statusCode)).length;
  const brokenPagesAll = pages.filter((p) => classifyLinkStatus(p.statusCode) === "broken");
  const okPagesAll = pages.filter((p) => classifyLinkStatus(p.statusCode) === "ok");
  const brokenTotal = brokenPagesAll.length;
  const okTotal = okPagesAll.length;

  const toPageRow = (p: (typeof pages)[number]): CrawledPageRow => ({
    url: p.url,
    title: p.title,
    statusCode: p.statusCode,
    statusClass: classifyLinkStatus(p.statusCode),
    responseMs: p.responseMs,
    resourceType: p.resourceType && p.resourceType !== "unknown" ? (p.resourceType as AuditType) : null,
    resourceId: p.resourceId ?? null,
    // §4.4 — chains the crawler OBSERVED, including ones no merchant redirect
    // explains (theme/app/locale). A badge in the existing table, not a tab:
    // there is no fix to offer here, only a fact.
    redirectHops: p.redirectHops,
  });
  const byUrl = (a: { url: string }, b: { url: string }) => a.url.localeCompare(b.url);

  const allPages: CrawledPageRow[] = [...pages].sort(byUrl).slice(0, UI_ROW_CAP).map(toPageRow);
  const okPages: CrawledPageRow[] = [...okPagesAll].sort(byUrl).slice(0, UI_ROW_CAP).map(toPageRow);

  // Server errors are page-level, NOT edge-level: a 500 means this page of the
  // shop failed, whether or not anything links to it. Reading them off the
  // crawled pages also surfaces the sitemap-only ones, which the broken-link
  // rows (built from link edges) can never show.
  const serverErrorPages = pages.filter((p) => classifyLinkStatus(p.statusCode) === "server_error");
  const serverErrors: ServerErrorRow[] = serverErrorPages.slice(0, UI_ROW_CAP).map((p) => ({
    url: p.url,
    statusCode: p.statusCode,
    responseMs: p.responseMs,
    resourceType: p.resourceType && p.resourceType !== "unknown" ? (p.resourceType as AuditType) : null,
    resourceId: p.resourceId ?? null,
  }));

  const snapshot: SnapshotView = {
    id: snapshotRow.id,
    startedAt: snapshotRow.startedAt.toISOString(),
    finishedAt: snapshotRow.finishedAt ? snapshotRow.finishedAt.toISOString() : null,
    status: snapshotRow.status,
    errorCode: latest.errorCode,
    blockedBy: latest.blockedBy,
    pagesCrawled: snapshotRow.pagesCrawled,
    totalDiscovered: snapshotRow.totalDiscovered,
    pagesOk: pages.length > 0 ? okTotal : snapshotRow.pagesOk,
    pagesBroken: pages.length > 0 ? brokenTotal : snapshotRow.pagesBroken,
    pagesServerError: serverErrorPages.length,
    pagesBlocked: blockedTotal,
    orphanCount: snapshotRow.orphanCount,
  };

  const brokenLinkRows = await db.seoCrawlBrokenLink.findMany({
    // Only genuine 4xx link faults. 403/429 (firewall) and 5xx/timeout (the
    // target page failed, not the link) have their own sections; rows for them
    // only exist in snapshots written before those splits.
    where: { shop, snapshotId: snapshotRow.id, statusCode: { notIn: [403, 429, 0], lt: 500 } },
    select: { fromUrl: true, toUrl: true, statusCode: true, anchor: true },
    take: MAX_BROKEN_LINK_ROWS,
  });
  // Edges whose target page row is missing — the page list can't show those, so
  // they are rendered on their own below the broken pages. Normally empty: the
  // crawler only writes an edge for a page it fetched.
  const brokenPageUrls = new Set(brokenPagesAll.map((p) => p.url));
  const brokenLinks: BrokenLinkRow[] = brokenLinkRows
    .filter((bl) => !brokenPageUrls.has(bl.toUrl))
    .slice(0, UI_ROW_CAP)
    .map((bl) => {
      const from = pageByUrl.get(bl.fromUrl);
      return {
        fromUrl: bl.fromUrl,
        toUrl: bl.toUrl,
        statusCode: bl.statusCode,
        anchor: bl.anchor,
        fromResourceType:
          from?.resourceType && from.resourceType !== "unknown" ? (from.resourceType as AuditType) : null,
        fromResourceId: from?.resourceId ?? null,
      };
    });

  // Attach the inbound link edges to their target page, so a broken page can
  // say who links to it — and stays listed when nobody does.
  const sourcesByTarget = new Map<string, BrokenPageRow["sources"]>();
  for (const bl of brokenLinkRows) {
    const from = pageByUrl.get(bl.fromUrl);
    const source = {
      fromUrl: bl.fromUrl,
      anchor: bl.anchor,
      fromResourceType:
        from?.resourceType && from.resourceType !== "unknown" ? (from.resourceType as AuditType) : null,
      fromResourceId: from?.resourceId ?? null,
    };
    const list = sourcesByTarget.get(bl.toUrl);
    if (list) list.push(source);
    else sourcesByTarget.set(bl.toUrl, [source]);
  }
  const brokenPages: BrokenPageRow[] = [...brokenPagesAll]
    .sort(byUrl)
    .slice(0, UI_ROW_CAP)
    .map((p) => {
      const sources = sourcesByTarget.get(p.url) ?? [];
      return {
        url: p.url,
        statusCode: p.statusCode,
        resourceType: p.resourceType && p.resourceType !== "unknown" ? (p.resourceType as AuditType) : null,
        resourceId: p.resourceId ?? null,
        sources: sources.slice(0, MAX_SOURCES_PER_PAGE),
        sourceTotal: sources.length,
      };
    });

  const orphans: OrphanRow[] =
    snapshotRow.status === "capped"
      ? []
      : pages
          .filter((p) => p.resourceId && p.resourceType && p.resourceType !== "unknown" && p.inboundCount === 0)
          .slice(0, UI_ROW_CAP)
          .map((p) => ({
            url: p.url,
            title: p.title,
            resourceType: p.resourceType as AuditType,
            resourceId: p.resourceId as string,
          }));

  // Head drift and duplicate titles used to be computed here. They moved to
  // /app/seo/onpage (§3.8) — with them went two DB round-trips (computeHeadDrift
  // batches a findMany per resource type) and the shop-name Admin API call, so
  // this loader is now measurably lighter, not just shorter.

  // Only pages that actually served content. A timeout records responseMs =
  // REQUEST_TIMEOUT_MS (10s), so failures would otherwise occupy the top of
  // the "slowest pages" list and trip its warning banner — while already being
  // reported, correctly, under server errors.
  const slowest: SlowRow[] = pages
    .filter((p) => classifyLinkStatus(p.statusCode) === "ok")
    .sort((a, b) => b.responseMs - a.responseMs)
    .slice(0, 20)
    .map((p) => ({ url: p.url, responseMs: p.responseMs, statusCode: p.statusCode }));

  return json({
    gated: false,
    running: latest.running,
    snapshot,
    allPages,
    okPages,
    brokenPages,
    brokenLinks,
    serverErrors,
    blocked,
    orphans,
    slowest,
    totals: { allPages: pages.length, okPages: okTotal, brokenPages: brokenTotal },
  });
};

export default function SeoCrawl() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const c = (t.seo as any).crawlPage as Record<string, string>;

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };
  const createRedirect = (toUrl: string) => {
    let path = toUrl;
    try {
      path = new URL(toUrl).pathname;
    } catch {
      /* keep raw value */
    }
    handleNavigate("/app/seo/redirects", { searchParams: new URLSearchParams({ newFrom: path }) });
  };

  // The tiles ARE the navigation — clicking one opens its section below, so a
  // separate tab bar would only repeat the same labels and counts.
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("tab") as CategoryId | null;
  // Defaults to the first tile — the overview — not to a problem bucket. A
  // `?tab=` deep link from the SEO dashboard still wins.
  const [activeTab, setActiveTab] = useState<CategoryId>(
    requested && CATEGORY_IDS.includes(requested) ? requested : "allPages",
  );

  // Section heading, since there is no tab bar left to say what is shown.
  const CATEGORY_LABEL: Record<CategoryId, string> = {
    allPages: c.tabAllPages,
    okPages: c.tabOkPages,
    broken: c.tabBrokenLinks,
    serverErrors: c.tabServerErrors,
    blocked: c.tabBlocked,
    orphans: c.tabOrphans,
    slowest: c.tabSlowest,
  };

  const snapshot = data.snapshot;
  const isCapped = snapshot?.status === "capped";

  const blockSourceText = snapshot?.blockedBy ? c[BLOCK_SOURCE_TEXT_KEY[snapshot.blockedBy]] : null;

  const body = (
    <BlockStack gap="400">
      <Banner tone="info" title={c.introTitle}>
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
      </Banner>

      {/* §3.8 — head drift and duplicate titles are one tab over now. A
          pointer, not a redirect: /app/seo/crawl stays a valid, useful URL. */}
      <Banner tone="info">
        <InlineStack gap="100" blockAlign="center" wrap>
          <Text as="span" variant="bodyMd">{c.movedToOnPage}</Text>
          <Button variant="plain" onClick={() => handleNavigate("/app/seo/onpage")}>
            {c.movedToOnPageLink}
          </Button>
        </InlineStack>
      </Banner>

      <CrawlSnapshotHeader snapshot={snapshot} running={data.running} gated={data.gated}>
        {snapshot && snapshot.pagesBlocked > 0 && !data.running && (
          <Banner tone="warning">{c.blockedBanner.replace("{count}", String(snapshot.pagesBlocked))}</Banner>
        )}

        {snapshot && (
          <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 5 }} gap="300">
              <Tile
                label={c.tilePages}
                value={snapshot.pagesCrawled}
                onClick={() => setActiveTab("allPages")}
                selected={activeTab === "allPages"}
              />
              <Tile
                label={c.tileOk}
                value={snapshot.pagesOk}
                onClick={() => setActiveTab("okPages")}
                selected={activeTab === "okPages"}
              />
              <Tile
                label={c.tileBroken}
                value={snapshot.pagesBroken}
                onClick={() => setActiveTab("broken")}
                selected={activeTab === "broken"}
              />
              <Tile
                label={c.tileServerErrors}
                value={snapshot.pagesServerError}
                // Short form here — the full explanation is the section banner.
                hint={snapshot.pagesServerError > 0 ? c.tileServerErrorsHint : undefined}
                onClick={() => setActiveTab("serverErrors")}
                selected={activeTab === "serverErrors"}
              />
              <Tile
                label={c.tileBlocked}
                value={snapshot.pagesBlocked}
                hint={snapshot.pagesBlocked > 0 ? c.blockedHint : undefined}
                onClick={() => setActiveTab("blocked")}
                selected={activeTab === "blocked"}
              />
              <Tile
                label={c.tileOrphans}
                value={isCapped ? "—" : snapshot.orphanCount}
                hint={isCapped ? c.orphanCappedHint : undefined}
                onClick={() => setActiveTab("orphans")}
                selected={activeTab === "orphans"}
              />
              <Tile
                label={c.tileSlowest}
                value={data.slowest.length}
                onClick={() => setActiveTab("slowest")}
                selected={activeTab === "slowest"}
              />
          </InlineGrid>
        )}
      </CrawlSnapshotHeader>

      {snapshot && (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Text as="h3" variant="headingMd">{CATEGORY_LABEL[activeTab]}</Text>
              {/* Exports the FULL category, not the UI_ROW_CAP slice — getting
                  past that cap is the reason to export at all (§5.3). */}
              <CsvExportButton
                path="/app/seo/crawl/export"
                category={EXPORT_CATEGORY[activeTab]}
                label={c.exportCsv}
                emptyLabel={c.exportCsvEmpty}
              />
            </InlineStack>

            {activeTab === "allPages" && (
              <BlockStack gap="200">
                {data.allPages.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyAllPages}</Text>
                ) : (
                  <>
                    <CapNotice shown={data.allPages.length} total={data.totals.allPages} template={c.rowCapHint} />
                    <ReportGrid columns={PAGE_COLUMNS}>
                      {data.allPages.map((p) => (
                        <PageRowLine
                          key={p.url}
                          page={p}
                          openLabel={c.openInEditor}
                          onOpen={openInEditor}
                          redirectLoopLabel={c.statusRedirectLoop}
                          hopsLabel={c.redirectHopsBadge}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "okPages" && (
              <BlockStack gap="200">
                {data.okPages.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyOkPages}</Text>
                ) : (
                  <>
                    <Text as="p" variant="bodySm" tone="subdued">{c.okPagesHint}</Text>
                    <CapNotice shown={data.okPages.length} total={data.totals.okPages} template={c.rowCapHint} />
                    <ReportGrid columns={PAGE_COLUMNS}>
                      {data.okPages.map((p) => (
                        <PageRowLine
                          key={p.url}
                          page={p}
                          openLabel={c.openInEditor}
                          onOpen={openInEditor}
                          redirectLoopLabel={c.statusRedirectLoop}
                          hopsLabel={c.redirectHopsBadge}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "broken" && (
              <BlockStack gap="200">
                {data.brokenPages.length === 0 && data.brokenLinks.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyBrokenLinks}</Text>
                ) : (
                  <>
                    <Banner tone="critical">{c.brokenPagesHint}</Banner>
                    <CapNotice
                      shown={data.brokenPages.length}
                      total={data.totals.brokenPages}
                      template={c.rowCapHint}
                    />
                    <ReportGrid columns={STATUS_COLUMNS}>
                      {data.brokenPages.map((p, pageIndex) => [
                        <ReportRow
                          key={p.url}
                          spacedAbove={pageIndex > 0}
                          cells={[
                            <Text as="span" variant="bodySm">{p.url}</Text>,
                            <Badge tone="critical">
                              {/* -1 is the crawler's marker for a redirect loop, not an HTTP status. */}
                              {p.statusCode === -1 ? c.statusRedirectLoop : String(p.statusCode)}
                            </Badge>,
                            <Button size="slim" variant="plain" onClick={() => createRedirect(p.url)}>
                              {c.createRedirect}
                            </Button>,
                          ]}
                        />,
                        // The link sources are rows of the same grid, so their
                        // editor icons line up with the actions above them.
                        p.sourceTotal === 0 ? (
                          <ReportRow
                            key={`${p.url}:nosource`}
                            cells={[
                              <Indent>
                                <Text as="span" variant="bodySm" tone="subdued">{c.brokenNoSource}</Text>
                              </Indent>,
                              null,
                              null,
                            ]}
                          />
                        ) : null,
                        ...p.sources.map((s, i) => (
                          <ReportRow
                            key={`${p.url}:${s.fromUrl}:${i}`}
                            cells={[
                              <Indent>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {c.brokenLinkedFrom}: {s.fromUrl}
                                  {s.anchor ? ` · ${c.colAnchor}: ${s.anchor}` : ""}
                                </Text>
                              </Indent>,
                              null,
                              s.fromResourceType && s.fromResourceId ? (
                                <EditAction
                                  label={c.openInEditor}
                                  onClick={() =>
                                    openInEditor(s.fromResourceType as AuditType, s.fromResourceId as string)
                                  }
                                />
                              ) : null,
                            ]}
                          />
                        )),
                        p.sourceTotal > p.sources.length ? (
                          <ReportRow
                            key={`${p.url}:more`}
                            cells={[
                              <Indent>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {c.moreSources.replace("{count}", String(p.sourceTotal - p.sources.length))}
                                </Text>
                              </Indent>,
                              null,
                              null,
                            ]}
                          />
                        ) : null,
                      ])}
                      {/* Only edges whose target page row is missing — everything
                          else is already listed above, with its sources. */}
                      {data.brokenLinks.map((bl, i) => (
                        <ReportRow
                          key={`edge:${i}`}
                          cells={[
                            <BlockStack gap="050">
                              <Text as="span" variant="bodySm" tone="subdued">{c.colFrom}: {bl.fromUrl}</Text>
                              <Text as="span" variant="bodySm">{c.colTo}: {bl.toUrl}</Text>
                              {bl.anchor && (
                                <Text as="span" variant="bodySm" tone="subdued">{c.colAnchor}: {bl.anchor}</Text>
                              )}
                            </BlockStack>,
                            <Badge tone="critical">
                              {bl.statusCode === -1 ? c.statusRedirectLoop : String(bl.statusCode)}
                            </Badge>,
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              {bl.fromResourceType && bl.fromResourceId && (
                                <EditAction
                                  label={c.openInEditor}
                                  onClick={() =>
                                    openInEditor(bl.fromResourceType as AuditType, bl.fromResourceId as string)
                                  }
                                />
                              )}
                              <Button size="slim" variant="plain" onClick={() => createRedirect(bl.toUrl)}>
                                {c.createRedirect}
                              </Button>
                            </InlineStack>,
                          ]}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "serverErrors" && (
              <BlockStack gap="200">
                {data.serverErrors.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyServerErrors}</Text>
                ) : (
                  <>
                    <Banner tone="critical">{c.serverErrorsHint}</Banner>
                    <ReportGrid columns={ACTION_COLUMNS}>
                      {data.serverErrors.map((e) => (
                        <ReportRow
                          key={e.url}
                          cells={[
                            <BlockStack gap="050">
                              <Text as="span" variant="bodySm">{e.url}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {e.statusCode === 0
                                  ? c.serverErrorTimeout
                                  : c.serverErrorStatus.replace("{status}", String(e.statusCode))}
                                {e.responseMs > 0 ? ` · ${e.responseMs} ms` : ""}
                              </Text>
                            </BlockStack>,
                            e.resourceType && e.resourceId ? (
                              <EditAction
                                label={c.openInEditor}
                                onClick={() => openInEditor(e.resourceType as AuditType, e.resourceId as string)}
                              />
                            ) : null,
                          ]}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "orphans" && (
              <BlockStack gap="200">
                {isCapped ? (
                  <Banner tone="warning">{c.orphanCappedHint}</Banner>
                ) : data.orphans.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyOrphans}</Text>
                ) : (
                  <ReportGrid columns={ACTION_COLUMNS}>
                    {data.orphans.map((o) => (
                      <ReportRow
                        key={o.url}
                        cells={[
                          <Text as="span" variant="bodySm">{o.title || o.url}</Text>,
                          <EditAction
                            label={c.openInEditor}
                            onClick={() => openInEditor(o.resourceType, o.resourceId)}
                          />,
                        ]}
                      />
                    ))}
                  </ReportGrid>
                )}
              </BlockStack>
            )}

            {activeTab === "slowest" && (
              <BlockStack gap="200">
                {data.slowest.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptySlowest}</Text>
                ) : (
                  <>
                    <Text as="p" variant="bodySm" tone="subdued">{c.performanceHint}</Text>
                    {data.slowest.some((s) => s.responseMs >= SLOW_PAGE_WARN_MS) && (
                      <Banner tone="warning">
                        {c.slowPageWarning.replace("{threshold}", String(SLOW_PAGE_WARN_MS))}
                      </Banner>
                    )}
                    <ReportGrid columns={ACTION_COLUMNS}>
                      {data.slowest.map((s) => (
                        <ReportRow
                          key={s.url}
                          cells={[
                            <Text as="span" variant="bodySm">{s.url}</Text>,
                            <Badge tone={s.responseMs >= SLOW_PAGE_WARN_MS ? "warning" : undefined}>
                              {`${s.responseMs} ms`}
                            </Badge>,
                          ]}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "blocked" && (
              <BlockStack gap="200">
                {data.blocked.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyBlocked}</Text>
                ) : (
                  <>
                    <Text as="p" variant="bodySm" tone="subdued">{c.blockedHint}</Text>
                    {blockSourceText && (
                      <Text as="p" variant="bodySm" fontWeight="semibold">{blockSourceText}</Text>
                    )}
                    <ReportGrid columns={ACTION_COLUMNS}>
                      {data.blocked.map((b) => (
                        <ReportRow
                          key={b.url}
                          cells={[
                            <Text as="span" variant="bodySm">{b.url}</Text>,
                            <Badge tone="warning">{String(b.statusCode)}</Badge>,
                          ]}
                        />
                      ))}
                    </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );

  if (data.gated) {
    return (
      <SeoSectionLayout
        sectionId="crawl"
        lockedExtra={
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{c.upgradeExampleTitle}</Text>
              <InlineGrid columns={{ xs: 2, sm: 3, md: 6 }} gap="300">
                <Tile label={c.tilePages} value={EXAMPLE_SNAPSHOT.pagesCrawled} />
                <Tile label={c.tileOk} value={EXAMPLE_SNAPSHOT.pagesOk} />
                <Tile label={c.tileBroken} value={EXAMPLE_SNAPSHOT.pagesBroken} />
                <Tile label={c.tileOrphans} value={EXAMPLE_SNAPSHOT.orphanCount} />
                <Tile label={c.tileServerErrors} value={EXAMPLE_SNAPSHOT.pagesServerError} />
                <Tile label={c.tileSlowest} value={4} />
              </InlineGrid>
            </BlockStack>
          </Card>
        }
      >
        {null}
      </SeoSectionLayout>
    );
  }

  return <SeoSectionLayout sectionId="crawl">{body}</SeoSectionLayout>;
}

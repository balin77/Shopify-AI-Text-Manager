/**
 * Storefront crawler / site audit section (PLAN_SEO_SUITE_COMPLETION.md §3.4,
 * Phase 1) — Pro+.
 *
 * Reads the latest SeoCrawlSnapshot (any status — a "failed"/"capped" run is
 * still shown, with an explanatory banner) plus its SeoCrawlPage /
 * SeoCrawlBrokenLink rows. "Jetzt scannen" kicks off the detached "seoCrawl"
 * Task through the shared /api/ai route (same fire-and-forget + poll pattern
 * as the SEO dashboard's rescan and the JSON-LD batch check).
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Banner,
  Tooltip,
} from "@shopify/polaris";
import { EditIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import type { AuditType } from "../services/seo/audit.service";
import {
  computeHeadDrift,
  groupDuplicateTitles,
  isBotBlockStatus,
  classifyLinkStatus,
  parseCrawlError,
  type LinkStatusClass,
} from "../services/seo/crawl.service";
// Client-safe module on purpose: the component renders this threshold, and
// importing it from crawl.service would pull url-resolver.server into the
// client bundle and break the production build.
import { SLOW_PAGE_WARN_MS } from "../services/seo/crawl.shared";
import type { BlockSource } from "../services/seo/crawl.service";
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
  "headDrift",
  "slowest",
  "duplicates",
] as const;
type CategoryId = (typeof CATEGORY_IDS)[number];

interface SnapshotView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
  /** `error` without the `:<blockedBy>` suffix — see `parseCrawlError`. */
  errorCode: string | null;
  /** Who refused the crawler, when the run aborted on a bot block. */
  blockedBy: BlockSource | null;
  pagesCrawled: number;
  totalDiscovered: number;
  pagesOk: number;
  pagesBroken: number;
  /** Both derived from the crawl pages, not stored on the snapshot row. */
  pagesServerError: number;
  pagesBlocked: number;
  orphanCount: number;
  headDriftCount: number;
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

/** A page the crawler actually fetched — backs the "all pages" and "OK pages"
 *  sections behind the two total tiles. */
interface CrawledPageRow {
  url: string;
  title: string | null;
  statusCode: number;
  /** Classified server-side — see the note in `PageRowLine`. */
  statusClass: LinkStatusClass;
  responseMs: number;
  resourceType: AuditType | null;
  resourceId: string | null;
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

interface HeadDriftRow {
  url: string;
  resourceType: AuditType;
  resourceId: string;
  title: string;
  crawledTitle: string;
  dbTitle: string;
}

interface SlowRow {
  url: string;
  responseMs: number;
  statusCode: number;
}

interface DuplicateGroupRow {
  title: string;
  urls: string[];
}

const SHOP_NAME_QUERY = `#graphql
  query seoCrawlPageShopName {
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
  error: null,
  errorCode: null,
  blockedBy: null,
  pagesCrawled: 412,
  totalDiscovered: 412,
  pagesOk: 398,
  pagesBroken: 6,
  pagesServerError: 0,
  pagesBlocked: 0,
  orphanCount: 3,
  headDriftCount: 5,
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
  headDrift: [] as HeadDriftRow[],
  slowest: [] as SlowRow[],
  duplicates: [] as DuplicateGroupRow[],
  /** Row counts before the UI_ROW_CAP slice, for the "showing N of M" hint. */
  totals: { allPages: 0, okPages: 0, brokenPages: 0 },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
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

  const [snapshotRow, runningTask] = await Promise.all([
    db.seoCrawlSnapshot.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } }),
    db.task.findFirst({ where: { shop, type: "seoCrawl", status: "running" }, select: { id: true } }),
  ]);

  if (!snapshotRow) {
    return json({
      gated: false,
      running: !!runningTask,
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

  const parsedError = parseCrawlError(snapshotRow.error);

  const snapshot: SnapshotView = {
    id: snapshotRow.id,
    startedAt: snapshotRow.startedAt.toISOString(),
    finishedAt: snapshotRow.finishedAt ? snapshotRow.finishedAt.toISOString() : null,
    status: snapshotRow.status,
    error: snapshotRow.error,
    errorCode: parsedError.code,
    blockedBy: parsedError.blockedBy,
    pagesCrawled: snapshotRow.pagesCrawled,
    totalDiscovered: snapshotRow.totalDiscovered,
    pagesOk: pages.length > 0 ? okTotal : snapshotRow.pagesOk,
    pagesBroken: pages.length > 0 ? brokenTotal : snapshotRow.pagesBroken,
    pagesServerError: serverErrorPages.length,
    pagesBlocked: blockedTotal,
    orphanCount: snapshotRow.orphanCount,
    headDriftCount: snapshotRow.headDriftCount,
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

  const shopName = await fetchShopName(admin, shop);
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
  const headDriftResult = await computeHeadDrift(db, shop, headDriftCandidates, shopName, UI_ROW_CAP);
  const headDrift: HeadDriftRow[] = headDriftResult.items.map((i) => {
    const page = Array.from(pageByUrl.values()).find(
      (p) => p.resourceId === i.id && p.resourceType === i.type,
    );
    return {
      url: page?.url || "",
      resourceType: i.type,
      resourceId: i.id,
      title: i.title,
      crawledTitle: i.crawledTitle,
      dbTitle: i.dbTitle,
    };
  });

  // Only pages that actually served content. A timeout records responseMs =
  // REQUEST_TIMEOUT_MS (10s), so failures would otherwise occupy the top of
  // the "slowest pages" list and trip its warning banner — while already being
  // reported, correctly, under server errors.
  const slowest: SlowRow[] = pages
    .filter((p) => classifyLinkStatus(p.statusCode) === "ok")
    .sort((a, b) => b.responseMs - a.responseMs)
    .slice(0, 20)
    .map((p) => ({ url: p.url, responseMs: p.responseMs, statusCode: p.statusCode }));

  const duplicates: DuplicateGroupRow[] = groupDuplicateTitles(
    pages.map((p) => ({ url: p.url, title: p.title })),
    shopName,
  ).slice(0, UI_ROW_CAP);

  return json({
    gated: false,
    running: !!runningTask,
    snapshot,
    allPages,
    okPages,
    brokenPages,
    brokenLinks,
    serverErrors,
    blocked,
    orphans,
    headDrift,
    slowest,
    duplicates,
    totals: { allPages: pages.length, okPages: okTotal, brokenPages: brokenTotal },
  });
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function SeoCrawl() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const c = (t.seo as any).crawlPage as Record<string, string>;

  const scanFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const [scanStarted, setScanStarted] = useState(false);
  const [scanBanner, setScanBanner] = useState<{ tone: "critical"; message: string } | null>(null);
  const scanStartedAtRef = useRef(0);

  useEffect(() => {
    if (scanFetcher.state !== "idle" || !scanFetcher.data) return;
    if (scanFetcher.data.success) {
      scanStartedAtRef.current = Date.now();
      setScanStarted(true);
    } else {
      setScanBanner({ tone: "critical", message: scanFetcher.data.error || c.scanStartError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.state, scanFetcher.data]);

  const scanInProgress = data.running || scanStarted;

  const handleScanNow = () => {
    if (data.gated || scanInProgress || scanFetcher.state !== "idle") return;
    setScanBanner(null);
    const formData = new FormData();
    formData.append("action", "seoCrawl");
    formData.append("contentType", "products");
    scanFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!scanInProgress) return;
    const interval = setInterval(() => revalidatorRef.current.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [scanInProgress]);
  useEffect(() => {
    if (!scanStarted || data.running) return;
    if (Date.now() - scanStartedAtRef.current > 5000) setScanStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.running, scanStarted]);

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
    headDrift: c.tabHeadDrift,
    slowest: c.tabSlowest,
    duplicates: c.tabDuplicates,
  };

  const snapshot = data.snapshot;
  const isCapped = snapshot?.status === "capped";

  const blockSourceText = snapshot?.blockedBy ? c[BLOCK_SOURCE_TEXT_KEY[snapshot.blockedBy]] : null;

  const body = (
    <BlockStack gap="400">
      <Banner tone="info" title={c.introTitle}>
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
      </Banner>

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              {snapshot
                ? c.lastScanned.replace("{time}", formatDate(snapshot.finishedAt || snapshot.startedAt))
                : c.neverScanned}
            </Text>
            <Button
              variant="primary"
              onClick={handleScanNow}
              disabled={data.gated || scanInProgress || scanFetcher.state !== "idle"}
              loading={scanFetcher.state !== "idle"}
            >
              {c.scanNow}
            </Button>
          </InlineStack>

          {scanBanner && (
            <Banner tone={scanBanner.tone} onDismiss={() => setScanBanner(null)}>
              {scanBanner.message}
            </Banner>
          )}
          {!scanBanner && scanInProgress && (
            <Banner tone="info">
              {snapshot && snapshot.totalDiscovered > 0
                ? c.pagesProgress
                    .replace("{crawled}", String(snapshot.pagesCrawled))
                    .replace("{discovered}", String(snapshot.totalDiscovered))
                : c.scanning}
            </Banner>
          )}

          {snapshot?.status === "failed" && !scanInProgress && (
            <Banner tone="critical">
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd">
                  {snapshot.errorCode === "storefront_password"
                    ? c.errorStorefrontPassword
                    : snapshot.errorCode === "bot_blocked"
                      ? c.errorBotBlocked
                      : c.errorGeneric}
                </Text>
                {snapshot.errorCode === "bot_blocked" && blockSourceText && (
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{blockSourceText}</Text>
                )}
              </BlockStack>
            </Banner>
          )}
          {isCapped && !scanInProgress && (
            <Banner tone="warning">
              {c.cappedBanner
                .replace("{cap}", String(snapshot!.pagesCrawled))
                .replace("{discovered}", String(snapshot!.totalDiscovered))}
            </Banner>
          )}

          {snapshot && snapshot.pagesBlocked > 0 && !scanInProgress && (
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
                label={c.tileHeadDrift}
                value={snapshot.headDriftCount}
                onClick={() => setActiveTab("headDrift")}
                selected={activeTab === "headDrift"}
              />
              <Tile
                label={c.tileSlowest}
                value={data.slowest.length}
                onClick={() => setActiveTab("slowest")}
                selected={activeTab === "slowest"}
              />
              <Tile
                label={c.tileDuplicates}
                value={data.duplicates.length}
                onClick={() => setActiveTab("duplicates")}
                selected={activeTab === "duplicates"}
              />
            </InlineGrid>
          )}
        </BlockStack>
      </Card>

      {snapshot && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{CATEGORY_LABEL[activeTab]}</Text>

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

            {activeTab === "headDrift" && (
              <BlockStack gap="200">
                {data.headDrift.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyHeadDrift}</Text>
                ) : (
                  <ReportGrid columns={ACTION_COLUMNS}>
                    {data.headDrift.map((h) => (
                      <ReportRow
                        key={`${h.resourceType}:${h.resourceId}`}
                        cells={[
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm" tone="subdued">{c.colCrawledTitle}: {h.crawledTitle || "—"}</Text>
                            <Text as="span" variant="bodySm">{c.colDbTitle}: {h.dbTitle || "—"}</Text>
                          </BlockStack>,
                          <EditAction
                            label={c.openInEditor}
                            onClick={() => openInEditor(h.resourceType, h.resourceId)}
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

            {activeTab === "duplicates" && (
              <BlockStack gap="200">
                {data.duplicates.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyDuplicates}</Text>
                ) : (
                  data.duplicates.map((d) => (
                    <BlockStack key={d.title} gap="100">
                      <Text as="span" variant="bodySm" fontWeight="semibold">{d.title}</Text>
                      {d.urls.map((u) => (
                        <Text as="span" variant="bodySm" tone="subdued" key={u}>{u}</Text>
                      ))}
                    </BlockStack>
                  ))
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
                <Tile label={c.tileHeadDrift} value={EXAMPLE_SNAPSHOT.headDriftCount} />
                <Tile label={c.tileDuplicates} value={2} />
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

/** "Showing the first N of M" — rendered only when the UI_ROW_CAP slice
 *  actually dropped rows, so a complete list stays silent. */
function CapNotice({ shown, total, template }: { shown: number; total: number; template: string }) {
  if (total <= shown) return null;
  return (
    <Text as="p" variant="bodySm" tone="subdued">
      {template.replace("{shown}", String(shown)).replace("{total}", String(total))}
    </Text>
  );
}

// ── Report row layout ──────────────────────────────────────────────────────
// Rows used to be an InlineStack with `align="space-between"`, so a row
// without an editor link pushed its badge to the right edge while a row with
// one didn't — the status column zig-zagged down the list. Each section is now
// ONE css grid and every row contributes one cell per column, empty cells
// included, so the columns are defined by the section rather than by whatever
// each row happens to carry.

/** url · response time · status · action */
const PAGE_COLUMNS = "minmax(0, 1fr) auto auto auto";
/** url · status · action */
const STATUS_COLUMNS = "minmax(0, 1fr) auto auto";
/** url · one trailing column (badge or action, depending on the section) */
const ACTION_COLUMNS = "minmax(0, 1fr) auto";

const REPORT_GRID_STYLE: CSSProperties = {
  display: "grid",
  columnGap: "var(--p-space-400)",
  rowGap: "var(--p-space-200)",
  alignItems: "center",
};
/** URLs are long and unbreakable — the first column takes the slack. */
const MAIN_CELL_STYLE: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const TRAILING_CELL_STYLE: CSSProperties = { justifySelf: "end" };
const INDENT_STYLE: CSSProperties = { paddingInlineStart: "var(--p-space-500)" };
const GROUP_SPACING_STYLE: CSSProperties = { marginBlockStart: "var(--p-space-300)" };

function ReportGrid({ columns, children }: { columns: string; children: ReactNode }) {
  return <div style={{ ...REPORT_GRID_STYLE, gridTemplateColumns: columns }}>{children}</div>;
}

/** One row of a `ReportGrid`. Renders a plain fragment on purpose: the cells
 *  have to be direct children of the grid to participate in its columns.
 *  `spacedAbove` separates groups (a broken page from the previous page's
 *  link sources) — the grid's uniform rowGap alone can't tell them apart. */
function ReportRow({ cells, spacedAbove }: { cells: ReactNode[]; spacedAbove?: boolean }) {
  return (
    <>
      {cells.map((cell, i) => (
        <div
          key={i}
          style={{
            ...(i === 0 ? MAIN_CELL_STYLE : TRAILING_CELL_STYLE),
            ...(spacedAbove ? GROUP_SPACING_STYLE : null),
          }}
        >
          {cell}
        </div>
      ))}
    </>
  );
}

/** Sub-rows (a broken page's link sources) stay in the same grid — indenting
 *  the text, not the row, keeps their action column aligned. */
function Indent({ children }: { children: ReactNode }) {
  return <div style={INDENT_STYLE}>{children}</div>;
}

/** The editor link, as the icon-with-tooltip used across the SEO section
 *  (see app.seo.sitemap.tsx / app.seo._index.tsx). */
function EditAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button variant="plain" size="slim" icon={EditIcon} accessibilityLabel={label} onClick={onClick} />
    </Tooltip>
  );
}

/** One crawled page: URL (plus its title), HTTP status, server time and — when
 *  the URL resolved to a shop resource — the editor icon. */
function PageRowLine({
  page,
  openLabel,
  onOpen,
  redirectLoopLabel,
}: {
  page: CrawledPageRow;
  openLabel: string;
  onOpen: (type: AuditType, id: string) => void;
  redirectLoopLabel: string;
}) {
  // `statusClass` is computed in the loader on purpose: calling
  // classifyLinkStatus here would pull crawl.service (and url-resolver.server)
  // into the client bundle — same reason SLOW_PAGE_WARN_MS lives in
  // crawl.shared.ts.
  const tone = page.statusClass === "ok" ? "success" : page.statusClass === "blocked" ? "warning" : "critical";
  return (
    <ReportRow
      cells={[
        <BlockStack gap="050">
          <Text as="span" variant="bodySm">{page.url}</Text>
          {page.title && <Text as="span" variant="bodySm" tone="subdued">{page.title}</Text>}
        </BlockStack>,
        page.responseMs > 0 ? (
          <Text as="span" variant="bodySm" tone="subdued">{`${page.responseMs} ms`}</Text>
        ) : null,
        <Badge tone={tone}>{page.statusCode === -1 ? redirectLoopLabel : String(page.statusCode)}</Badge>,
        page.resourceType && page.resourceId ? (
          <EditAction
            label={openLabel}
            onClick={() => onOpen(page.resourceType as AuditType, page.resourceId as string)}
          />
        ) : null,
      ]}
    />
  );
}

/** `<button>` reset — same approach as the findings accordion in
 *  app.seo.performance.tsx, so a card can be a control without looking like
 *  a browser button. */
const TILE_BUTTON_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  padding: 0,
  border: "none",
  background: "none",
  textAlign: "left",
  cursor: "pointer",
  // <button> would otherwise fall back to the UA font, not Polaris's.
  font: "inherit",
  color: "inherit",
};

/**
 * A metric tile. With `onClick` it becomes the navigation control for its
 * section — `aria-pressed` rather than `role="tab"` on purpose: these are
 * toggle buttons in a grid, and claiming tab semantics would promise
 * arrow-key navigation that a grid of cards doesn't provide.
 */
function Tile({
  label,
  value,
  hint,
  onClick,
  selected,
}: {
  label: string;
  value: string | number;
  hint?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  const card = (
    <Card background={selected ? "bg-surface-selected" : undefined}>
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingLg">{String(value)}</Text>
        {hint && (
          <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>
        )}
      </BlockStack>
    </Card>
  );

  if (!onClick) return card;

  return (
    <button type="button" onClick={onClick} aria-pressed={selected} style={TILE_BUTTON_STYLE}>
      {card}
    </button>
  );
}

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

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Banner,
  Tabs,
} from "@shopify/polaris";
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
} from "../services/seo/crawl.service";
import type { BlockSource } from "../services/seo/crawl.service";
import { BLOCK_SOURCE_TEXT_KEY } from "../utils/task-error-text";

const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

const UI_ROW_CAP = 100;

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
  /** Derived from the crawl pages, not stored on the snapshot row. */
  pagesBlocked: number;
  orphanCount: number;
  headDriftCount: number;
}

interface BlockedRow {
  url: string;
  statusCode: number;
}

interface BrokenLinkRow {
  fromUrl: string;
  toUrl: string;
  statusCode: number;
  anchor: string | null;
  fromResourceType: AuditType | null;
  fromResourceId: string | null;
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
  pagesBlocked: 0,
  orphanCount: 3,
  headDriftCount: 5,
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
      brokenLinks: [] as BrokenLinkRow[],
      blocked: [] as BlockedRow[],
      orphans: [] as OrphanRow[],
      headDrift: [] as HeadDriftRow[],
      slowest: [] as SlowRow[],
      duplicates: [] as DuplicateGroupRow[],
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
      brokenLinks: [] as BrokenLinkRow[],
      blocked: [] as BlockedRow[],
      orphans: [] as OrphanRow[],
      headDrift: [] as HeadDriftRow[],
      slowest: [] as SlowRow[],
      duplicates: [] as DuplicateGroupRow[],
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
  const brokenTotal = pages.filter((p) => classifyLinkStatus(p.statusCode) === "broken").length;
  const okTotal = pages.filter((p) => classifyLinkStatus(p.statusCode) === "ok").length;

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
    pagesBlocked: blockedTotal,
    orphanCount: snapshotRow.orphanCount,
    headDriftCount: snapshotRow.headDriftCount,
  };

  const brokenLinkRows = await db.seoCrawlBrokenLink.findMany({
    // 403/429 rows only exist in snapshots written before the split; they are
    // firewall artifacts, not broken links.
    where: { shop, snapshotId: snapshotRow.id, statusCode: { notIn: [403, 429] } },
    select: { fromUrl: true, toUrl: true, statusCode: true, anchor: true },
    take: UI_ROW_CAP,
  });
  const brokenLinks: BrokenLinkRow[] = brokenLinkRows.map((bl) => {
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

  const slowest: SlowRow[] = [...pages]
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
    brokenLinks,
    blocked,
    orphans,
    headDrift,
    slowest,
    duplicates,
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

  const [tab, setTab] = useState(0);
  const tabs = [
    { id: "broken", content: `${c.tabBrokenLinks} (${data.brokenLinks.length})` },
    { id: "orphans", content: `${c.tabOrphans} (${data.orphans.length})` },
    { id: "headDrift", content: `${c.tabHeadDrift} (${data.headDrift.length})` },
    { id: "slowest", content: `${c.tabSlowest} (${data.slowest.length})` },
    { id: "duplicates", content: `${c.tabDuplicates} (${data.duplicates.length})` },
    { id: "blocked", content: `${c.tabBlocked} (${data.blocked.length})` },
  ];

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
            <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 7 }} gap="300">
              <Tile label={c.tilePages} value={snapshot.pagesCrawled} />
              <Tile label={c.tileOk} value={snapshot.pagesOk} />
              <Tile label={c.tileBroken} value={snapshot.pagesBroken} />
              <Tile
                label={c.tileBlocked}
                value={snapshot.pagesBlocked}
                hint={snapshot.pagesBlocked > 0 ? c.blockedHint : undefined}
              />
              <Tile
                label={c.tileOrphans}
                value={isCapped ? "—" : snapshot.orphanCount}
                hint={isCapped ? c.orphanCappedHint : undefined}
              />
              <Tile label={c.tileHeadDrift} value={snapshot.headDriftCount} />
              <Tile label={c.tileDuplicates} value={data.duplicates.length} />
            </InlineGrid>
          )}
        </BlockStack>
      </Card>

      {snapshot && (
        <Card>
          <BlockStack gap="300">
            <Tabs tabs={tabs} selected={tab} onSelect={setTab} />

            {tab === 0 && (
              <BlockStack gap="200">
                {data.brokenLinks.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyBrokenLinks}</Text>
                ) : (
                  data.brokenLinks.map((bl, i) => (
                    <InlineStack key={i} gap="300" align="space-between" blockAlign="center" wrap>
                      <BlockStack gap="050">
                        <Text as="span" variant="bodySm" tone="subdued">{c.colFrom}: {bl.fromUrl}</Text>
                        <Text as="span" variant="bodySm">{c.colTo}: {bl.toUrl}</Text>
                        {bl.anchor && (
                          <Text as="span" variant="bodySm" tone="subdued">{c.colAnchor}: {bl.anchor}</Text>
                        )}
                      </BlockStack>
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="critical">{String(bl.statusCode)}</Badge>
                        {bl.fromResourceType && bl.fromResourceId && (
                          <Button
                            size="slim"
                            variant="plain"
                            onClick={() => openInEditor(bl.fromResourceType as AuditType, bl.fromResourceId as string)}
                          >
                            {c.openInEditor}
                          </Button>
                        )}
                        <Button size="slim" variant="plain" onClick={() => createRedirect(bl.toUrl)}>
                          {c.createRedirect}
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            )}

            {tab === 1 && (
              <BlockStack gap="200">
                {isCapped ? (
                  <Banner tone="warning">{c.orphanCappedHint}</Banner>
                ) : data.orphans.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyOrphans}</Text>
                ) : (
                  data.orphans.map((o) => (
                    <InlineStack key={o.url} gap="300" align="space-between" blockAlign="center" wrap>
                      <Text as="span" variant="bodySm" truncate>{o.title || o.url}</Text>
                      <Button size="slim" variant="plain" onClick={() => openInEditor(o.resourceType, o.resourceId)}>
                        {c.openInEditor}
                      </Button>
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            )}

            {tab === 2 && (
              <BlockStack gap="200">
                {data.headDrift.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyHeadDrift}</Text>
                ) : (
                  data.headDrift.map((h) => (
                    <InlineStack key={`${h.resourceType}:${h.resourceId}`} gap="300" align="space-between" blockAlign="center" wrap>
                      <BlockStack gap="050">
                        <Text as="span" variant="bodySm" tone="subdued">{c.colCrawledTitle}: {h.crawledTitle || "—"}</Text>
                        <Text as="span" variant="bodySm">{c.colDbTitle}: {h.dbTitle || "—"}</Text>
                      </BlockStack>
                      <Button size="slim" variant="plain" onClick={() => openInEditor(h.resourceType, h.resourceId)}>
                        {c.openInEditor}
                      </Button>
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            )}

            {tab === 3 && (
              <BlockStack gap="200">
                {data.slowest.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyBrokenLinks}</Text>
                ) : (
                  <>
                    <Text as="p" variant="bodySm" tone="subdued">{c.performanceHint}</Text>
                    {data.slowest.map((s) => (
                      <InlineStack key={s.url} gap="300" align="space-between" blockAlign="center" wrap>
                        <Text as="span" variant="bodySm" truncate>{s.url}</Text>
                        <Badge>{`${s.responseMs} ms`}</Badge>
                      </InlineStack>
                    ))}
                  </>
                )}
              </BlockStack>
            )}

            {tab === 4 && (
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

            {tab === 5 && (
              <BlockStack gap="200">
                {data.blocked.length === 0 ? (
                  <Text as="p" tone="subdued">{c.emptyBlocked}</Text>
                ) : (
                  <>
                    <Text as="p" variant="bodySm" tone="subdued">{c.blockedHint}</Text>
                    {blockSourceText && (
                      <Text as="p" variant="bodySm" fontWeight="semibold">{blockSourceText}</Text>
                    )}
                    {data.blocked.map((b) => (
                      <InlineStack key={b.url} gap="300" align="space-between" blockAlign="center" wrap>
                        <Text as="span" variant="bodySm" truncate>{b.url}</Text>
                        <Badge tone="warning">{String(b.statusCode)}</Badge>
                      </InlineStack>
                    ))}
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

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingLg">{String(value)}</Text>
        {hint && (
          <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>
        )}
      </BlockStack>
    </Card>
  );
}

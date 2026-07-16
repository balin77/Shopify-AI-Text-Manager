/**
 * SEO Audit Dashboard (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 1, snapshot
 * caching per Anhang B).
 *
 * Reads the DB content cache (never a live API sweep) via analyzeStore, scores
 * every item with the shared pure computeSeoScore, and presents store-wide
 * aggregates: average score, distribution, score-by-type, the most common
 * problems, and a worst-offenders list whose rows deep-link into the editor
 * (?select=<GID>) through useAppNavigation so Shopify session params survive.
 *
 * analyzeStore() itself is expensive (up to 4×1000 rows + groupBys), so the
 * loader no longer calls it on every visit: it reads the latest persisted
 * SeoScoreSnapshot instead (audit.service.ts), falling back to one inline
 * scan only when no snapshot exists yet (first visit). Refreshing the score
 * is a detached "seoAudit" Task (seo-audit.handler.ts, triggered via the
 * "Rescan" button below) — the same fire-and-forget + heartbeat pattern the
 * "Fix with AI" bulk action uses.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ProgressBar,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone, progressTone, seoTitleEffectiveLimit } from "../utils/seo-score";
import {
  analyzeStore,
  saveAuditSnapshot,
  getLatestAuditSnapshot,
  getAuditTrend,
  type AuditType,
  type AuditTrendPoint,
} from "../services/seo/audit.service";
import type { Plan } from "../config/plans";

// Problem-bucket codes the "Fix with AI" button supports today — must match
// FIXABLE_CODE_TO_FIELD in api-ai-handlers/seo-bulk-fix.handler.ts.
const AI_FIXABLE_PROBLEM_CODES = new Set([
  "seoTitleMissing",
  "seoTitleTooLong",
  "metaDescriptionMissing",
  "metaDescriptionLength",
]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: {
      subscriptionPlan: true,
      seoTitleSuffixEnabled: true,
      seoTitleSuffix: true,
    },
  });

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const suffix =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
  const effectiveLimit = seoTitleEffectiveLimit(suffix);

  let snapshot = await getLatestAuditSnapshot(db, session.shop);
  if (!snapshot) {
    // First-ever visit for this shop: no snapshot yet. Run the scan inline
    // ONCE so this load still works, and persist it immediately so every
    // subsequent visit (and the trend chart) is instantly cached from here on.
    const audit = await analyzeStore(session.shop, { db, seoTitleEffectiveLimit: effectiveLimit, plan });
    await saveAuditSnapshot(db, session.shop, audit);
    snapshot = { audit, createdAt: new Date() };
  }

  const trend = await getAuditTrend(db, session.shop);

  // Cheap existence checks so the buttons render disabled/loading after a
  // reload instead of only reacting to the click in THIS tab (the handlers'
  // own single-flight checks are the source of truth; this is just so the UI
  // doesn't invite a second click that the server would reject anyway).
  const [runningBulkFix, runningScan] = await Promise.all([
    db.task.findFirst({
      where: { shop: session.shop, type: "seoBulkFix", status: "running" },
      select: { id: true },
    }),
    db.task.findFirst({
      where: { shop: session.shop, type: "seoAudit", status: "running" },
      select: { id: true },
    }),
  ]);

  return json({
    audit: snapshot.audit,
    lastScannedAt: snapshot.createdAt.toISOString(),
    trend,
    bulkFixRunning: !!runningBulkFix,
    scanRunning: !!runningScan,
  });
};

/** Editor list route per audited type — target of the row deep-link. */
const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

export default function SeoDashboard() {
  const {
    audit,
    lastScannedAt,
    trend,
    bulkFixRunning,
    scanRunning,
  } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const d = t.seo.dashboard;

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  // "Rescan" — kicks off the detached "seoAudit" Task (seo-audit.handler.ts)
  // through the same shared /api/ai route every other AI action uses.
  // contentType is a valid-but-unused placeholder to satisfy /api/ai's
  // generic contentType gate, same trick handleFixWithAi below uses; seoAudit
  // itself is a non-AI, shop-wide action.
  const rescanFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const [rescanStarted, setRescanStarted] = useState(false);
  const [rescanBanner, setRescanBanner] = useState<{ tone: "critical"; message: string } | null>(null);

  // Wall-clock stamp of the last successful rescan POST — see the clear-flag
  // effect below for why time (not just loader flags) is part of the signal.
  const rescanStartedAtRef = useRef(0);

  useEffect(() => {
    if (rescanFetcher.state !== "idle" || !rescanFetcher.data) return;
    if (rescanFetcher.data.success) {
      rescanStartedAtRef.current = Date.now();
      setRescanStarted(true);
    } else {
      setRescanBanner({ tone: "critical", message: rescanFetcher.data.error || d.scanStartError });
    }
    // Only re-run when the fetcher settles with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescanFetcher.state, rescanFetcher.data]);

  const scanInProgress = scanRunning || rescanStarted;

  const handleRescan = () => {
    if (scanInProgress || rescanFetcher.state !== "idle") return;
    setRescanBanner(null);
    const formData = new FormData();
    formData.append("action", "seoAudit");
    formData.append("contentType", "products");
    rescanFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  // While a scan is running, cheaply re-poll the loader so the stale
  // snapshot/trend picked up on this page load gets refreshed once the
  // detached runner completes — same pattern as app.tasks.tsx's auto-refresh.
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!scanInProgress) return;
    const interval = setInterval(() => {
      revalidatorRef.current.revalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [scanInProgress]);

  // Drop the local "just started" flag once a POST-START revalidation reports
  // no running scan. Keying on `scanRunning` alone deadlocks for fast scans
  // (review W2): a small shop's detached seoAudit task can finish inside the
  // first 3s poll window, so the loader reports `scanRunning: false` on every
  // revalidation and a false→false "transition" never fires an effect keyed
  // only on that value — leaving the button disabled and the poller running
  // forever. `trend` gets a fresh array identity on every revalidation, so it
  // serves as a per-revalidation tick; the 5s grace skips the still-stale
  // loader data present at click time (first fresh poll lands at ~3s).
  useEffect(() => {
    if (!rescanStarted || scanRunning) return;
    if (Date.now() - rescanStartedAtRef.current > 5000) setRescanStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRunning, rescanStarted, lastScannedAt, trend]);

  // "Fix with AI" — posts straight to the shared /api/ai route (same route
  // every other AI action in the app uses), so the server re-audits and runs
  // the same bulk-AI pipeline as alt-text bulk generation. The button only
  // triggers the run; progress lives in the Tasks tab (heartbeat-updated Task
  // row), not in this fetcher.
  const fixFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const [fixingCode, setFixingCode] = useState<string | null>(null);
  const [fixBanner, setFixBanner] = useState<{ tone: "success" | "critical"; message: string } | null>(null);
  // Once the server confirms a run started (or is already running), disable
  // every Fix button for the rest of this page view — mirrors the server's
  // single-flight guard (only one seoBulkFix task per shop at a time).
  const [fixStarted, setFixStarted] = useState(false);

  useEffect(() => {
    if (fixFetcher.state !== "idle" || !fixFetcher.data) return;
    if (fixFetcher.data.success) {
      setFixBanner({ tone: "success", message: d.bulkFixStarted });
      setFixStarted(true);
    } else {
      setFixBanner({ tone: "critical", message: fixFetcher.data.error || d.bulkFixError });
    }
    setFixingCode(null);
    // Only re-run when the fetcher settles with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixFetcher.state, fixFetcher.data]);

  const disableFixButtons = bulkFixRunning || fixStarted;

  const handleFixWithAi = (problemCode: string) => {
    if (disableFixButtons || fixFetcher.state !== "idle") return;
    setFixingCode(problemCode);
    const formData = new FormData();
    formData.append("action", "seoBulkFix");
    // seoBulkFix spans every content type and re-derives affected items
    // server-side; "products" is just a valid placeholder to satisfy /api/ai's
    // generic contentType gate.
    formData.append("contentType", "products");
    formData.append("problemCode", problemCode);
    fixFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  if (audit.totalScanned === 0) {
    return (
      <SeoSectionLayout sectionId="overview">
        <Card>
          <div style={{ padding: "1rem" }}>
            <Text as="p" tone="subdued">
              {d.noData}
            </Text>
          </div>
        </Card>
      </SeoSectionLayout>
    );
  }

  return (
    <SeoSectionLayout sectionId="overview">
      <BlockStack gap="400">
        {audit.capped && (
          <Banner tone="info">
            {d.cappedNote
              .replace("{scanned}", String(audit.totalScanned))
              .replace("{total}", String(audit.totalAvailable))}
          </Banner>
        )}

        {fixBanner && (
          <Banner tone={fixBanner.tone} onDismiss={() => setFixBanner(null)}>
            {fixBanner.message}
          </Banner>
        )}
        {!fixBanner && bulkFixRunning && <Banner tone="info">{d.bulkFixRunning}</Banner>}

        {rescanBanner && (
          <Banner tone={rescanBanner.tone} onDismiss={() => setRescanBanner(null)}>
            {rescanBanner.message}
          </Banner>
        )}
        {!rescanBanner && scanInProgress && <Banner tone="info">{d.scanRunning}</Banner>}

        {/* Last-scanned caption + Rescan trigger */}
        <InlineStack gap="200" align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            {d.lastScanned.replace("{time}", new Date(lastScannedAt).toLocaleString())}
          </Text>
          <Button
            size="slim"
            onClick={handleRescan}
            disabled={scanInProgress || rescanFetcher.state !== "idle"}
            loading={rescanFetcher.state !== "idle"}
          >
            {d.rescan}
          </Button>
        </InlineStack>

        {/* Headline score + distribution */}
        <InlineStack gap="400" align="start" blockAlign="stretch" wrap>
          <div style={{ flex: "1 1 220px" }}>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.averageScore}
                </Text>
                <Text as="p" variant="heading2xl" fontWeight="bold">
                  {audit.averageScore}
                </Text>
                <ProgressBar
                  progress={audit.averageScore}
                  tone={progressTone(audit.averageScore)}
                  size="small"
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.itemsScanned}: {audit.totalScanned}
                </Text>
                {trend.length >= 2 && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {d.trendTitle}
                    </Text>
                    <TrendChart points={trend} />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: "2 1 320px" }}>
            <Card>
              <BlockStack gap="200">
                <DistributionRow
                  label={d.distributionGood}
                  count={audit.distribution.good}
                  total={audit.totalScanned}
                  tone="success"
                />
                <DistributionRow
                  label={d.distributionMedium}
                  count={audit.distribution.medium}
                  total={audit.totalScanned}
                  tone="warning"
                />
                <DistributionRow
                  label={d.distributionPoor}
                  count={audit.distribution.poor}
                  total={audit.totalScanned}
                  tone="critical"
                />
              </BlockStack>
            </Card>
          </div>
        </InlineStack>

        {/* Score by content type */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {d.byType}
            </Text>
            {audit.byType.map((s) => (
              <InlineStack key={s.type} gap="300" blockAlign="center">
                <div style={{ width: "120px" }}>
                  <Text as="span" variant="bodyMd">
                    {d.types[s.type] || s.type}
                  </Text>
                </div>
                <div style={{ width: "48px" }}>
                  <Badge tone={scoreTone(s.avgScore) as any}>{String(s.avgScore)}</Badge>
                </div>
                <div style={{ flex: 1, minWidth: "120px" }}>
                  <ProgressBar
                    progress={s.avgScore}
                    tone={progressTone(s.avgScore)}
                    size="small"
                  />
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                  {s.count}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>

        {/* Most common problems */}
        {audit.problems.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {d.problemsTitle}
              </Text>
              {audit.problems.map((p) => (
                <InlineStack key={p.code} gap="200" align="space-between" blockAlign="center">
                  <Text as="span" variant="bodyMd">
                    {(d.problems as Record<string, string>)[p.code] || p.code}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="attention">
                      {d.affectedItems.replace("{count}", String(p.count))}
                    </Badge>
                    {AI_FIXABLE_PROBLEM_CODES.has(p.code) && (
                      <Button
                        size="slim"
                        onClick={() => handleFixWithAi(p.code)}
                        disabled={disableFixButtons || fixFetcher.state !== "idle"}
                        loading={fixingCode === p.code && fixFetcher.state !== "idle"}
                      >
                        {d.fixWithAi}
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        )}

        {/* Worst offenders */}
        {audit.worstOffenders.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {d.worstOffenders}
              </Text>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colItem}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colType}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colScore}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colIssues}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {audit.worstOffenders.map((row) => (
                      <tr key={`${row.type}:${row.id}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {row.title || row.id}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {d.types[row.type] || row.type}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodySm">{row.issueCount}</Text>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          <Button variant="plain" onClick={() => openInEditor(row.type, row.id)}>
                            {d.openInEditor}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

function DistributionRow({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: "success" | "warning" | "critical";
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  // Polaris ProgressBar has no `warning` tone — map it to `highlight`.
  const barTone = tone === "warning" ? "highlight" : tone;
  return (
    <InlineStack gap="300" blockAlign="center">
      <div style={{ width: "120px" }}>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
      </div>
      <div style={{ flex: 1, minWidth: "120px" }}>
        <ProgressBar progress={pct} tone={barTone} size="small" />
      </div>
      <div style={{ width: "48px", textAlign: "right" }}>
        <Text as="span" variant="bodySm" tone="subdued">
          {count}
        </Text>
      </div>
    </InlineStack>
  );
}

/**
 * Minimal inline sparkline of averageScore over time — a plain SVG polyline,
 * no charting library (the trend has at most MAX_SNAPSHOTS_PER_SHOP=30
 * points, so there's nothing here that needs one). `points` is already
 * oldest -> newest (getAuditTrend's contract).
 *
 * Only `averageScore` is rendered, so the prop type accepts the loader's
 * json()-serialized trend (where `createdAt` is a string, not a Date) without
 * needing to re-widen AuditTrendPoint itself.
 */
function TrendChart({ points }: { points: Pick<AuditTrendPoint, "averageScore">[] }) {
  const width = 240;
  const height = 40;
  const padding = 4;

  const scores = points.map((p) => p.averageScore);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  // Avoid a zero-height range collapsing every point onto one flat line's
  // midpoint in a visually confusing way — treat a flat trend as its own case.
  const range = max - min || 1;

  const coords = points.map((p, i) => {
    const x = padding + (i / (points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((p.averageScore - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const latest = scores[scores.length - 1];
  const first = scores[0];
  // Rising, falling, or flat vs. the oldest point in the window — colors the
  // line the same way the score badges elsewhere on this page are toned.
  const lineColor = latest > first ? "#008060" : latest < first ? "#D82C0D" : "#8A8A8A";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${first} -> ${latest}`}
      style={{ display: "block" }}
    >
      <polyline
        fill="none"
        stroke={lineColor}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords.join(" ")}
      />
    </svg>
  );
}


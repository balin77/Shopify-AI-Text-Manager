/**
 * Performance section (page-speed audit) — SEO tab.
 *
 * Runs a Google PageSpeed Insights audit for a merchant-picked storefront page
 * (homepage / product / collection / page, or a custom path/URL) on mobile or
 * desktop, and renders the Lighthouse performance score, Core Web Vitals,
 * a screenshot with problem-element overlays, findings, real-user CrUX data,
 * and a history of past runs.
 *
 * The heavy lifting (PSI fetch, Prisma cache, screenshot annotation mapping)
 * lives in services/seo/pagespeed.service.ts — this route only orchestrates
 * the picker, submits the audit, and renders the result contract defined in
 * services/seo/pagespeed.types.ts.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ButtonGroup,
  TextField,
  Select,
  Banner,
  IndexTable,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { HelpTooltip } from "../components/HelpTooltip";
import { getFormString } from "../utils/form-data.utils";
import {
  isAllowedAuditUrl,
  runPageSpeedAudit,
  listPageSpeedHistory,
  findLatestPageSpeedAudit,
  findPageSpeedAuditById,
  countPageSpeedRunsToday,
  PageSpeedQuotaExceededError,
  PageSpeedDailyLimitError,
} from "../services/seo/pagespeed.service";
import { getDailyPageSpeedRunsLimit } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import type {
  PageSpeedStrategy,
  PageSpeedAuditResult,
  PageSpeedMetricId,
  CruxCategory,
} from "../services/seo/pagespeed.types";
import { getWebVitalsSummary } from "../services/seo/web-vitals.service";
import type { WebVitalDevice } from "../services/seo/web-vitals.types";

const SHOP_HOST_QUERY = `#graphql
  query seoPerformanceShopHost {
    shop {
      primaryDomain { host }
    }
  }
`;

/** Subscription plan for `shop`, defaulting to "free" — mirrors app.seo._index.tsx. */
async function getShopPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

async function getShopHost(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_HOST_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.primaryDomain?.host || fallbackShop;
  } catch {
    return fallbackShop;
  }
}

/** Picker cap per resource type — mirrors the pattern in app.seo.keywords.tsx. */
const PICKER_CAP = 100;
/** History rows requested from the server / shown in the table. */
const HISTORY_LOAD_LIMIT = 20;
const HISTORY_VISIBLE_LIMIT = 10;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const domain = await getShopHost(admin, shop);

  const [products, collections, pages, history, rum, runsToday, plan] = await Promise.all([
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    // Collection has no status field — every synced collection is a candidate.
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    // Page has no status field either (see prisma/schema.prisma).
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    listPageSpeedHistory({ db, shop, limit: HISTORY_LOAD_LIMIT }),
    getWebVitalsSummary({ db, shop }),
    // Informational only — the action re-counts and is the source of truth.
    // This just lets the button render disabled after a reload instead of
    // inviting a click the server would reject.
    countPageSpeedRunsToday(db, shop),
    getShopPlan(db, shop),
  ]);

  // Theme-editor deep link for enabling the RUM app embed — house pattern from
  // app.seo.structured-data.tsx: myshopify domain (custom domains only proxy
  // /admin via redirect) + activateAppId to preselect the embed when possible.
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const rumEmbedUrl = apiKey
    ? `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/web-vitals`
    : `https://${shop}/admin/themes/current/editor?context=apps`;

  return json({
    domain,
    products,
    collections,
    pages,
    history,
    rum,
    rumEmbedUrl,
    runsToday,
    dailyLimit: getDailyPageSpeedRunsLimit(plan),
  });
};

type ActionResult =
  | { ok: true; result: PageSpeedAuditResult }
  | { ok: false; error: string; detail?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const form = await request.formData();
  const intent = getFormString(form, "intent");

  // Load a stored past audit by id (History-row click). Same result shape as a
  // fresh run — the UI reuses the same rendering block, gated by an
  // "isHistorical" flag returned alongside so the client can show a banner.
  if (intent === "loadHistory") {
    const auditId = getFormString(form, "auditId");
    if (!auditId) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const stored = await findPageSpeedAuditById(db, shop, auditId);
    if (!stored) {
      return json<ActionResult>({ ok: false, error: "notFound" }, { status: 404 });
    }
    return json<ActionResult>({ ok: true, result: stored });
  }

  if (intent !== "runAudit") {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const rawUrl = getFormString(form, "url").trim();
  const strategy: PageSpeedStrategy = getFormString(form, "strategy") === "desktop" ? "desktop" : "mobile";
  const force = getFormString(form, "force") === "1";

  // The domain is recomputed server-side (never trusted from the client) so a
  // tampered request can't point the audit — and the allow-list check below —
  // at an arbitrary third-party host.
  const domain = await getShopHost(admin, shop);
  const url = rawUrl.startsWith("/") ? `https://${domain}${rawUrl}` : rawUrl;
  const allowedHosts = Array.from(new Set([domain, shop].filter(Boolean)));

  if (!url || !isAllowedAuditUrl(url, allowedHosts)) {
    return json<ActionResult>({ ok: false, error: "invalidUrl" }, { status: 400 });
  }

  try {
    const plan = await getShopPlan(db, shop);
    const result = await runPageSpeedAudit({ db, shop, url, strategy, force, plan });
    return json<ActionResult>({ ok: true, result });
  } catch (err: any) {
    // Both budget failures degrade the same way: serve a stored audit of any
    // age so the merchant sees something rather than a hard error. Only the
    // wording differs — Google's quota is not our daily budget, and blaming
    // Google for our own limit would be wrong.
    if (err instanceof PageSpeedQuotaExceededError || err instanceof PageSpeedDailyLimitError) {
      const staleReason = err instanceof PageSpeedDailyLimitError ? "dailyLimit" : "quota";
      const stale = await findLatestPageSpeedAudit(db, shop, url, strategy);
      if (stale) return json<ActionResult>({ ok: true, result: { ...stale, staleReason } });
      return json<ActionResult>(
        { ok: false, error: staleReason === "dailyLimit" ? "dailyLimitReached" : "quotaExceeded" },
        { status: 429 },
      );
    }
    return json<ActionResult>(
      { ok: false, error: "auditFailed", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
};

/**
 * Fixed palette shared by the screenshot overlay and the findings list, so box
 * N and finding N always match. Must hold at least as many entries as a run can
 * produce annotations (LCP + MAX_CLS_ANNOTATIONS + MAX_IMAGE_ANNOTATIONS = 11+),
 * otherwise two different findings share a colour and the mapping breaks.
 */
const ANNOTATION_COLORS = [
  "#e51c23",
  "#ff9800",
  "#9c27b0",
  "#2196f3",
  "#009688",
  "#795548",
  "#607d8b",
  "#4caf50",
  "#c2185b",
  "#3f51b5",
  "#827717",
  "#00838f",
];

function annotationColor(index: number): string {
  return ANNOTATION_COLORS[index % ANNOTATION_COLORS.length];
}

const METRIC_HELP_KEYS: Record<PageSpeedMetricId, string> = {
  lcp: "perfLcp",
  cls: "perfCls",
  tbt: "perfTbt",
  fcp: "perfFcp",
  si: "perfSi",
};

function metricTone(score: number | null): "success" | "warning" | "critical" | undefined {
  if (score == null) return undefined;
  if (score >= 0.9) return "success";
  if (score >= 0.5) return "warning";
  return "critical";
}

const FIELD_CATEGORY_TONE: Record<CruxCategory, "success" | "warning" | "critical"> = {
  FAST: "success",
  AVERAGE: "warning",
  SLOW: "critical",
};

type PerfTone = "success" | "warning" | "critical";

/** Lighthouse's own palette — reused so our bars/gauge read like PSI's. */
const PERF_COLOR: Record<PerfTone, string> = {
  success: "#0cce6b",
  warning: "#ffa400",
  critical: "#ff4e42",
};

/** Lighthouse score bands (90 / 50), not the 70/40 SEO-score bands. */
function lighthouseTone(score: number): PerfTone {
  if (score >= 90) return "success";
  if (score >= 50) return "warning";
  return "critical";
}

/**
 * Core Web Vitals thresholds per field metric, in the metric's own reported unit
 * (ms; CLS as value*100 per CrUX convention). Used for the fallback bar bands
 * and for placing the marker inside its bucket.
 */
const FIELD_THRESHOLDS: Record<string, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 10, poor: 25 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
};

/** Fallback segment widths when a stored audit carries no CrUX histogram. */
const FALLBACK_PROPORTIONS = [0.62, 0.19, 0.19];

/**
 * PSI-style threshold bar: three tone-colored segments whose widths are the
 * real-user distribution (falling back to fixed bands for audits stored before
 * distributions were captured), plus a marker at the p75 value.
 *
 * Marker position = cumulative width of preceding buckets + the value's
 * fraction within its own bucket, so it always lands inside the segment whose
 * color matches the metric's category.
 */
function FieldMetricBar({
  metricKey,
  percentile,
  distributions,
}: {
  metricKey: string;
  percentile: number;
  distributions?: { min: number; max?: number; proportion: number }[];
}) {
  const thresholds = FIELD_THRESHOLDS[metricKey];
  const buckets =
    distributions && distributions.length === 3
      ? distributions
      : thresholds
        ? [
            { min: 0, max: thresholds.good, proportion: FALLBACK_PROPORTIONS[0] },
            { min: thresholds.good, max: thresholds.poor, proportion: FALLBACK_PROPORTIONS[1] },
            { min: thresholds.poor, proportion: FALLBACK_PROPORTIONS[2] },
          ]
        : null;
  if (!buckets) return null;

  const tones: PerfTone[] = ["success", "warning", "critical"];
  const total = buckets.reduce((sum, b) => sum + b.proportion, 0) || 1;

  let markerPct = 0;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const width = b.proportion / total;
    // Open-ended poor bucket: span it to [min, 2*min] so a runaway value still
    // lands on the bar instead of running off the end.
    const span = b.max != null ? b.max - b.min : Math.max(b.min, 1);
    if (b.max == null || percentile < b.max) {
      const within = span > 0 ? Math.min(1, Math.max(0, (percentile - b.min) / span)) : 0;
      markerPct = (cumulative + within * width) * 100;
      break;
    }
    cumulative += width;
    markerPct = cumulative * 100;
  }

  return (
    <div style={{ position: "relative", padding: "6px 0 10px" }}>
      <div style={{ display: "flex", gap: "2px", height: "4px" }}>
        {buckets.map((b, i) => (
          <div
            key={i}
            style={{
              width: `${(b.proportion / total) * 100}%`,
              background: PERF_COLOR[tones[i]],
              borderRadius: "2px",
            }}
          />
        ))}
      </div>
      <span
        style={{
          position: "absolute",
          left: `${Math.min(99, Math.max(1, markerPct))}%`,
          top: "2px",
          width: "10px",
          height: "10px",
          marginLeft: "-5px",
          borderRadius: "50%",
          border: "2px solid var(--p-color-text-secondary, #6d7175)",
          background: "var(--p-color-bg-surface, #fff)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

/**
 * Tone marker in front of a metric name. Shape carries the same information as
 * the color (circle = good, square = needs improvement, triangle = poor), the
 * way PSI does it, so the verdict survives for color-blind merchants.
 */
function ToneMarker({ tone, label }: { tone?: PerfTone; label?: string }) {
  const color = tone ? PERF_COLOR[tone] : "var(--p-color-border, #c9cccf)";
  const base: CSSProperties = { display: "inline-block", flexShrink: 0, width: "10px", height: "10px" };
  if (tone === "critical") {
    return (
      <span
        title={label}
        aria-label={label}
        style={{
          ...base,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderBottom: `9px solid ${color}`,
        }}
      />
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        ...base,
        background: color,
        borderRadius: tone === "success" ? "50%" : "2px",
      }}
    />
  );
}

/** Score bands shown as a legend under the gauge — pure numerals, no i18n needed. */
const SCORE_LEGEND: { range: string; tone: PerfTone }[] = [
  { range: "0–49", tone: "critical" },
  { range: "50–89", tone: "warning" },
  { range: "90–100", tone: "success" },
];

/** Shared responsive grid for the field-data and lab-metric tiles. */
const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: "16px 32px",
};

/** Circular Lighthouse-style score gauge. */
function ScoreGauge({ score, label }: { score: number | null; label: string }) {
  const tone: PerfTone = score == null ? "warning" : lighthouseTone(score);
  const color = PERF_COLOR[tone];
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const filled = score != null ? (score / 100) * circumference : 0;

  return (
    <BlockStack gap="150" inlineAlign="center">
      <div style={{ position: "relative", width: "128px", height: "128px" }}>
        <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label={`${label}: ${score ?? "–"}`}>
          <circle cx="64" cy="64" r={radius} fill={`${color}1f`} stroke={`${color}40`} strokeWidth="8" />
          <circle
            cx="64"
            cy="64"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference - filled}`}
            transform="rotate(-90 64 64)"
          />
        </svg>
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "34px",
            fontWeight: 500,
            color,
          }}
        >
          {score != null ? score : "–"}
        </span>
      </div>
      <Text as="span" variant="headingMd">{label}</Text>
    </BlockStack>
  );
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB`;
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/**
 * Core Web Vitals thresholds (good / needs-improvement / poor) applied to the
 * RUM (real-user) p75 aggregates — same bands Google uses for LCP/CLS/INP.
 */
function cwvTone(value: number | null, goodMax: number, poorMin: number): "success" | "warning" | "critical" | undefined {
  if (value == null) return undefined;
  if (value <= goodMax) return "success";
  if (value > poorMin) return "critical";
  return "warning";
}

export default function SeoPerformance() {
  const { products, collections, pages, history, rum, rumEmbedUrl, runsToday, dailyLimit } =
    useLoaderData<typeof loader>();
  const { t } = useI18n();
  const p = t.seo.performancePage;

  const fetcher = useFetcher<ActionResult>();
  const historyFetcher = useFetcher<ActionResult>();

  const [selectedPath, setSelectedPath] = useState<string>("/");
  const [customUrl, setCustomUrl] = useState("");
  const [strategy, setStrategy] = useState<PageSpeedStrategy>("mobile");

  // Which past-run row is currently opened via the History table (null = user
  // is viewing the freshly-run audit / no history opened). Cleared by the
  // "back to latest" button in the historical banner.
  const [viewedHistoryId, setViewedHistoryId] = useState<string | null>(null);
  const [viewedHistoryResult, setViewedHistoryResult] = useState<PageSpeedAuditResult | null>(null);

  useEffect(() => {
    if (historyFetcher.state === "idle" && historyFetcher.data && historyFetcher.data.ok) {
      setViewedHistoryResult(historyFetcher.data.result);
    }
  }, [historyFetcher.state, historyFetcher.data]);

  // Running a fresh audit closes any opened history view.
  useEffect(() => {
    if (fetcher.state !== "idle") {
      setViewedHistoryId(null);
      setViewedHistoryResult(null);
    }
  }, [fetcher.state]);

  const effectiveUrl = customUrl.trim() || selectedPath;

  const selectOptions = useMemo(
    () => [
      { label: p.homepageOption, value: "/" },
      {
        title: p.groupProducts,
        options: products.map((item) => ({ label: item.title || item.handle, value: `/products/${item.handle}` })),
      },
      {
        title: p.groupCollections,
        options: collections.map((item) => ({
          label: item.title || item.handle,
          value: `/collections/${item.handle}`,
        })),
      },
      {
        title: p.groupPages,
        options: pages.map((item) => ({ label: item.title || item.handle, value: `/pages/${item.handle}` })),
      },
    ],
    [products, collections, pages, p.homepageOption, p.groupProducts, p.groupCollections, p.groupPages],
  );

  const running = fetcher.state !== "idle";
  const loadingHistory = historyFetcher.state !== "idle";
  const data = fetcher.data;
  const liveResult = data && data.ok ? data.result : null;
  // Historical selection wins visually: when a history row is opened, the
  // result block shows that stored audit and the banner explains it.
  const result = viewedHistoryResult ?? liveResult;
  const isHistorical = viewedHistoryResult != null;
  const errorMessage =
    data && !data.ok
      ? data.error === "invalidUrl"
        ? p.errors.invalidUrl
        : data.error === "quotaExceeded"
          ? p.errors.quotaExceeded
          : data.error === "dailyLimitReached"
            ? p.errors.dailyLimitReached.replace("{limit}", String(dailyLimit))
            : `${p.errors.auditFailed}${data.detail ? `: ${data.detail}` : ""}`
      : null;

  // Loader snapshot, so it does not tick down within a session — the action
  // re-counts and is authoritative. Good enough to disable the button and show
  // the merchant where they stand before they click.
  const budgetExhausted = runsToday >= dailyLimit;

  const openHistoryEntry = (entry: (typeof history)[number]) => {
    // Mirror the row's URL + strategy into the controls so "Re-test" naturally
    // targets the same page the merchant is looking at.
    setStrategy(entry.strategy);
    const path = pathOnly(entry.url);
    setCustomUrl("");
    setSelectedPath(path);
    setViewedHistoryId(entry.id);
    historyFetcher.submit(
      { intent: "loadHistory", auditId: entry.id },
      { method: "post" },
    );
  };

  const closeHistoryView = () => {
    setViewedHistoryId(null);
    setViewedHistoryResult(null);
  };

  const submitAudit = (force: boolean) => {
    fetcher.submit(
      { intent: "runAudit", url: effectiveUrl, strategy, force: force ? "1" : "0" },
      { method: "post" },
    );
  };

  const strategyLabel = (s: PageSpeedStrategy) => (s === "desktop" ? p.strategyDesktop : p.strategyMobile);

  // History/banner/score-header display of the tested URL: swap the bare "/"
  // for the same friendly homepage label used in the picker dropdown, so past
  // runs of the homepage read as "Homepage"/"Startseite" instead of "/".
  const displayPath = (url: string): string => {
    const path = pathOnly(url);
    return path === "/" ? p.homepageOption : path;
  };

  const annotationIndexById = useMemo(() => {
    const map = new Map<string, number>();
    result?.annotations.forEach((a, i) => map.set(a.id, i));
    return map;
  }, [result]);

  const annotatable = !!result?.screenshot?.fullPage;
  const visibleHistory = history.slice(0, HISTORY_VISIBLE_LIMIT);

  // Both lists are capped server-side; disclose how much was left out instead
  // of letting a truncated list read as the complete picture. `?? 0` covers
  // audits stored before these totals existed.
  const hiddenAnnotations = Math.max(0, (result?.annotationTotal ?? 0) - (result?.annotations.length ?? 0));
  const hiddenOpportunities = Math.max(0, (result?.opportunityTotal ?? 0) - (result?.opportunities.length ?? 0));

  // Real-user (CrUX) rows, in PSI's own order. CLS is reported as value*100 per
  // CrUX convention, everything else is milliseconds.
  // `group` splits them the way PSI does: the three Core Web Vitals first, the
  // supporting metrics under their own heading.
  const fieldRows = useMemo(() => {
    const fd = result?.fieldData;
    if (!fd) return [];
    return (
      [
        { key: "lcp", group: "core", label: p.fieldMetricNames.lcp, metric: fd.lcp, format: formatMs },
        { key: "inp", group: "core", label: p.fieldMetricNames.inp, metric: fd.inp, format: formatMs },
        {
          key: "cls",
          group: "core",
          label: p.fieldMetricNames.cls,
          metric: fd.cls,
          format: (v: number) => (v / 100).toFixed(2),
        },
        { key: "fcp", group: "other", label: p.fieldMetricNames.fcp, metric: fd.fcp, format: formatMs },
        { key: "ttfb", group: "other", label: p.fieldMetricNames.ttfb, metric: fd.ttfb, format: formatMs },
      ] as const
    ).filter((row) => !!row.metric);
  }, [result, p.fieldMetricNames]);

  const coreFieldRows = fieldRows.filter((row) => row.group === "core");
  const otherFieldRows = fieldRows.filter((row) => row.group === "other");

  const renderFieldMetric = (row: (typeof fieldRows)[number]) => {
    const metric = row.metric!;
    const tone = FIELD_CATEGORY_TONE[metric.category];
    return (
      <BlockStack key={row.key} gap="100">
        <InlineStack gap="150" blockAlign="center" wrap={false}>
          <ToneMarker tone={tone} label={p.fieldCategory[metric.category]} />
          <Text as="span" variant="bodyMd">{row.label}</Text>
        </InlineStack>
        <div
          style={{
            fontSize: "22px",
            lineHeight: "28px",
            textAlign: "center",
            color: PERF_COLOR[tone],
          }}
        >
          {row.format(metric.percentile)}
        </div>
        <FieldMetricBar
          metricKey={row.key}
          percentile={metric.percentile}
          distributions={metric.distributions}
        />
      </BlockStack>
    );
  };

  // Toggle for the "Learn more" panel under the no-highlight banner. Reset
  // whenever the underlying result changes so it doesn't leak between runs.
  const [showNoHighlightReason, setShowNoHighlightReason] = useState(false);
  useEffect(() => {
    setShowNoHighlightReason(false);
  }, [result]);

  // Natural pixel width of the loaded screenshot — used to cap the rendered
  // <img> so PSI's low-res JPEGs (especially the viewport-only fallback where
  // `result.screenshot.width` is 0) aren't stretched beyond native size.
  const [screenshotNaturalWidth, setScreenshotNaturalWidth] = useState<number | null>(null);
  useEffect(() => {
    setScreenshotNaturalWidth(null);
  }, [result?.screenshot?.data]);
  const screenshotMaxWidth =
    result?.screenshot?.width && result.screenshot.width > 0
      ? result.screenshot.width
      : screenshotNaturalWidth ?? undefined;

  return (
    <SeoSectionLayout sectionId="performance">
      <BlockStack gap="400">
        <Banner tone="info" title={p.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{p.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{p.helpBody2}</Text>
          </BlockStack>
        </Banner>

        {/* Controls */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.controlsTitle}</Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "260px", flex: "1 1 260px" }}>
                <Select
                  label={p.pageLabel}
                  options={selectOptions as any}
                  value={selectedPath}
                  onChange={setSelectedPath}
                  disabled={!!customUrl.trim()}
                />
              </div>
              <div style={{ minWidth: "260px", flex: "1 1 260px" }}>
                <TextField
                  label={p.customUrlLabel}
                  autoComplete="off"
                  placeholder={p.customUrlPlaceholder}
                  value={customUrl}
                  onChange={setCustomUrl}
                />
              </div>
              <div style={{ minWidth: "180px" }}>
                <Text as="span" variant="bodyMd">{p.strategyLabel}</Text>
                <ButtonGroup variant="segmented">
                  <Button pressed={strategy === "mobile"} onClick={() => setStrategy("mobile")}>
                    {p.strategyMobile}
                  </Button>
                  <Button pressed={strategy === "desktop"} onClick={() => setStrategy("desktop")}>
                    {p.strategyDesktop}
                  </Button>
                </ButtonGroup>
              </div>
              <Button
                variant="primary"
                loading={running}
                disabled={!effectiveUrl || budgetExhausted}
                onClick={() => submitAudit(false)}
              >
                {p.testButton}
              </Button>
              {result && (
                <Button loading={running} disabled={budgetExhausted} onClick={() => submitAudit(true)}>
                  {p.retestButton}
                </Button>
              )}
            </InlineStack>
            {running && (
              <Text as="p" variant="bodySm" tone="subdued">
                {p.runningHint}
              </Text>
            )}
            <Text as="p" variant="bodySm" tone={budgetExhausted ? "caution" : "subdued"}>
              {(budgetExhausted ? p.budgetExhausted : p.budgetRemaining)
                .replace("{used}", String(runsToday))
                .replace("{limit}", String(dailyLimit))}
            </Text>
          </BlockStack>
        </Card>

        {errorMessage && <Banner tone="critical">{errorMessage}</Banner>}

        {result && (
          <BlockStack gap="400">
            {isHistorical && (
              <Banner
                tone="info"
                title={p.viewingHistoryTitle
                  .replace("{date}", new Date(result.fetchedAt).toLocaleString())}
                onDismiss={closeHistoryView}
              >
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    {p.viewingHistoryBody
                      .replace("{url}", displayPath(result.url))
                      .replace("{strategy}", strategyLabel(result.strategy))}
                  </Text>
                  <InlineStack>
                    <Button onClick={closeHistoryView}>{p.viewingHistoryBack}</Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {result.stale && !isHistorical && (
              <Banner tone="warning">
                {result.staleReason === "dailyLimit"
                  ? p.staleDailyLimitNotice.replace("{limit}", String(dailyLimit))
                  : p.staleQuotaNotice}
              </Banner>
            )}
            {/* Real-user (CrUX) field data — leads the result the way PSI does,
                full width, one threshold bar per metric. */}
            {result.fieldData && (
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="h3" variant="headingMd">{p.fieldDataTitle}</Text>
                    {/* CrUX's aggregate verdict — the "passed / did not pass
                        the Core Web Vitals assessment" line PSI leads with. */}
                    {result.fieldData.overallCategory && (
                      <InlineStack gap="150" blockAlign="center">
                        <Text as="span" variant="bodyMd">{p.fieldOverallLabel}:</Text>
                        <Badge tone={FIELD_CATEGORY_TONE[result.fieldData.overallCategory]}>
                          {result.fieldData.overallCategory === "FAST"
                            ? p.fieldOverallPass
                            : p.fieldOverallFail}
                        </Badge>
                      </InlineStack>
                    )}
                  </InlineStack>

                  <div style={FIELD_GRID_STYLE}>{coreFieldRows.map(renderFieldMetric)}</div>

                  {otherFieldRows.length > 0 && (
                    <BlockStack gap="300">
                      <Divider />
                      <Text as="h4" variant="headingSm" tone="subdued">{p.fieldOtherTitle}</Text>
                      <div style={FIELD_GRID_STYLE}>{otherFieldRows.map(renderFieldMetric)}</div>
                    </BlockStack>
                  )}

                  {result.fieldData.originFallback && (
                    <Text as="p" variant="bodySm" tone="subdued">{p.fieldOriginFallback}</Text>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Lab result (this run) — gauge + the measured metrics. */}
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="500" blockAlign="center" wrap>
                  <ScoreGauge score={result.performanceScore} label={p.scoreTitle} />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {p.testedLabel
                        .replace("{url}", displayPath(result.url))
                        .replace("{strategy}", strategyLabel(result.strategy))
                        .replace("{date}", new Date(result.fetchedAt).toLocaleString())}
                    </Text>
                    {result.finalUrl && (
                      <Text as="p" variant="bodySm" tone="caution">
                        {p.redirectNotice.replace("{url}", result.finalUrl)}
                      </Text>
                    )}
                    <InlineStack gap="300" wrap>
                      {SCORE_LEGEND.map((entry) => (
                        <InlineStack key={entry.range} gap="100" blockAlign="center">
                          <ToneMarker tone={entry.tone} />
                          <Text as="span" variant="bodySm" tone="subdued">{entry.range}</Text>
                        </InlineStack>
                      ))}
                    </InlineStack>
                  </BlockStack>
                </InlineStack>

                <Divider />

                <Text as="h4" variant="headingSm" tone="subdued">{p.metricsTitle}</Text>
                <div style={FIELD_GRID_STYLE}>
                  {result.metrics.map((m) => {
                    const helpKey = METRIC_HELP_KEYS[m.id as PageSpeedMetricId];
                    const tone = metricTone(m.score);
                    return (
                      <BlockStack key={m.id} gap="100">
                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <ToneMarker tone={tone} />
                          <Text as="span" variant="bodyMd">
                            {p.metricNames[m.id as PageSpeedMetricId] || m.id}
                          </Text>
                          {helpKey && <HelpTooltip helpKey={helpKey} position="below" />}
                        </InlineStack>
                        <div
                          style={{
                            fontSize: "22px",
                            lineHeight: "28px",
                            color: tone ? PERF_COLOR[tone] : undefined,
                          }}
                        >
                          {m.displayValue}
                        </div>
                      </BlockStack>
                    );
                  })}
                </div>
              </BlockStack>
            </Card>

            {/* Lighthouse could not analyse the page at all — PSI still answers
                HTTP 200, so without this the run would render as an empty
                result with a "–" score and no explanation. */}
            {result.runtimeError && (
              <Banner tone="critical" title={p.runtimeErrorTitle}>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">{p.runtimeErrorBody}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {p.runtimeErrorDetail.replace("{message}", result.runtimeError)}
                  </Text>
                </BlockStack>
              </Banner>
            )}

            {result.runWarnings && result.runWarnings.length > 0 && (
              <Banner tone="warning" title={p.runWarningsTitle}>
                <BlockStack gap="100">
                  {result.runWarnings.map((w, i) => (
                    <Text key={i} as="p" variant="bodySm">{w}</Text>
                  ))}
                </BlockStack>
              </Banner>
            )}

            {!annotatable && (
              <Banner
                tone="info"
                title={p.noHighlightTitle}
                action={{
                  content: p.noHighlightRetryAction,
                  onAction: () => submitAudit(true),
                  loading: running,
                }}
              >
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">{p.noHighlightBody}</Text>
                  <InlineStack>
                    <Button
                      variant="plain"
                      onClick={() => setShowNoHighlightReason((v) => !v)}
                    >
                      {showNoHighlightReason ? p.noHighlightHideDetails : p.noHighlightLearnMore}
                    </Button>
                  </InlineStack>
                  {showNoHighlightReason && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {result?.screenshotUnavailableReason
                        ? p.noHighlightGoogleReason.replace("{reason}", result.screenshotUnavailableReason)
                        : p.noHighlightGenericReason}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: result.screenshot
                  ? "repeat(auto-fit, minmax(min(100%, 420px), 1fr))"
                  : "1fr",
                gap: "16px",
                alignItems: "start",
              }}
            >
              {result.screenshot && (
                <Card>
                  <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
                    <div
                      style={{
                        position: "relative",
                        maxWidth: screenshotMaxWidth ? `${screenshotMaxWidth}px` : undefined,
                      }}
                    >
                      <img
                        src={result.screenshot.data}
                        alt=""
                        onLoad={(e) => {
                          const nw = (e.currentTarget as HTMLImageElement).naturalWidth;
                          if (nw > 0) setScreenshotNaturalWidth(nw);
                        }}
                        style={{ width: "100%", display: "block" }}
                      />
                      {annotatable &&
                        result.annotations.map((a, i) => (
                          <div
                            key={a.id}
                            style={{
                              position: "absolute",
                              left: `${(a.rect.left / result.screenshot!.width) * 100}%`,
                              top: `${(a.rect.top / result.screenshot!.height) * 100}%`,
                              width: `${(a.rect.width / result.screenshot!.width) * 100}%`,
                              height: `${(a.rect.height / result.screenshot!.height) * 100}%`,
                              border: `2px solid ${annotationColor(i)}`,
                              boxSizing: "border-box",
                              pointerEvents: "none",
                            }}
                          >
                            <span
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                transform: "translateY(-100%)",
                                background: annotationColor(i),
                                color: "#fff",
                                fontSize: "10px",
                                lineHeight: "14px",
                                padding: "0 4px",
                              }}
                            >
                              {i + 1}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                </Card>
              )}

              <BlockStack gap="400">
                {/* Findings */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">{p.findingsTitle}</Text>
                    {result.annotations.length === 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">{p.noHighlightNote}</Text>
                    ) : (
                      <BlockStack gap="150">
                        {result.annotations.map((a, i) => (
                          <InlineStack key={a.id} gap="200" blockAlign="start" wrap={false}>
                            <span
                              style={{
                                display: "inline-block",
                                width: "12px",
                                height: "12px",
                                marginTop: "4px",
                                borderRadius: "2px",
                                background: annotationColor(i),
                                flexShrink: 0,
                              }}
                            />
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd">
                                {`${i + 1}. ${p.annotationKinds[a.kind] || a.kind} — ${a.label}`}
                              </Text>
                              {a.detail && (
                                <Text as="span" variant="bodySm" tone="subdued">{a.detail}</Text>
                              )}
                            </BlockStack>
                          </InlineStack>
                        ))}
                        {hiddenAnnotations > 0 && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {p.annotationsTruncated.replace("{count}", String(hiddenAnnotations))}
                          </Text>
                        )}
                      </BlockStack>
                    )}

                    {result.opportunities.length > 0 && (
                      <BlockStack gap="200">
                        <Text as="h4" variant="headingSm">{p.opportunitiesTitle}</Text>
                        {result.opportunities.map((o) => (
                          <BlockStack key={o.id} gap="100">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{o.title}</Text>
                            {o.description && (
                              <Text as="p" variant="bodySm" tone="subdued">{o.description}</Text>
                            )}
                            {(o.savingsMs != null || o.savingsBytes != null) && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {p.savingsLabel}:{" "}
                                {[
                                  o.savingsMs != null ? formatMs(o.savingsMs) : null,
                                  o.savingsBytes != null ? formatBytes(o.savingsBytes) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" / ")}
                              </Text>
                            )}
                            {o.annotationIds.length > 0 && (
                              <InlineStack gap="100" wrap>
                                {o.annotationIds.map((id) => {
                                  const idx = annotationIndexById.get(id);
                                  if (idx == null) return null;
                                  return (
                                    <span
                                      key={id}
                                      style={{
                                        display: "inline-block",
                                        minWidth: "18px",
                                        textAlign: "center",
                                        borderRadius: "9px",
                                        padding: "0 6px",
                                        fontSize: "11px",
                                        color: "#fff",
                                        background: annotationColor(idx),
                                      }}
                                    >
                                      {idx + 1}
                                    </span>
                                  );
                                })}
                              </InlineStack>
                            )}
                          </BlockStack>
                        ))}
                        {hiddenOpportunities > 0 && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {p.opportunitiesTruncated.replace("{count}", String(hiddenOpportunities))}
                          </Text>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

              </BlockStack>
            </div>
          </BlockStack>
        )}

        {/* Real-user Web Vitals (RUM) */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.rum.title}</Text>
            {rum.totalSamples === 0 ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">{p.rum.emptyBody}</Text>
                <InlineStack>
                  <Button url={rumEmbedUrl} target="_blank">
                    {p.rum.emptyButton}
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">{p.rum.emptyHint}</Text>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="p" variant="bodySm" tone="subdued">
                  {p.rum.summary
                    .replace("{count}", String(rum.totalSamples))
                    .replace("{days}", String(rum.windowDays))}
                </Text>
                <IndexTable
                  itemCount={rum.rows.length}
                  selectable={false}
                  headings={[
                    { title: p.rum.colTemplate },
                    { title: p.rum.colDevice },
                    { title: p.rum.colSamples },
                    { title: p.rum.colLcp },
                    { title: p.rum.colCls },
                    { title: p.rum.colInp },
                  ]}
                >
                  {rum.rows.map((row, index) => (
                    <IndexTable.Row
                      id={`${row.template}-${row.device}`}
                      key={`${row.template}-${row.device}`}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{row.template}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">
                          {(row.device as WebVitalDevice) === "mobile" ? p.strategyMobile : p.strategyDesktop}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{row.samples}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.lcpP75Ms != null ? (
                          <Badge tone={cwvTone(row.lcpP75Ms, 2500, 4000)}>{formatMs(row.lcpP75Ms)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.clsP75 != null ? (
                          <Badge tone={cwvTone(row.clsP75, 0.1, 0.25)}>{row.clsP75.toFixed(2)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.inpP75Ms != null ? (
                          <Badge tone={cwvTone(row.inpP75Ms, 200, 500)}>{formatMs(row.inpP75Ms)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>

                {rum.slowPaths.length > 0 && (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingSm">{p.rum.slowPathsTitle}</Text>
                    {rum.slowPaths.map((sp) => (
                      <InlineStack key={sp.path} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd">{sp.path}</Text>
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {p.rum.slowPathSamples.replace("{count}", String(sp.samples))}
                          </Text>
                          <Badge tone={cwvTone(sp.lcpP75Ms, 2500, 4000)}>{formatMs(sp.lcpP75Ms)}</Badge>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                {rum.elements.length > 0 && (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingSm">{p.rum.elementsTitle}</Text>
                    {rum.elements.map((el, i) => (
                      <InlineStack key={`${el.kind}-${i}`} gap="200" blockAlign="center" wrap>
                        <Text as="span" variant="bodyMd">{p.rum.elementKind[el.kind]}</Text>
                        <code style={{ fontSize: "12px" }}>{el.label}</code>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {p.rum.elementOccurrences.replace("{count}", String(el.occurrences))}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* History */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.historyTitle}</Text>
            {visibleHistory.length === 0 ? (
              <Text as="p" tone="subdued">{p.historyEmpty}</Text>
            ) : (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{p.historyClickHint}</Text>
                <IndexTable
                  itemCount={visibleHistory.length}
                  selectable={false}
                  headings={[
                    { title: p.historyColUrl },
                    { title: p.historyColStrategy },
                    { title: p.historyColScore },
                    { title: p.historyColDate },
                  ]}
                >
                  {visibleHistory.map((entry, index) => {
                    const isOpen = entry.id === viewedHistoryId;
                    return (
                      <IndexTable.Row
                        id={entry.id}
                        key={entry.id}
                        position={index}
                        selected={isOpen}
                        onClick={() => openHistoryEntry(entry)}
                      >
                        <IndexTable.Cell>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight={isOpen ? "semibold" : "regular"}>
                              {displayPath(entry.url)}
                            </Text>
                            {isOpen && <Badge tone="info">{p.historyOpenBadge}</Badge>}
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd">{strategyLabel(entry.strategy)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {entry.performanceScore != null ? (
                            // Lighthouse bands, same as the gauge above — the SEO-score
                            // bands (70/40) would color the very same run differently
                            // on one page.
                            <Badge tone={lighthouseTone(entry.performanceScore)}>{String(entry.performanceScore)}</Badge>
                          ) : (
                            <Text as="span" tone="subdued">–</Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd">
                            {new Date(entry.createdAt).toLocaleDateString(undefined)}
                          </Text>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>
                {loadingHistory && (
                  <Text as="p" variant="bodySm" tone="subdued">{p.historyLoading}</Text>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}

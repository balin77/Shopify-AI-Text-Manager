/**
 * Performance section (page-speed audit) — SEO tab.
 *
 * Runs a Google PageSpeed Insights audit for a merchant-picked storefront page
 * (homepage / product / collection / page, or a custom path/URL) on mobile or
 * desktop and renders it the way PSI itself does: real-user (CrUX) data with a
 * threshold bar per metric on top, then the lab result (score gauge, page
 * screenshot, measured metrics), then the findings as an accordion whose rows
 * carry Lighthouse's own details table — including element thumbnails cropped
 * out of the full-page screenshot — and finally the history of past runs.
 *
 * The heavy lifting (PSI fetch, Prisma cache, screenshot annotation mapping)
 * lives in services/seo/pagespeed.service.ts — this route only orchestrates
 * the picker, submits the audit, and renders the result contract defined in
 * services/seo/pagespeed.types.ts.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
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
  Collapsible,
  Modal,
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
  PageSpeedMetric,
  PageSpeedMetricId,
  PageSpeedCell,
  PageSpeedRect,
  PageSpeedScreenshot,
  PageSpeedTable,
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

/** UI language, forwarded to PSI so Lighthouse answers in the merchant's language. */
async function getShopLanguage(db: any, shop: string): Promise<string | undefined> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { appLanguage: true },
  });
  return settings?.appLanguage || undefined;
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
    const [plan, locale] = await Promise.all([getShopPlan(db, shop), getShopLanguage(db, shop)]);
    const result = await runPageSpeedAudit({ db, shop, url, strategy, force, plan, locale });
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

/** Same help content as the lab metrics — CrUX rows reuse it, plus INP/TTFB. */
const FIELD_HELP_KEYS: Record<string, string> = {
  lcp: "perfLcp",
  inp: "perfInp",
  cls: "perfCls",
  fcp: "perfFcp",
  ttfb: "perfTtfb",
};

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

/**
 * Band widths used when a stored audit carries no CrUX histogram. These are NOT
 * a user distribution — nobody measured them — so the bar is dimmed and
 * explains itself on hover when they are in play.
 */
const FALLBACK_PROPORTIONS = [0.5, 0.25, 0.25];

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
  format,
  fallbackHint,
}: {
  metricKey: string;
  percentile: number;
  distributions?: { min: number; max?: number; proportion: number }[];
  /** Same formatter as the metric's headline value, for the threshold labels. */
  format: (value: number) => string;
  /** Shown on hover when the segment widths are bands, not measured shares. */
  fallbackHint: string;
}) {
  const thresholds = FIELD_THRESHOLDS[metricKey];
  const measured = !!(distributions && distributions.length === 3);
  const buckets =
    measured
      ? distributions!
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

  // Where the color changes — the merchant needs the number behind the break to
  // know when a value starts counting as worse. Only shown for buckets that
  // actually carry a boundary (the open-ended poor bucket has none).
  const boundaries: { pct: number; value: number }[] = [];
  let boundaryCumulative = 0;
  for (let i = 0; i < buckets.length - 1; i++) {
    boundaryCumulative += buckets[i].proportion / total;
    const value = buckets[i].max ?? buckets[i + 1].min;
    if (typeof value === "number") boundaries.push({ pct: boundaryCumulative * 100, value });
  }

  // On a healthy metric both breaks sit far right (e.g. 95% and 98%), so the two
  // labels would print on top of each other. Moving one sideways would put it
  // under the wrong colour, so the second one drops to a second line instead and
  // both stay above the break they belong to.
  const MIN_LABEL_GAP = 22;
  const labelPositions = boundaries.map((b) => ({ pct: Math.min(97, Math.max(3, b.pct)), text: format(b.value) }));
  const stacked =
    labelPositions.length === 2 && labelPositions[1].pct - labelPositions[0].pct < MIN_LABEL_GAP;

  return (
    <div style={{ maxWidth: "260px" }}>
      <div style={{ position: "relative", padding: "6px 0 0" }}>
        <div
          style={{ display: "flex", gap: "2px", height: "4px", opacity: measured ? 1 : 0.4 }}
          title={measured ? undefined : fallbackHint}
        >
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
      <div style={{ position: "relative", height: stacked ? "32px" : "16px", marginTop: "4px" }}>
        {labelPositions.map((label, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: `${label.pct}%`,
              top: stacked && i === 1 ? "16px" : 0,
              // Anchored at the edges instead of centred, so a boundary at 96%
              // keeps its label on the bar.
              transform:
                label.pct <= 6
                  ? "translateX(0)"
                  : label.pct >= 94
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
              whiteSpace: "nowrap",
              fontSize: "11px",
              lineHeight: "16px",
              color: "var(--p-color-text-secondary, #6d7175)",
            }}
          >
            {label.text}
          </span>
        ))}
      </div>
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
          // A CSS triangle needs a zero-size content box — keeping base's 10px
          // width would paint a 20px-wide trapezoid next to the 10px markers.
          width: 0,
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

/**
 * Shared responsive grid for the field-data and lab-metric tiles. The generous
 * column gap (plus the 260px cap on the bars themselves) keeps neighbouring
 * bars from reading as one continuous strip.
 */
const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: "20px 56px",
};

/**
 * Below this age, re-measuring the same page is almost certainly an accident —
 * the merchant is asked first, because every run costs one of the plan's daily
 * runs (5/day on free).
 */
const RECENT_RUN_WINDOW_MS = 5 * 60 * 1000;

/** Synthetic accordion ids for the two grouped rows (not Lighthouse audit ids). */
const ELEMENTS_FINDING_ID = "__elements__";
const PASSED_FINDING_ID = "__passed__";

const FINDING_ROW_STYLE: CSSProperties = {
  borderTop: "1px solid var(--p-color-border-secondary, #e1e3e5)",
};

const FINDING_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  width: "100%",
  padding: "12px",
  background: "none",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  // <button> would otherwise fall back to the UA font, not Polaris's.
  font: "inherit",
  color: "inherit",
};

/**
 * Disclosure glyph for the findings accordion — the same ▼/▶ pair the SEO
 * overview uses for its expandable problem rows, so both read as one control.
 */
function DisclosureGlyph({ open }: { open: boolean }) {
  return (
    <Text as="span" tone="subdued" variant="bodySm">
      <span aria-hidden="true">{open ? "▼" : "▶"}</span>
    </Text>
  );
}

const FINDING_TITLE_STYLE: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

const CODE_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--p-font-family-mono, monospace)",
  fontSize: "12px",
  wordBreak: "break-word",
};

/** Sub-second durations read better as ms — PSI shows "480 ms", not "0,5 s". */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms).toLocaleString()} ms` : formatMs(ms);
}

/** Path + query of a URL, tail-truncated, with the host returned separately. */
function splitUrl(raw: string): { path: string; host?: string } {
  try {
    const parsed = new URL(raw);
    const path = `${parsed.pathname}${parsed.search}`;
    return { path: path.length > 48 ? `…${path.slice(-48)}` : path, host: parsed.host };
  } catch {
    return { path: raw.length > 48 ? `…${raw.slice(-48)}` : raw };
  }
}

/**
 * Crop of one element out of the full-page screenshot — the same trick PSI uses
 * for its element thumbnails: scale the whole screenshot as a background and
 * offset it so the element's rect lands in the box. Renders nothing when
 * Lighthouse gave us no full-page screenshot (then there are no usable rects).
 */
function ElementThumb({
  screenshot,
  rect,
  size = 56,
}: {
  screenshot: PageSpeedScreenshot | null;
  rect?: PageSpeedRect;
  size?: number;
}) {
  if (!screenshot || !rect || !screenshot.width || !screenshot.height) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Never upscale past 2x — a 10px element blown up to 56px is unreadable mush.
  const scale = Math.min(size / rect.width, size / rect.height, 2);
  const offsetX = (size - rect.width * scale) / 2 - rect.left * scale;
  const offsetY = (size - rect.height * scale) / 2 - rect.top * scale;

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
        backgroundImage: `url(${screenshot.data})`,
        backgroundSize: `${screenshot.width * scale}px ${screenshot.height * scale}px`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
        backgroundRepeat: "no-repeat",
        backgroundColor: "var(--p-color-bg-surface-secondary, #f6f6f7)",
        border: "1px solid var(--p-color-border, #e1e3e5)",
        borderRadius: "4px",
      }}
    />
  );
}

function FindingCellValue({
  cell,
  screenshot,
}: {
  cell: PageSpeedCell | null;
  screenshot: PageSpeedScreenshot | null;
}) {
  if (!cell) return null;
  switch (cell.type) {
    case "node": {
      const node = cell.node;
      if (!node) return null;
      return (
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <ElementThumb screenshot={screenshot} rect={node.rect} />
          <span style={CODE_TEXT_STYLE}>{node.label}</span>
        </InlineStack>
      );
    }
    case "url": {
      const { path, host } = splitUrl(cell.text ?? "");
      return (
        <span title={cell.text} style={{ wordBreak: "break-word" }}>
          {path}
          {host && (
            <span style={{ color: "var(--p-color-text-secondary, #6d7175)" }}>{` (${host})`}</span>
          )}
        </span>
      );
    }
    case "code":
      return <span style={CODE_TEXT_STYLE}>{cell.text}</span>;
    case "bytes":
      return <>{formatBytes(cell.value ?? 0)}</>;
    case "ms":
      return <>{formatDuration(cell.value ?? 0)}</>;
    case "numeric":
      return <>{(cell.value ?? 0).toLocaleString()}</>;
    default:
      return <span style={{ wordBreak: "break-word" }}>{cell.text}</span>;
  }
}

const NUMERIC_CELL_TYPES = new Set(["bytes", "ms", "numeric"]);

/** The Lighthouse details table of one finding (URLs, sizes, durations, elements). */
function FindingTable({
  table,
  screenshot,
  truncatedLabel,
}: {
  table: PageSpeedTable;
  screenshot: PageSpeedScreenshot | null;
  truncatedLabel: string;
}) {
  const hiddenRows = Math.max(0, table.rowTotal - table.rows.length);
  const cellStyle = (type: string): CSSProperties => ({
    padding: "6px 8px",
    textAlign: NUMERIC_CELL_TYPES.has(type) ? "right" : "left",
    verticalAlign: "middle",
    borderTop: "1px solid var(--p-color-border-secondary, #e1e3e5)",
  });

  return (
    <BlockStack gap="200">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr>
              {table.columns.map((col, i) => (
                <th
                  key={i}
                  style={{
                    ...cellStyle(col.type),
                    borderTop: "none",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <Fragment key={ri}>
                <tr>
                  {row.cells.map((cell, ci) => (
                    <td key={ci} style={cellStyle(table.columns[ci]?.type ?? "text")}>
                      <FindingCellValue cell={cell} screenshot={screenshot} />
                    </td>
                  ))}
                </tr>
                {row.subRows?.map((sub, si) => (
                  <tr key={`${ri}-${si}`}>
                    {sub.cells.map((cell, ci) => (
                      <td
                        key={ci}
                        style={{
                          ...cellStyle(cell?.type ?? table.columns[ci]?.type ?? "text"),
                          paddingLeft: ci === 0 ? "28px" : undefined,
                          color: "var(--p-color-text-secondary, #6d7175)",
                        }}
                      >
                        <FindingCellValue cell={cell} screenshot={screenshot} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenRows > 0 && (
        <Text as="p" variant="bodySm" tone="subdued">
          {truncatedLabel.replace("{count}", String(hiddenRows))}
        </Text>
      )}
    </BlockStack>
  );
}

/**
 * Lighthouse's performance-score weights (unchanged across LH 10-13), in the
 * order PSI arranges them clockwise from 12 o'clock. They drive the arc lengths
 * of the split ring, so the picture matches how the score is actually computed.
 */
const SCORE_WEIGHTS: { id: PageSpeedMetricId; weight: number }[] = [
  { id: "fcp", weight: 0.1 },
  { id: "lcp", weight: 0.25 },
  { id: "tbt", weight: 0.3 },
  { id: "cls", weight: 0.25 },
  { id: "si", weight: 0.1 },
];

const GAUGE_SIZE = 190;
const GAUGE_CENTER = GAUGE_SIZE / 2;
const GAUGE_RADIUS = 58;
const GAUGE_STROKE = 8;
/** Degrees of empty space between two metric arcs. */
const GAUGE_ARC_GAP = 5;

/** Point on the gauge circle; 0° is 12 o'clock, growing clockwise. */
function gaugePoint(radius: number, degrees: number): [number, number] {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [GAUGE_CENTER + radius * Math.cos(rad), GAUGE_CENTER + radius * Math.sin(rad)];
}

function gaugeArc(radius: number, startDeg: number, endDeg: number): string {
  // A full circle can't be expressed as one arc — nudge it just short of 360.
  const end = endDeg - startDeg >= 360 ? startDeg + 359.99 : endDeg;
  const [x1, y1] = gaugePoint(radius, startDeg);
  const [x2, y2] = gaugePoint(radius, end);
  const largeArc = end - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/**
 * Lighthouse-style score gauge. Hovering splits the ring into one arc per
 * metric — arc length = that metric's weight in the score, fill = its own
 * score — which is how PSI explains where a score comes from.
 */
function ScoreGauge({
  score,
  label,
  metrics,
}: {
  score: number | null;
  label: string;
  metrics: PageSpeedMetric[];
}) {
  const [showSplit, setShowSplit] = useState(false);
  const tone: PerfTone = score == null ? "warning" : lighthouseTone(score);
  const color = PERF_COLOR[tone];

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const available = SCORE_WEIGHTS.filter((w) => metricById.has(w.id));
  const weightTotal = available.reduce((sum, w) => sum + w.weight, 0);
  const splittable = available.length > 0 && weightTotal > 0;

  let cursor = 0;
  const segments = available.map((w) => {
    const start = cursor;
    const span = (w.weight / weightTotal) * 360;
    cursor += span;
    const metric = metricById.get(w.id)!;
    const metricScore = metric.score ?? 0;
    const segTone = metricTone(metric.score);
    const [labelX, labelY] = gaugePoint(GAUGE_RADIUS + 20, start + span / 2);
    return {
      id: w.id,
      color: segTone ? PERF_COLOR[segTone] : "var(--p-color-border, #c9cccf)",
      from: start + GAUGE_ARC_GAP / 2,
      to: start + span - GAUGE_ARC_GAP / 2,
      filledTo: start + GAUGE_ARC_GAP / 2 + Math.max(0, span - GAUGE_ARC_GAP) * metricScore,
      labelX,
      labelY,
    };
  });

  return (
    <BlockStack gap="150" inlineAlign="center">
      <div
        style={{ position: "relative", width: `${GAUGE_SIZE}px`, height: `${GAUGE_SIZE}px` }}
        onMouseEnter={() => setShowSplit(true)}
        onMouseLeave={() => setShowSplit(false)}
      >
        <svg
          width={GAUGE_SIZE}
          height={GAUGE_SIZE}
          viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
          role="img"
          aria-label={`${label}: ${score ?? "–"}`}
        >
          <circle cx={GAUGE_CENTER} cy={GAUGE_CENTER} r={GAUGE_RADIUS} fill={`${color}1f`} />

          {/* Whole-score ring */}
          <g style={{ opacity: showSplit && splittable ? 0 : 1, transition: "opacity 150ms ease-in-out" }}>
            <path
              d={gaugeArc(GAUGE_RADIUS, 0, 360)}
              fill="none"
              stroke={`${color}40`}
              strokeWidth={GAUGE_STROKE}
            />
            {score != null && score > 0 && (
              <path
                d={gaugeArc(GAUGE_RADIUS, 0, (score / 100) * 360)}
                fill="none"
                stroke={color}
                strokeWidth={GAUGE_STROKE}
                strokeLinecap="round"
              />
            )}
          </g>

          {/* Per-metric ring, revealed on hover */}
          {splittable && (
            <g style={{ opacity: showSplit ? 1 : 0, transition: "opacity 150ms ease-in-out" }}>
              {segments.map((seg) => (
                <Fragment key={seg.id}>
                  <path
                    d={gaugeArc(GAUGE_RADIUS, seg.from, seg.to)}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={GAUGE_STROKE}
                    opacity={0.25}
                  />
                  {seg.filledTo > seg.from && (
                    <path
                      d={gaugeArc(GAUGE_RADIUS, seg.from, seg.filledTo)}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={GAUGE_STROKE}
                      strokeLinecap="round"
                    />
                  )}
                  <text
                    x={seg.labelX}
                    y={seg.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="11"
                    fill="var(--p-color-text, #202223)"
                  >
                    {seg.id.toUpperCase()}
                  </text>
                </Fragment>
              ))}
            </g>
          )}
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
            pointerEvents: "none",
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
  const { domain, products, collections, pages, history, rum, rumEmbedUrl, runsToday, dailyLimit } =
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
    // `viewedHistoryId` is cleared when a fresh audit starts — without this
    // guard an in-flight history load would resolve afterwards and put the old
    // audit back on screen, hiding the run the merchant just triggered.
    if (viewedHistoryId && historyFetcher.state === "idle" && historyFetcher.data && historyFetcher.data.ok) {
      setViewedHistoryResult(historyFetcher.data.result);
    }
  }, [historyFetcher.state, historyFetcher.data, viewedHistoryId]);

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

  // Absolute form of what the controls currently target, so it can be compared
  // with the stored (always absolute) audit URLs.
  const targetUrl = effectiveUrl.startsWith("/") ? `https://${domain}${effectiveUrl}` : effectiveUrl;

  /**
   * Newest run of exactly this page+strategy that is younger than the window —
   * either the audit on screen or a row from the history table. Drives the
   * "you just measured this" confirmation.
   */
  const recentRun = useMemo(() => {
    const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    const target = normalize(targetUrl);
    const candidates: { id: string | null; at: number }[] = [];

    for (const entry of history) {
      if (entry.strategy !== strategy || normalize(entry.url) !== target) continue;
      candidates.push({ id: entry.id, at: new Date(entry.createdAt).getTime() });
    }
    // The run currently on screen is newer than the loader's history snapshot.
    if (result && result.strategy === strategy && normalize(result.url) === target) {
      candidates.push({ id: null, at: new Date(result.fetchedAt).getTime() });
    }

    const newest = candidates.sort((a, b) => b.at - a.at)[0];
    if (!newest || Number.isNaN(newest.at)) return null;
    const age = Date.now() - newest.at;
    return age >= 0 && age < RECENT_RUN_WINDOW_MS ? { ...newest, age } : null;
  }, [history, result, strategy, targetUrl]);

  const [confirmRerun, setConfirmRerun] = useState(false);

  // Every run the merchant asks for is a real measurement — the only thing
  // standing between two clicks and two consumed runs is this confirmation.
  const requestAudit = () => {
    if (recentRun) {
      setConfirmRerun(true);
      return;
    }
    submitAudit(true);
  };

  const showPreviousRun = () => {
    setConfirmRerun(false);
    if (!recentRun?.id) return; // already on screen
    const entry = history.find((h) => h.id === recentRun.id);
    if (entry) openHistoryEntry(entry);
  };

  const strategyLabel = (s: PageSpeedStrategy) => (s === "desktop" ? p.strategyDesktop : p.strategyMobile);

  // History/banner/score-header display of the tested URL: swap the bare "/"
  // for the same friendly homepage label used in the picker dropdown, so past
  // runs of the homepage read as "Homepage"/"Startseite" instead of "/".
  const displayPath = (url: string): string => {
    const path = pathOnly(url);
    return path === "/" ? p.homepageOption : path;
  };

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
        { key: "lcp", group: "core", label: p.fieldMetricNames.lcp, metric: fd.lcp, format: formatDuration },
        { key: "inp", group: "core", label: p.fieldMetricNames.inp, metric: fd.inp, format: formatDuration },
        {
          key: "cls",
          group: "core",
          label: p.fieldMetricNames.cls,
          metric: fd.cls,
          format: (v: number) => (v / 100).toFixed(2),
        },
        { key: "fcp", group: "other", label: p.fieldMetricNames.fcp, metric: fd.fcp, format: formatDuration },
        { key: "ttfb", group: "other", label: p.fieldMetricNames.ttfb, metric: fd.ttfb, format: formatDuration },
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
          <HelpTooltip helpKey={FIELD_HELP_KEYS[row.key]} position="below" />
        </InlineStack>
        <div
          style={{
            fontSize: "22px",
            lineHeight: "28px",
            maxWidth: "260px",
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
          format={row.format}
          fallbackHint={p.fieldBarNoDistribution}
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

  // Which findings are expanded. Reset per result, with the first (biggest
  // saving — the list is sorted) open so the section isn't a wall of headers.
  const [openFindings, setOpenFindings] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOpenFindings(new Set(result?.opportunities.slice(0, 1).map((o) => o.id) ?? []));
  }, [result]);
  const toggleFinding = (id: string) =>
    setOpenFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Element thumbnails can only be cropped from the full-page screenshot — the
  // viewport fallback has no matching coordinate space (see pagespeed.types.ts).
  const cropSource = result?.screenshot?.fullPage ? result.screenshot : null;
  // Audits stored before `previewScreenshot` existed only have `screenshot`.
  const previewScreenshot = result?.previewScreenshot ?? result?.screenshot ?? null;

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
                onClick={requestAudit}
              >
                {p.testButton}
              </Button>
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

        {/* Asked before a run that would almost certainly repeat one the
            merchant already has — a run they cannot get back. */}
        <Modal
          open={confirmRerun}
          onClose={() => setConfirmRerun(false)}
          title={p.recentRunTitle}
          primaryAction={{ content: p.recentRunViewAction, onAction: showPreviousRun }}
          secondaryActions={[
            {
              content: p.recentRunRerunAction,
              onAction: () => {
                setConfirmRerun(false);
                submitAudit(true);
              },
            },
            { content: p.recentRunCancelAction, onAction: () => setConfirmRerun(false) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {p.recentRunBody
                  .replace("{url}", displayPath(targetUrl))
                  .replace("{strategy}", strategyLabel(strategy))
                  .replace("{minutes}", String(Math.max(1, Math.round((recentRun?.age ?? 0) / 60000))))}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {p.recentRunBudgetHint
                  .replace("{used}", String(runsToday))
                  .replace("{limit}", String(dailyLimit))}
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>

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
              <Card padding="600">
                <BlockStack gap="500">
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
                    <BlockStack gap="400">
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
            <Card padding="600">
              <BlockStack gap="500">
                {/* Two halves: score left, captured page right, each centred in
                    its own half with a hairline between them. */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: previewScreenshot ? "minmax(0, 1fr) auto minmax(0, 1fr)" : "1fr",
                    alignItems: "center",
                    justifyItems: "center",
                    gap: "24px",
                  }}
                >
                  <BlockStack gap="300" inlineAlign="center">
                    <ScoreGauge
                      score={result.performanceScore}
                      label={p.scoreTitle}
                      metrics={result.metrics}
                    />
                    <div style={{ textAlign: "center", maxWidth: "340px" }}>
                      <BlockStack gap="200" inlineAlign="center">
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
                        <InlineStack gap="300" wrap align="center">
                          {SCORE_LEGEND.map((entry) => (
                            <InlineStack key={entry.range} gap="100" blockAlign="center">
                              <ToneMarker tone={entry.tone} />
                              <Text as="span" variant="bodySm" tone="subdued">{entry.range}</Text>
                            </InlineStack>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    </div>
                  </BlockStack>

                  {previewScreenshot && (
                    <div
                      style={{
                        width: "1px",
                        alignSelf: "stretch",
                        background: "var(--p-color-border-secondary, #e1e3e5)",
                      }}
                    />
                  )}

                  {/* Prefer the viewport shot — `screenshot` is the full-page
                      capture and would only show a top slice here. Element crops
                      are drawn per finding below, not here. */}
                  {previewScreenshot && (
                    <div
                      style={{
                        width: "min(100%, 240px)",
                        maxHeight: "320px",
                        overflow: "hidden",
                        border: "1px solid var(--p-color-border, #e1e3e5)",
                        borderRadius: "8px",
                      }}
                    >
                      <img src={previewScreenshot.data} alt="" style={{ width: "100%", display: "block" }} />
                    </div>
                  )}
                </div>

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

            {/* Findings — full width, one accordion row per Lighthouse
                opportunity/diagnostic, with its own details table. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">{p.findingsTitle}</Text>

                {result.opportunities.length === 0 &&
                result.annotations.length === 0 &&
                (result.passedAudits?.length ?? 0) === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">{p.noHighlightNote}</Text>
                ) : (
                  <div>
                    {result.opportunities.map((o) => {
                      const open = openFindings.has(o.id);
                      const savings = [
                        o.savingsMs != null ? formatDuration(o.savingsMs) : null,
                        o.savingsBytes != null ? formatBytes(o.savingsBytes) : null,
                      ]
                        .filter(Boolean)
                        .join(" / ");
                      return (
                        <div key={o.id} style={FINDING_ROW_STYLE}>
                          <button
                            type="button"
                            onClick={() => toggleFinding(o.id)}
                            aria-expanded={open}
                            aria-controls={`finding-${o.id}`}
                            style={FINDING_HEADER_STYLE}
                          >
                            <span style={FINDING_TITLE_STYLE}>
                              <InlineStack gap="200" blockAlign="center" wrap>
                                <ToneMarker tone={o.score == null ? undefined : metricTone(o.score)} />
                                <Text as="span" variant="bodyMd" fontWeight="medium">{o.title}</Text>
                                {savings && (
                                  <span style={{ color: PERF_COLOR.critical, fontSize: "13px" }}>
                                    {`— ${p.savingsLabel}: ${savings}`}
                                  </span>
                                )}
                              </InlineStack>
                            </span>
                            <DisclosureGlyph open={open} />
                          </button>
                          <Collapsible open={open} id={`finding-${o.id}`} transition={false}>
                            <div style={{ padding: "0 12px 16px" }}>
                              <BlockStack gap="300">
                                {o.description && (
                                  <Text as="p" variant="bodySm" tone="subdued">{o.description}</Text>
                                )}
                                {(o.metricLabels?.length || o.informative || o.displayValue) && (
                                  <InlineStack gap="150" wrap>
                                    {o.displayValue && <Badge>{o.displayValue}</Badge>}
                                    {o.metricLabels?.map((label) => (
                                      <Badge key={label} tone="info">{label}</Badge>
                                    ))}
                                    {o.informative && <Badge>{p.informativeBadge}</Badge>}
                                  </InlineStack>
                                )}
                                {o.table && (
                                  <FindingTable
                                    table={o.table}
                                    screenshot={cropSource}
                                    truncatedLabel={p.tableRowsTruncated}
                                  />
                                )}
                              </BlockStack>
                            </div>
                          </Collapsible>
                        </div>
                      );
                    })}

                    {/* Elements Lighthouse flagged directly (LCP element, layout
                        shifts, oversized images) — shown with a crop of the
                        full-page screenshot when one is available. */}
                    {result.annotations.length > 0 && (
                      <div style={FINDING_ROW_STYLE}>
                        <button
                          type="button"
                          onClick={() => toggleFinding(ELEMENTS_FINDING_ID)}
                          aria-expanded={openFindings.has(ELEMENTS_FINDING_ID)}
                          aria-controls={`finding-${ELEMENTS_FINDING_ID}`}
                          style={FINDING_HEADER_STYLE}
                        >
                          <span style={FINDING_TITLE_STYLE}>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <ToneMarker />
                              <Text as="span" variant="bodyMd" fontWeight="medium">{p.elementsTitle}</Text>
                            </InlineStack>
                          </span>
                          <DisclosureGlyph open={openFindings.has(ELEMENTS_FINDING_ID)} />
                        </button>
                        <Collapsible
                          open={openFindings.has(ELEMENTS_FINDING_ID)}
                          id={`finding-${ELEMENTS_FINDING_ID}`}
                          transition={false}
                        >
                          <div style={{ padding: "0 12px 16px" }}>
                            <BlockStack gap="200">
                              {result.annotations.map((a) => (
                                <InlineStack key={a.id} gap="300" blockAlign="center" wrap={false}>
                                  <ElementThumb screenshot={cropSource} rect={a.rect} />
                                  <BlockStack gap="050">
                                    <Text as="span" variant="bodySm" fontWeight="medium">
                                      {p.annotationKinds[a.kind] || a.kind}
                                    </Text>
                                    <span style={CODE_TEXT_STYLE}>{a.label}</span>
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
                          </div>
                        </Collapsible>
                      </div>
                    )}

                    {/* What the page already gets right. Title-only — this
                        group exists to confirm, not to be worked through. */}
                    {(result.passedAudits?.length ?? 0) > 0 && (
                      <div style={FINDING_ROW_STYLE}>
                        <button
                          type="button"
                          onClick={() => toggleFinding(PASSED_FINDING_ID)}
                          aria-expanded={openFindings.has(PASSED_FINDING_ID)}
                          aria-controls={`finding-${PASSED_FINDING_ID}`}
                          style={FINDING_HEADER_STYLE}
                        >
                          <span style={FINDING_TITLE_STYLE}>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <ToneMarker tone="success" />
                              <Text as="span" variant="bodyMd" fontWeight="medium">
                                {p.passedTitle.replace("{count}", String(result.passedAudits!.length))}
                              </Text>
                            </InlineStack>
                          </span>
                          <DisclosureGlyph open={openFindings.has(PASSED_FINDING_ID)} />
                        </button>
                        <Collapsible
                          open={openFindings.has(PASSED_FINDING_ID)}
                          id={`finding-${PASSED_FINDING_ID}`}
                          transition={false}
                        >
                          <div style={{ padding: "0 12px 16px" }}>
                            <BlockStack gap="150">
                              {result.passedAudits!.map((a) => (
                                <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                                  <ToneMarker tone="success" />
                                  <Text as="span" variant="bodySm">{a.title}</Text>
                                  {a.displayValue && (
                                    <Text as="span" variant="bodySm" tone="subdued">{a.displayValue}</Text>
                                  )}
                                </InlineStack>
                              ))}
                            </BlockStack>
                          </div>
                        </Collapsible>
                      </div>
                    )}

                    {/* Only audits stored while the display cap was 8 can still
                        be short — new runs keep every finding. */}
                    {hiddenOpportunities > 0 && (
                      <div style={{ paddingTop: "12px" }}>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {p.opportunitiesTruncated.replace("{count}", String(hiddenOpportunities))}
                        </Text>
                      </div>
                    )}
                  </div>
                )}
              </BlockStack>
            </Card>
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

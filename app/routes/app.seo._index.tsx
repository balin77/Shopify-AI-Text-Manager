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

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  ProgressBar,
  Banner,
  Collapsible,
  Tooltip,
} from "@shopify/polaris";
import { EditIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useHydrated } from "../hooks/useHydrated";
import { compareStrings, formatDateTime } from "../utils/format";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone, progressTone, seoTitleEffectiveLimit } from "../utils/seo-score";
import {
  analyzeStore,
  saveAuditSnapshot,
  getLatestAuditSnapshot,
  type AuditType,
} from "../services/seo/audit.service";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { analyzeFreshness, excludeDismissed } from "../services/seo/freshness.service";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";

// Problem-bucket codes the "Fix with AI" button supports today — must match
// FIXABLE_CODE_TO_FIELD in api-ai-handlers/seo-bulk-fix.handler.ts.
/**
 * Crawl-derived problem bucket → the ROUTE and tab id that actually shows it.
 * Ids must match `CATEGORY_IDS` in the target route.
 *
 * The route is part of the mapping since PLAN_SEO_CRAWL_EXPANSION §3.8: head
 * drift moved to /app/seo/onpage, and a deep link still pointing at
 * /app/seo/crawl would land the merchant on a tab that no longer has the
 * category at all.
 */
const DEEP_LINK_FOR_PROBLEM: Record<string, { path: string; tab: string; view?: string }> = {
  brokenLinks: { path: "/app/seo/crawl", tab: "broken" },
  serverErrors: { path: "/app/seo/crawl", tab: "serverErrors" },
  orphanPages: { path: "/app/seo/crawl", tab: "orphans" },
  // The on-page half is step 2 of the crawl tab, reached with `?view=onpage`.
  headDrift: { path: "/app/seo/crawl", tab: "headDrift", view: "onpage" },
  // §7.1 — the on-page buckets.
  nonIndexable: { path: "/app/seo/crawl", tab: "indexability", view: "onpage" },
  canonicalIssue: { path: "/app/seo/crawl", tab: "canonicals", view: "onpage" },
  missingH1: { path: "/app/seo/crawl", tab: "h1", view: "onpage" },
  thinContent: { path: "/app/seo/crawl", tab: "thin", view: "onpage" },
  externalBrokenLinks: { path: "/app/seo/crawl", tab: "external" },
};
const DEEP_LINK_FALLBACK = { path: "/app/seo/crawl", tab: "broken" };

const AI_FIXABLE_PROBLEM_CODES = new Set([
  "seoTitleMissing",
  "seoTitleTooLong",
  "metaDescriptionMissing",
  "metaDescriptionLength",
  "titleLength",
  "descriptionTooShort",
  "imagesMissingAlt",
  "duplicateSeoTitle",
  "duplicateSeoDescription",
]);

const SHOP_NAME_QUERY = `#graphql
  query seoDashboardShopName {
    shop { name }
  }
`;

/** Best-effort shop display name for the crawl-derived headDrift bucket's
 *  "– ShopName" suffix strip (audit.service.ts §3.6). Never throws. */
async function fetchShopNameForAudit(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.name || fallbackShop.replace(/\.myshopify\.com$/, "");
  } catch {
    return fallbackShop.replace(/\.myshopify\.com$/, "");
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: {
      subscriptionPlan: true,
      seoTitleSuffixEnabled: true,
      seoTitleSuffix: true,
      seoLimits: true,
      seoFreshnessDismissed: true,
    },
  });

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const suffix =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
  const seoLimits = (settings?.seoLimits ?? null) as Record<string, number> | null;
  const effectiveLimit = seoTitleEffectiveLimit(suffix, seoLimits);

  // Shop locales drive the language toolbar; primary determines what "" means
  // in the snapshot table. Fetches are cached (60s TTL) so this only hits
  // Shopify once per minute per shop.
  const shopLocales = await getCachedShopLocales(admin, session.shop).catch(() => []);
  const primary = shopLocales.find((l) => l.primary);
  const primaryLocale = primary?.locale ?? "";

  // Selected locale from ?locale=xx. Empty = primary (snapshot sentinel).
  // Unknown/unpublished/non-shop locales fall back to primary so a stale link
  // never renders an empty dashboard.
  const requestedLocale = new URL(request.url).searchParams.get("locale") ?? "";
  const isValidForeign =
    requestedLocale.length > 0 &&
    requestedLocale !== primaryLocale &&
    shopLocales.some((l) => l.locale === requestedLocale && l.published && !l.primary);
  const activeLocaleKey = isValidForeign ? requestedLocale : "";

  let snapshot = await getLatestAuditSnapshot(db, session.shop, activeLocaleKey);
  if (!snapshot) {
    // First-ever visit for this (shop, locale): no snapshot yet. Run the scan
    // inline ONCE so this load still works, and persist it immediately so
    // every subsequent visit is instantly cached from here on. The next
    // "Rescan" click will refresh every locale in one Task.
    // shopName is only fetched on this cold path (not the hot cached-snapshot
    // path above) — it's only used for the crawl-derived headDrift bucket's
    // "– ShopName" suffix strip (audit.service.ts §3.6).
    const shopName = await fetchShopNameForAudit(admin, session.shop);
    const audit = await analyzeStore(session.shop, {
      db,
      seoTitleEffectiveLimit: effectiveLimit,
      seoLimits,
      plan,
      locale: activeLocaleKey || undefined,
      shopName,
    });
    await saveAuditSnapshot(db, session.shop, audit, activeLocaleKey);
    snapshot = { audit, createdAt: new Date() };
  }

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

  // Content-Freshness card (PLAN_SEO_SUITE_COMPLETION.md §5.3): just a count
  // here — the detail table lives on the Search Console tab (§5.3 "picked
  // one", see that route's header comment). Pro-gated (freshness presupposes
  // GSC) and best-effort: a DB error here must not break the dashboard.
  let freshnessCandidateCount = 0;
  if (meetsPlan(plan, "pro")) {
    try {
      const dismissed = Array.isArray(settings?.seoFreshnessDismissed)
        ? (settings!.seoFreshnessDismissed as string[])
        : [];
      const freshness = await analyzeFreshness(session.shop, { db });
      freshnessCandidateCount = excludeDismissed(freshness.candidates, dismissed).length;
    } catch {
      freshnessCandidateCount = 0;
    }
  }

  // Internal-linking suggestions card (PLAN_SEO_SUITE_COMPLETION.md §4.2):
  // count only — the table lives on its own section. Pro-gated like the
  // freshness card; best-effort so a DB error never breaks the dashboard.
  let internalLinksSuggestionCount = 0;
  if (meetsPlan(plan, "pro")) {
    try {
      internalLinksSuggestionCount = await db.seoInternalLinkSuggestion.count({
        where: { shop: session.shop, status: "pending" },
      });
    } catch {
      internalLinksSuggestionCount = 0;
    }
  }

  return json({
    audit: snapshot.audit,
    lastScannedAt: snapshot.createdAt.toISOString(),
    bulkFixRunning: !!runningBulkFix,
    scanRunning: !!runningScan,
    shopLocales,
    primaryLocale,
    activeLocale: activeLocaleKey, // "" = primary; else the foreign locale code
    freshnessCandidateCount,
    internalLinksSuggestionCount,
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
    bulkFixRunning,
    scanRunning,
    shopLocales,
    primaryLocale,
    activeLocale,
    freshnessCandidateCount,
    internalLinksSuggestionCount,
  } = useLoaderData<typeof loader>();
  const { t, locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const d = t.seo.dashboard;
  // The "last scanned" caption is the merchant's local time — see useHydrated().
  const hydrated = useHydrated();

  // URL search-params ownership: switching locale updates ?locale=xx, which
  // re-runs the loader against the per-locale snapshot. `activeLocale` is the
  // server-validated key ("" = primary), NOT whatever's in the URL — that way
  // an unknown locale falls back cleanly without needing client-side
  // reconciliation.
  const [searchParams, setSearchParams] = useSearchParams();
  const isForeign = activeLocale !== "";
  const sortedLocales = useMemo(() => {
    // useLoaderData widens array-item types with `| null` when the loader
    // catches and returns `[]` — filter defensively so downstream code sees
    // a plain non-null shape.
    const list = (shopLocales as (typeof shopLocales[number] | null)[])
      .filter((l): l is NonNullable<typeof l> => l !== null && l.published);
    list.sort((a, b) => {
      if (a.primary) return -1;
      if (b.primary) return 1;
      return compareStrings(a.name || a.locale, b.name || b.locale, appLocale);
    });
    return list;
  }, [shopLocales, appLocale]);

  const switchLocale = (locale: string) => {
    // Empty string / primary code => primary tab, drop the URL param entirely.
    const next = new URLSearchParams(searchParams);
    if (!locale || locale === primaryLocale) {
      next.delete("locale");
    } else {
      next.set("locale", locale);
    }
    setSearchParams(next, { replace: true });
  };

  // The deep link carries the locale the dashboard is showing. Without it the
  // editor always opened in the primary language, so a merchant reviewing the
  // French audit landed on the right product in the wrong language — and the
  // finding they clicked (a missing French meta description, say) wasn't even
  // visible there.
  const openInEditor = (type: AuditType, id: string) => {
    const params = new URLSearchParams({ select: id });
    if (activeLocale) params.set("locale", activeLocale);
    handleNavigate(TYPE_PATH[type], { searchParams: params });
  };

  /** Blue dot + tooltip naming the untranslated fields — the same signal (and
   *  the same colour) the content editor's item list uses. */
  const MissingTranslationDot = ({ fields }: { fields?: string[] }) => {
    if (!fields || fields.length === 0) return null;
    const labels = fields.map((f) => (d.translationFields as Record<string, string>)[f] || f);
    return (
      <Tooltip content={`${d.missingTranslationsTooltip} ${labels.join(", ")}`} dismissOnMouseOut>
        <span
          aria-label={d.missingTranslationsTooltip}
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            backgroundColor: "rgba(59, 130, 246, 0.9)",
            flexShrink: 0,
            cursor: "default",
          }}
        />
      </Tooltip>
    );
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
  // forever. `audit` gets a fresh object identity on every revalidation, so it
  // serves as a per-revalidation tick; the 5s grace skips the still-stale
  // loader data present at click time (first fresh poll lands at ~3s).
  useEffect(() => {
    if (!rescanStarted || scanRunning) return;
    if (Date.now() - rescanStartedAtRef.current > 5000) setRescanStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRunning, rescanStarted, lastScannedAt, audit]);

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

  // Per-bucket expand/collapse — merchant clicks the ▼/▲ to reveal the affected
  // items and jump straight into the editor from any row. Local UI state only;
  // the item refs themselves come from `p.items` on the loader data.
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(new Set());
  const toggleProblem = (code: string) => {
    setExpandedProblems((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // Same pattern for the worst-offenders rows — each row expands to its own
  // issue list (row.problems) with a per-finding KI button.
  const [expandedOffenders, setExpandedOffenders] = useState<Set<string>>(new Set());
  const toggleOffender = (rowId: string) => {
    setExpandedOffenders((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  // singleItem is the per-row KI button in the expanded list — same handler,
  // just narrowed to one GID on the server. fixAllForItem is the row-level
  // bulk button on worstOffenders — server derives every applicable code
  // for this item and runs them serially in one task.
  const handleFixWithAi = (
    problemCode: string,
    singleItem?: { type: AuditType; id: string },
    fixAllForItem?: boolean,
  ) => {
    if (disableFixButtons || fixFetcher.state !== "idle") return;
    const key = fixAllForItem && singleItem
      ? `__all:${singleItem.id}`
      : singleItem
        ? `${problemCode}:${singleItem.id}`
        : problemCode;
    setFixingCode(key);
    const formData = new FormData();
    formData.append("action", "seoBulkFix");
    // seoBulkFix spans every content type and re-derives affected items
    // server-side; "products" is just a valid placeholder to satisfy /api/ai's
    // generic contentType gate.
    formData.append("contentType", "products");
    formData.append("problemCode", problemCode);
    if (singleItem) {
      formData.append("itemId", singleItem.id);
      formData.append("itemType", singleItem.type);
    }
    if (fixAllForItem) formData.append("fixAllForItem", "true");
    // Foreign-locale fix: the server generates a translation (adapted for the
    // SEO constraint), writes translationsRegister + ContentTranslation, and
    // never touches the primary field. "" = primary, unchanged behavior.
    if (activeLocale) formData.append("locale", activeLocale);
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
        {/* Language switcher — mirrors the content editor's locale toolbar.
            Clicking a locale updates ?locale=xx which re-runs the loader
            against the per-locale snapshot. `activeLocale` (server-validated)
            drives which button is primary, so a stale/unknown URL never
            renders the wrong tab. */}
        {sortedLocales.length > 1 && (
          <InlineStack gap="200" blockAlign="center" wrap>
            {sortedLocales.map((locale) => {
              const isPrimary = locale.locale === primaryLocale;
              const isActive = isPrimary ? activeLocale === "" : activeLocale === locale.locale;
              const label = `${getLocalizedLanguageName(locale.locale, appLocale, locale.name)}${
                isPrimary ? ` (${d.primaryLocaleSuffix})` : ""
              }`;
              return (
                <Button
                  key={locale.locale}
                  size="slim"
                  variant={isActive ? "primary" : undefined}
                  onClick={() => switchLocale(isPrimary ? "" : locale.locale)}
                >
                  {label}
                </Button>
              );
            })}
          </InlineStack>
        )}

        {/* Foreign-locale hint: no scoring surprise if the merchant lands here
            expecting primary numbers — the copy names the locale the score is
            for so the tab identity is obvious even without checking the URL. */}
        {isForeign && (
          <Banner tone="info">
            {d.foreignLocaleBanner.replace(
              "{locale}",
              getLocalizedLanguageName(
                activeLocale,
                appLocale,
                sortedLocales.find((l) => l.locale === activeLocale)?.name,
              ),
            )}
          </Banner>
        )}

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
            {d.lastScanned.replace("{time}", formatDateTime(lastScannedAt, hydrated))}
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

        {/* Headline score + distribution — InlineGrid so both cards stretch to
            the taller row height (CSS Grid default), which InlineStack won't do
            for Polaris Card children (Card doesn't fill its flex parent). */}
        <InlineGrid columns={{ xs: 1, sm: ["oneThird", "twoThirds"] }} gap="400">
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
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">
                {d.distributionTitle}
              </Text>
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
        </InlineGrid>

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

        {/* Content-Freshness (PLAN_SEO_SUITE_COMPLETION.md §5.3): count only —
            the detail table (position/CTR/impressions/last modified, "Mit AI
            überarbeiten"/"Ignorieren") lives on the Search Console tab, which
            already carries the GSC-connection chrome this feature depends on. */}
        {freshnessCandidateCount > 0 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  {d.freshnessCardTitle}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.freshnessCardCount.replace("{count}", String(freshnessCandidateCount))}
                </Text>
              </BlockStack>
              <Button onClick={() => handleNavigate("/app/seo/search-console")}>
                {d.freshnessCardButton}
              </Button>
            </InlineStack>
          </Card>
        )}

        {/* Internal-linking suggestions (PLAN_SEO_SUITE_COMPLETION.md §4.2):
            count only — the table lives on its own section. */}
        {internalLinksSuggestionCount > 0 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  {d.internalLinksCardTitle}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.internalLinksCardCount.replace("{count}", String(internalLinksSuggestionCount))}
                </Text>
              </BlockStack>
              <Button onClick={() => handleNavigate("/app/seo/internal-links")}>
                {d.internalLinksCardButton}
              </Button>
            </InlineStack>
          </Card>
        )}

        {/* Most common problems */}
        {audit.problems.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {d.problemsTitle}
              </Text>
              {audit.problems.map((p) => {
                const isOpen = expandedProblems.has(p.code);
                // p.items may be missing on snapshots written before the
                // item-refs field existed. The toggle is gated on hasItems so
                // an empty bucket still renders the row (count-only) without
                // an inert triangle.
                const items = p.items ?? [];
                const hasItems = items.length > 0;
                const truncated = p.count > items.length;
                const label = (d.problems as Record<string, string>)[p.code] || p.code;
                return (
                  <BlockStack key={p.code} gap="200">
                    <InlineStack gap="200" align="space-between" blockAlign="center">
                      <button
                        type="button"
                        onClick={() => hasItems && toggleProblem(p.code)}
                        disabled={!hasItems}
                        aria-expanded={isOpen}
                        aria-controls={`seo-problem-panel-${p.code}`}
                        aria-label={label}
                        style={{
                          all: "unset",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          cursor: hasItems ? "pointer" : "default",
                          flex: "1 1 auto",
                          minWidth: 0,
                        }}
                      >
                        {hasItems && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            <span aria-hidden="true">{isOpen ? "▼" : "▶"}</span>
                          </Text>
                        )}
                        <Text as="span" variant="bodyMd">{label}</Text>
                      </button>
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="attention">
                          {d.affectedItems.replace("{count}", String(p.count))}
                        </Badge>
                        {p.action === "deepLink" ? (
                          <Button
                            size="slim"
                            onClick={() => {
                              // Without the tab every crawl bucket landed on the
                              // first tab, so "pages returning a server error"
                              // opened on "no broken links found". Without the
                              // path (§3.8) head drift would open a tab that no
                              // longer has the category.
                              const target = DEEP_LINK_FOR_PROBLEM[p.code] ?? DEEP_LINK_FALLBACK;
                              const params = new URLSearchParams({ tab: target.tab });
                              if (target.view) params.set("view", target.view);
                              handleNavigate(target.path, { searchParams: params });
                            }}
                          >
                            {d.viewInCrawlTab}
                          </Button>
                        ) : (
                          AI_FIXABLE_PROBLEM_CODES.has(p.code) && (
                            <Button
                              size="slim"
                              onClick={() => handleFixWithAi(p.code)}
                              disabled={disableFixButtons || fixFetcher.state !== "idle"}
                              loading={fixingCode === p.code && fixFetcher.state !== "idle"}
                            >
                              {d.fixAllWithAi}
                            </Button>
                          )
                        )}
                      </InlineStack>
                    </InlineStack>
                    {hasItems && (
                      <Collapsible
                        open={isOpen}
                        id={`seo-problem-panel-${p.code}`}
                        transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                      >
                        {/* Do NOT gate children on isOpen — Polaris Collapsible
                            already manages the child lifecycle: children stay
                            mounted during the exit animation and unmount at
                            transitionend once `isFullyClosed` is true (see
                            polaris/Collapsible.js:24). Gating here unmounts
                            children BEFORE Polaris measures scrollHeight, so
                            the animation runs from 0 → 0 and the panel
                            visually snaps to just-padding-height (~14px) for
                            one frame before disappearing — that's the
                            "briefly bigger" pop the user reported. Polaris
                            already skips mounting when isFullyClosed, so
                            initial render is cheap too. */}
                        <div
                          style={{
                            paddingLeft: "1.25rem",
                            borderInlineStart: "2px solid var(--p-color-border-subdued)",
                            marginLeft: "0.25rem",
                          }}
                        >
                          <BlockStack gap="100">
                            {items.map((it) => {
                              const itemFixKey = `${p.code}:${it.id}`;
                              const showAiButton = AI_FIXABLE_PROBLEM_CODES.has(p.code);
                              return (
                                <InlineStack
                                  key={`${p.code}:${it.type}:${it.id}`}
                                  gap="200"
                                  align="space-between"
                                  blockAlign="center"
                                >
                                  <div
                                    style={{
                                      minWidth: 0,
                                      flex: "1 1 auto",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "0.5rem",
                                    }}
                                  >
                                    <Text as="span" variant="bodySm" truncate>
                                      {it.title || it.id}
                                    </Text>
                                    <MissingTranslationDot fields={it.missingTranslations} />
                                  </div>
                                  <InlineStack gap="400" blockAlign="center">
                                    <Text as="span" variant="bodySm" tone="subdued">
                                      {d.types[it.type] || it.type}
                                    </Text>
                                    <InlineStack gap="200" blockAlign="center">
                                      {showAiButton && (
                                        <Button
                                          variant="plain"
                                          size="slim"
                                          onClick={() =>
                                            handleFixWithAi(p.code, { type: it.type, id: it.id })
                                          }
                                          disabled={
                                            disableFixButtons || fixFetcher.state !== "idle"
                                          }
                                          loading={
                                            fixingCode === itemFixKey &&
                                            fixFetcher.state !== "idle"
                                          }
                                        >
                                          {d.fixWithAi}
                                        </Button>
                                      )}
                                      <Tooltip content={d.openInEditor}>
                                        <Button
                                          variant="plain"
                                          size="slim"
                                          icon={EditIcon}
                                          accessibilityLabel={d.openInEditor}
                                          onClick={() => openInEditor(it.type, it.id)}
                                        />
                                      </Tooltip>
                                    </InlineStack>
                                  </InlineStack>
                                </InlineStack>
                              );
                            })}
                            {truncated && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {d.problemsTruncated
                                  .replace("{shown}", String(items.length))
                                  .replace("{total}", String(p.count))}
                              </Text>
                            )}
                          </BlockStack>
                        </div>
                      </Collapsible>
                    )}
                  </BlockStack>
                );
              })}
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
                      <th style={{ padding: "6px 8px", width: "1.5rem" }} />
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
                    {audit.worstOffenders.map((row) => {
                      const rowProblems = row.problems ?? [];
                      const fixableProblems = rowProblems.filter((c) => AI_FIXABLE_PROBLEM_CODES.has(c));
                      const isOpen = expandedOffenders.has(row.id);
                      const hasProblems = rowProblems.length > 0;
                      const bulkFixKey = `__all:${row.id}`;
                      return (
                        <React.Fragment key={`${row.type}:${row.id}`}>
                          <tr
                            style={{
                              borderBottom: isOpen ? "none" : "1px solid #f1f2f3",
                              cursor: hasProblems ? "pointer" : "default",
                            }}
                            onClick={() => hasProblems && toggleOffender(row.id)}
                            {...(hasProblems && {
                              role: "button",
                              tabIndex: 0,
                              "aria-expanded": isOpen,
                              "aria-controls": `seo-offender-panel-${row.id}`,
                              onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleOffender(row.id);
                                }
                              },
                            })}
                          >
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              {hasProblems && (
                                <Text as="span" tone="subdued" variant="bodySm">
                                  <span aria-hidden="true">{isOpen ? "▼" : "▶"}</span>
                                </Text>
                              )}
                            </td>
                            <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                                <Text as="span" variant="bodyMd" truncate>
                                  {row.title || row.id}
                                </Text>
                                <MissingTranslationDot fields={row.missingTranslations} />
                              </div>
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
                            {/* Row-actions cell: sibling nav consumers (buttons)
                                MUST NOT trigger the row-level expand click, so
                                stopPropagation on the wrapper. */}
                            <td
                              style={{ padding: "6px 8px", textAlign: "right" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <InlineStack gap="200" blockAlign="center" align="end">
                                {fixableProblems.length > 0 && (
                                  <Button
                                    size="slim"
                                    onClick={() =>
                                      handleFixWithAi("__all", { type: row.type, id: row.id }, true)
                                    }
                                    disabled={disableFixButtons || fixFetcher.state !== "idle"}
                                    loading={fixingCode === bulkFixKey && fixFetcher.state !== "idle"}
                                  >
                                    {d.fixAllWithAi}
                                  </Button>
                                )}
                                <Tooltip content={d.openInEditor}>
                                  <Button
                                    variant="plain"
                                    icon={EditIcon}
                                    accessibilityLabel={d.openInEditor}
                                    onClick={() => openInEditor(row.type, row.id)}
                                  />
                                </Tooltip>
                              </InlineStack>
                            </td>
                          </tr>
                          {hasProblems && (
                            <tr style={{ borderBottom: "1px solid #f1f2f3" }}>
                              <td />
                              <td
                                colSpan={5}
                                style={{ padding: 0 }}
                              >
                                <Collapsible
                                  open={isOpen}
                                  id={`seo-offender-panel-${row.id}`}
                                  transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                                >
                                  <div
                                    style={{
                                      padding: "6px 8px 10px 0",
                                      borderInlineStart: "2px solid var(--p-color-border-subdued)",
                                      marginLeft: "0.25rem",
                                      paddingLeft: "1.25rem",
                                    }}
                                  >
                                    <BlockStack gap="100">
                                      {rowProblems.map((code) => {
                                          const label =
                                            (d.problems as Record<string, string>)[code] || code;
                                          const canFix = AI_FIXABLE_PROBLEM_CODES.has(code);
                                          const perFinding = `${code}:${row.id}`;
                                          return (
                                            <InlineStack
                                              key={`${row.id}:${code}`}
                                              gap="200"
                                              align="space-between"
                                              blockAlign="center"
                                            >
                                              <Text as="span" variant="bodySm">
                                                {label}
                                              </Text>
                                              {canFix && (
                                                <Button
                                                  variant="plain"
                                                  size="slim"
                                                  onClick={() =>
                                                    handleFixWithAi(code, {
                                                      type: row.type,
                                                      id: row.id,
                                                    })
                                                  }
                                                  disabled={
                                                    disableFixButtons ||
                                                    fixFetcher.state !== "idle"
                                                  }
                                                  loading={
                                                    fixingCode === perFinding &&
                                                    fixFetcher.state !== "idle"
                                                  }
                                                >
                                                  {d.fixWithAi}
                                                </Button>
                                              )}
                                            </InlineStack>
                                          );
                                        })}
                                    </BlockStack>
                                  </div>
                                </Collapsible>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
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


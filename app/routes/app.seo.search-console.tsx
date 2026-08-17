/**
 * Google Search Console section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * Pro+ only — gated server-side in BOTH the loader and the action (the section
 * descriptor's planGate also gates the client). When the GOOGLE_OAUTH_* env vars
 * aren't set the section shows "not configured". Otherwise: connect (top-level
 * OAuth), then view top queries, sync keyword rankings, and submit the sitemap.
 */

import { useEffect, useRef, useState } from "react";
import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";

type ExportPayload = { csv: string; filename: string; rowCount: number } | { error: string };
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Select,
  TextField,
  Modal,
  Autocomplete,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan, getGscHistoryDays } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { tryDecryptApiKey } from "../utils/encryption.server";
import {
  isGscConfigured,
  getGscConnection,
  getGscAccessToken,
  deleteGscConnection,
  updateGscProperty,
  querySearchAnalytics,
  submitSitemap,
  listSites,
  enrichKeywordsFromGsc,
  buildGscAuthUrl,
  signOAuthState,
  defaultDateRange,
  previousDateRange,
  GSC_RETENTION_DAYS,
  computeQueryDeltas,
  findLostQueries,
  revokeGoogleToken,
  inspectUrl,
  findCtrOpportunities,
  aggregateQueryPageRows,
  resolveGscPagePath,
  summarizeInspection,
  GscReconnectRequiredError,
  type SearchAnalyticsRow,
  type GscSite,
  type CtrOpportunity,
  type UrlInspectionSummary,
  type QueryDelta,
  type LostQuery,
} from "../services/google-search-console.server";
import {
  assignKeyword,
  normalizeKeyword,
  MAX_KEYWORD_LENGTH,
  type KeywordResourceType,
} from "../services/seo/keywords.service";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { resolvePathsToResources, isContentResourceType } from "../services/seo/url-resolver.server";
import {
  analyzeFreshness,
  excludeDismissed,
  freshnessDismissKey,
  type FreshnessResourceType,
} from "../services/seo/freshness.service";
import type { DataResponse } from "~/types/data-response";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

// Content-Freshness panel (PLAN_SEO_SUITE_COMPLETION.md §5.3): rendered here
// rather than as an expandable dashboard section — freshness IS a GSC
// crossmatch (rank position × traffic × shopifyUpdatedAt) and this tab
// already carries the GSC-connection chrome (pro-gate, connect/reconnect
// banners, resource resolution) that the feature depends on; growing the
// already-large item-scored Dashboard (a different mental model — 0-100
// scores, not position/CTR) would be the wrong home.
const FRESHNESS_PANEL_LIMIT = 50;

/** Serialized (Date -> ISO string) shape for the loader's JSON response. */
export interface FreshnessCandidateView {
  resourceType: FreshnessResourceType;
  resourceId: string;
  title: string;
  handle: string;
  position: number;
  ctr: number;
  impressions: number;
  shopifyUpdatedAt: string;
  daysSinceUpdate: number;
  priority: 1 | 2;
}

// Same shop-primary-domain lookup pattern as app.seo.aeo.tsx. Needed to (a)
// carry the shop's custom domain in the OAuth state so the callback can match
// it against verified GSC properties (pickProperty), and (b) build the FULL
// sitemap URL the sitemaps.submit API requires (GSC rejects relative paths).
const SHOP_DOMAIN_QUERY = `#graphql
  query seoSearchConsoleShopDomain {
    shop {
      primaryDomain { host }
    }
  }
`;

async function getShopPrimaryDomain(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_DOMAIN_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.primaryDomain?.host || fallbackShop;
  } catch {
    return fallbackShop;
  }
}

/**
 * Own-property lookup on a query-keyed map. Search queries are arbitrary user
 * text, and plenty of real words collide with `Object.prototype` members —
 * "constructor" is Spanish for builder, "__proto__" is what a scraped query can
 * look like. A bare `map[query] ?? fallback` then hands back an inherited
 * function instead of the fallback and the caller blows up on it.
 */
export function ownEntry<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** A Quick-win row enriched with the store resource its page URL resolves to
 *  (null when unresolvable) — drives the "Optimize" button's target. */
export interface QuickWinOpportunity extends CtrOpportunity {
  resourceType: KeywordResourceType | null;
  resourceId: string | null;
}

/**
 * Best-effort resolve each Quick-win row's underlying store resource
 * (Product/Collection/Page/Article), scoped to this shop, so the "Optimize"
 * button knows which resource to track a keyword against / deep-link to.
 * Thin wrapper around the shared `resolvePathsToResources`
 * (seo/url-resolver.server.ts, PLAN_SEO_SUITE_COMPLETION.md §1/§3.1 —
 * extracted from this exact function) so the batched handle-lookup can be
 * reused by the crawler without a second, drifting copy.
 */
async function resolveQuickWinResources(
  db: any,
  shop: string,
  opportunities: CtrOpportunity[],
): Promise<QuickWinOpportunity[]> {
  const resolved = await resolvePathsToResources(db, shop, opportunities.map((o) => o.page));
  return opportunities.map((opp) => {
    const r = resolved.get(opp.page);
    return {
      ...opp,
      // `isContentResourceType`, not just `r?.id`: a policy page resolves to a
      // real ShopPolicy id but is not a keyword target (no handle, no SEO
      // title). Leaving it null keeps the row on its item-picker fallback
      // instead of rendering an Optimize button the action rejects.
      resourceType: r?.id && isContentResourceType(r.resourceType) ? (r.resourceType as KeywordResourceType) : null,
      resourceId: r?.id && isContentResourceType(r.resourceType) ? r.id : null,
    };
  });
}

// Only lowercase alpha-3 (ISO-3166-1) is a valid GSC country expression; a
// device value must be one of the three GSC actually reports. Anything else
// is ignored (filter falls back to "all") rather than sent through and
// silently returning zero rows.
const GSC_COUNTRY_RE = /^[a-z]{3}$/i;
const GSC_DEVICES = ["DESKTOP", "MOBILE", "TABLET"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";
  const statusParam = url.searchParams.get("gsc") || null;

  const rawCountry = url.searchParams.get("gscCountry");
  const filterCountry = rawCountry && GSC_COUNTRY_RE.test(rawCountry) ? rawCountry.toLowerCase() : null;
  const rawDevice = url.searchParams.get("gscDevice")?.toUpperCase() || null;
  const filterDevice = rawDevice && (GSC_DEVICES as readonly string[]).includes(rawDevice) ? rawDevice : null;
  const analyticsFilters = {
    country: filterCountry ?? undefined,
    device: (filterDevice as "DESKTOP" | "MOBILE" | "TABLET" | undefined) ?? undefined,
  };

  const base = {
    gated: false,
    configured: false,
    connected: false,
    connectUrl: null as string | null,
    property: null as string | null,
    email: null as string | null,
    topQueries: [] as SearchAnalyticsRow[],
    opportunities: [] as QuickWinOpportunity[],
    // Period-over-period comparison (current 28d vs. the 28d before that) —
    // best-effort, see the second querySearchAnalytics call below.
    deltas: {} as Record<string, QueryDelta>,
    lostQueries: [] as LostQuery[],
    needsReconnect: false,
    needsPropertySelection: false,
    availableProperties: [] as GscSite[],
    error: null as string | null,
    statusParam,
    // Stamped by app/services/seo/gsc-auto-sync.service.ts (or a manual
    // "Sync keyword rankings" click) — trivially available on the connection
    // row already loaded below, so surfaced here for the auto-sync note.
    lastKeywordSyncAt: null as string | null,
    // Active country/device filters (from ?gscCountry/?gscDevice), echoed back
    // so the UI can pre-select the Select inputs from a shared/bookmarked URL.
    filterCountry,
    filterDevice,
    // Countries actually seen in this store's traffic (best-effort, unfiltered
    // query below) — populates the country Select's options.
    availableCountries: [] as Array<{ code: string; impressions: number }>,
    // Adopt flow (PLAN_KEYWORDS_EXPANSION.md §4): each shown query's
    // top-impression page URL (item suggestion for "track as keyword"), and
    // the queries already tracked as keywords (any locale) so their rows show
    // a "tracked" badge instead of the button.
    topPages: {} as Record<string, string>,
    // normalized query → the locales it is already tracked in ("" = primary).
    // Per LOCALE, not a flat list: a query tracked in German must still offer
    // the button for French, or the language picker is unreachable for it.
    trackedQueryLocales: {} as Record<string, string[]>,
    // Languages the adopt / quick-win flows may track a query under. A GSC
    // query carries NO language of its own, so silently writing it under the
    // primary locale is a guess — with more than one entry here the UI asks.
    // Same convention as SeoKeyword: the primary locale is the "" value.
    localeOptions: [] as Array<{ locale: string; name: string; primary: boolean }>,
    // Per-type item pickers for the adopt modal (unresolvable rows) — same
    // shape/cap as the keywords tab's add form.
    pickers: { Product: [], Collection: [], Article: [], Page: [] } as Record<
      KeywordResourceType,
      Array<{ id: string; title: string }>
    >,
    // Content-Freshness (PLAN_SEO_SUITE_COMPLETION.md §5.3) — best-effort,
    // computed from SeoGscPageStat (the daily-sync per-page rollup) rather
    // than a live GSC call, so it's populated independently of whether
    // today's manual queries below succeed.
    freshnessCandidates: [] as FreshnessCandidateView[],
  };

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) return json({ ...base, gated: true });

  if (!isGscConfigured()) return json(base);
  base.configured = true;

  // Only fetched when we're actually about to build a connect/reconnect URL —
  // avoids an extra Admin GraphQL call on every load of an already-connected,
  // healthy section.
  const buildConnect = async () => {
    const primaryHost = await getShopPrimaryDomain(admin, session.shop);
    const customDomain = primaryHost !== session.shop ? primaryHost : null;
    return buildGscAuthUrl(signOAuthState({ shop: session.shop, host, customDomain }));
  };

  const connection = await getGscConnection(db, session.shop);
  if (!connection) {
    return json({ ...base, connectUrl: await buildConnect() });
  }

  base.connected = true;
  // Locale picker options for the adopt / quick-win modals. A failed lookup
  // resolves with [] (never gate on it — CLAUDE.md): the picker then lists only
  // the primary locale, i.e. exactly the pre-existing behaviour, instead of
  // blocking the tracking buttons.
  {
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const primaryLocale = shopLocales.find((l: any) => l.primary);
    base.localeOptions = [
      { locale: "", name: String(primaryLocale?.name || primaryLocale?.locale || ""), primary: true },
      ...shopLocales
        .filter((l: any) => !l.primary && l.published)
        .map((l: any) => ({ locale: String(l.locale), name: String(l.name || l.locale), primary: false })),
    ];
  }
  base.property = connection.propertyUrl || null;
  base.email = connection.email;
  base.lastKeywordSyncAt = connection.lastKeywordSyncAt ? connection.lastKeywordSyncAt.toISOString() : null;

  // Content-Freshness (§5.3) — DB-only (SeoGscPageStat × content caches), no
  // live GSC call, so compute it even if the property-selection branch below
  // returns early, and even if the live analytics calls further down fail.
  // Best-effort: any DB error here just leaves the panel empty.
  try {
    const settingsRow = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { seoFreshnessDismissed: true },
    });
    const dismissed = Array.isArray(settingsRow?.seoFreshnessDismissed)
      ? (settingsRow!.seoFreshnessDismissed as string[])
      : [];
    const freshness = await analyzeFreshness(session.shop, { db });
    base.freshnessCandidates = excludeDismissed(freshness.candidates, dismissed)
      .slice(0, FRESHNESS_PANEL_LIMIT)
      .map((c) => ({
        resourceType: c.resourceType,
        resourceId: c.resourceId,
        title: c.title,
        handle: c.handle,
        position: c.position,
        ctr: c.ctr,
        impressions: c.impressions,
        shopifyUpdatedAt: c.shopifyUpdatedAt.toISOString(),
        daysSinceUpdate: c.daysSinceUpdate,
        priority: c.priority,
      }));
  } catch {
    base.freshnessCandidates = [];
  }

  if (!connection.propertyUrl) {
    // OAuth succeeded but no verified property matched the shop's myshopify or
    // custom domain (see pickProperty) — the connection was stored with the ""
    // sentinel. Fetch the merchant's verified properties so the UI can render
    // a picker instead of guessing.
    try {
      const { accessToken } = await getGscAccessToken(db, session.shop);
      base.needsPropertySelection = true;
      base.availableProperties = await listSites(accessToken);
    } catch (e) {
      if (e instanceof GscReconnectRequiredError) {
        base.needsReconnect = true;
        base.connectUrl = await buildConnect();
      } else {
        base.error = "fetch_failed";
      }
    }
    return json(base);
  }

  try {
    const { accessToken, propertyUrl } = await getGscAccessToken(db, session.shop);
    // Lookback window is a plan entitlement (§Plan-Matrix): Pro sees the
    // rolling 28 days, Max the ~16 months the GSC API itself retains. The
    // period-over-period comparison below uses the SAME width, so the deltas
    // stay like-for-like on either plan.
    const historyDays = getGscHistoryDays(plan);
    // The period-over-period comparison needs TWO consecutive windows of the
    // same width to fit inside GSC's ~16-month retention. At Max's 480 days
    // the previous window would start ~32 months back — outside retention, so
    // GSC returns nothing and deltas/lost queries silently vanish on the tier
    // that pays for history. Cap the COMPARISON width (not the main window) at
    // half the retention.
    const comparisonDays = Math.min(historyDays, Math.floor(GSC_RETENTION_DAYS / 2));
    const { startDate, endDate } = defaultDateRange(new Date(), historyDays);
    // ONE (query, page)-dimensioned call feeds BOTH the Top-queries table
    // (aggregated per query via aggregateQueryPageRows) and the Quick-wins
    // detection (raw rows) — saving the previously separate query-dimensioned
    // call (PLAN_KEYWORDS_EXPANSION.md §4.4). rowLimit 5000 (not 1000): the
    // page dimension fans each query out over its ranking pages, so the same
    // query coverage needs more rows; lost-query detection below must see the
    // FULL current query set — comparing the previous period against just the
    // top 25 would flag every query currently ranked 26+ as "lost".
    const pageRows = await querySearchAnalytics(accessToken, propertyUrl, {
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit: 5000,
      filters: analyticsFilters,
    });
    const aggregated = aggregateQueryPageRows(pageRows);
    const currentRows = aggregated.queries;
    base.topQueries = currentRows.slice(0, 25);
    // Item suggestion for the adopt button — only the 25 shown rows need one.
    for (const row of base.topQueries) {
      const q = (row.keys[0] ?? "").toLowerCase();
      const page = aggregated.topPageByQuery.get(q);
      if (page) base.topPages[q] = page;
    }

    // Period-over-period comparison: the window immediately before the one
    // above, capped to comparisonDays so both halves stay inside GSC retention. Best-effort — any failure here just leaves
    // deltas/lostQueries empty; the table renders exactly as before.
    // SAME (query,page) dimensions + SAME aggregation as the current period
    // (review M5): comparing our impression-weighted positions against GSC's
    // query-dimension positions would fabricate position deltas for every
    // query that ranks on more than one page.
    try {
      const prevRange = previousDateRange(new Date(), comparisonDays);
      const previousPageRows = await querySearchAnalytics(accessToken, propertyUrl, {
        startDate: prevRange.startDate,
        endDate: prevRange.endDate,
        dimensions: ["query", "page"],
        rowLimit: 5000,
        filters: analyticsFilters,
      });
      const previousRows = aggregateQueryPageRows(previousPageRows).queries;
      base.deltas = Object.fromEntries(computeQueryDeltas(base.topQueries, previousRows));
      base.lostQueries = findLostQueries(currentRows, previousRows);
    } catch {
      base.deltas = {};
      base.lostQueries = [];
    }

    // "Quick wins" reuse the same raw rows — no extra GSC call.
    base.opportunities = await resolveQuickWinResources(db, session.shop, findCtrOpportunities(pageRows));

    // "Tracked" badges: which of the shown queries are already tracked as
    // keywords (any locale). Best-effort — a DB error only loses the badges.
    try {
      const shownQueries = Array.from(
        new Set(
          [...base.topQueries.map((r) => r.keys[0] ?? ""), ...base.opportunities.map((o) => o.query)]
            .map((q) => normalizeKeyword(q))
            .filter(Boolean),
        ),
      );
      if (shownQueries.length) {
        const tracked = await db.seoKeyword.findMany({
          where: { shop: session.shop, keyword: { in: shownQueries } },
          select: { keyword: true, locale: true },
        });
        // A Map, not a plain object: a query like "constructor" (a real word in
        // several languages) would resolve to an inherited Object.prototype
        // member, so `byQuery[q] ||= []` would never assign and the push below
        // would throw — silently costing every badge via the catch.
        const byQuery = new Map<string, string[]>();
        for (const t of tracked as Array<{ keyword: string; locale: string }>) {
          const bucket = byQuery.get(t.keyword) ?? [];
          if (!bucket.includes(t.locale)) bucket.push(t.locale);
          byQuery.set(t.keyword, bucket);
        }
        base.trackedQueryLocales = Object.fromEntries(byQuery);
      }
    } catch {
      base.trackedQueryLocales = {};
    }

    // Item pickers for the adopt modal (unresolvable rows) — same cap/order
    // as the keywords tab. Best-effort: without them the modal shows empty
    // lists but the page still works.
    try {
      const [products, collections, articles, pages] = await Promise.all([
        db.product.findMany({ where: { shop: session.shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 250 }),
        db.collection.findMany({ where: { shop: session.shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 250 }),
        db.article.findMany({ where: { shop: session.shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 250 }),
        db.page.findMany({ where: { shop: session.shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 250 }),
      ]);
      base.pickers = { Product: products, Collection: collections, Article: articles, Page: pages };
    } catch {
      // keep empty pickers
    }

    // Country options for the filter Select: the countries actually present in
    // this store's traffic, UNFILTERED (so switching the device filter doesn't
    // narrow which countries you can then pick). Best-effort, same reasoning as
    // Quick wins above — only fired once the main call proved token/property ok.
    try {
      base.availableCountries = (
        await querySearchAnalytics(accessToken, propertyUrl, {
          startDate,
          endDate,
          dimensions: ["country"],
          rowLimit: 15,
        })
      )
        .map((r) => ({ code: r.keys[0] ?? "", impressions: r.impressions }))
        .filter((c) => c.code);
    } catch {
      base.availableCountries = [];
    }
  } catch (e) {
    if (e instanceof GscReconnectRequiredError) {
      base.needsReconnect = true;
      base.connectUrl = await buildConnect();
    } else {
      base.error = "fetch_failed";
    }
  }

  return json(base);
};

type ActionResult =
  | { ok: true; kind: "disconnected" | "synced" | "sitemap" | "propertySelected"; count?: number }
  | { ok: true; kind: "inspected"; inspection: UrlInspectionSummary }
  | { ok: true; kind: "quickWinTracked" }
  // adoptKeyword: the tracked query, echoed back so the client can badge the
  // right row (the fetcher response itself carries no row identity).
  | { ok: true; kind: "keywordAdopted"; query: string }
  // adoptKeyword could not map the row's page to a store item — the client
  // opens the item-picker modal and re-submits with an explicit resource.
  | { ok: false; error: "unresolved"; query: string }
  | { ok: true; kind: "freshnessDismissed"; key: string }
  | { ok: false; error: string };

const QUICK_WIN_RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

/** Editor list route per resource type — same mapping as app.seo.keywords.tsx's
 *  KEYWORD_TYPE_PATH (kept local here: two small maps, not worth sharing a
 *  cross-route import for). */
const QUICK_WIN_TYPE_PATH: Record<string, string> = {
  Product: "/app/products",
  Collection: "/app/collections",
  Article: "/app/blog",
  Page: "/app/pages",
};

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "disconnect") {
    // Best-effort revoke at Google before dropping the local row — the
    // merchant's "disconnect" intent must succeed locally even if Google is
    // unreachable (revokeGoogleToken never throws), but we shouldn't leave a
    // live grant at Google when the merchant explicitly asked to disconnect.
    const connection = await getGscConnection(db, session.shop);
    if (connection) {
      const refresh = tryDecryptApiKey(connection.refreshToken, "gsc-refresh-token");
      if (refresh) await revokeGoogleToken(refresh);
    }
    await deleteGscConnection(db, session.shop);
    return json<ActionResult>({ ok: true, kind: "disconnected" });
  }

  if (actionType === "sync") {
    try {
      const count = await enrichKeywordsFromGsc(db, session.shop, new Date());
      return json<ActionResult>({ ok: true, kind: "synced", count });
    } catch (e) {
      const reason = e instanceof GscReconnectRequiredError ? "reconnect" : "sync_failed";
      return json<ActionResult>({ ok: false, error: reason }, { status: 400 });
    }
  }

  if (actionType === "submitSitemap") {
    try {
      const { accessToken, propertyUrl } = await getGscAccessToken(db, session.shop);
      // The sitemaps.submit API needs the sitemap's FULL absolute URL, not a
      // relative path — this holds even for sc-domain: properties (the
      // sitemap file itself is always served from the store's https host).
      const domain = await getShopPrimaryDomain(admin, session.shop);
      const sitemapUrl = `https://${domain}/sitemap.xml`;
      await submitSitemap(accessToken, propertyUrl, sitemapUrl);
      return json<ActionResult>({ ok: true, kind: "sitemap" });
    } catch (e) {
      const reason = e instanceof GscReconnectRequiredError ? "reconnect" : "sitemap_failed";
      return json<ActionResult>({ ok: false, error: reason }, { status: 400 });
    }
  }

  if (actionType === "selectProperty") {
    const propertyUrl = getFormString(form, "propertyUrl");
    if (!propertyUrl) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await updateGscProperty(db, session.shop, propertyUrl);
    return json<ActionResult>({ ok: true, kind: "propertySelected" });
  }

  if (actionType === "inspectUrl") {
    const rawUrl = getFormString(form, "url").trim();
    if (!rawUrl) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    try {
      const { accessToken, propertyUrl } = await getGscAccessToken(db, session.shop);
      // A bare path (e.g. "/products/foo") has no host of its own — sc-domain:
      // properties aren't a fetchable origin, so prefix the shop's primary
      // domain (same resolution the sitemap submit uses) when the merchant
      // didn't paste a full URL.
      let inspectionUrl = rawUrl;
      if (!/^https?:\/\//i.test(inspectionUrl)) {
        const domain = await getShopPrimaryDomain(admin, session.shop);
        inspectionUrl = `https://${domain}${inspectionUrl.startsWith("/") ? "" : "/"}${inspectionUrl}`;
      }
      const result = await inspectUrl(accessToken, propertyUrl, inspectionUrl);
      return json<ActionResult>({ ok: true, kind: "inspected", inspection: summarizeInspection(result) });
    } catch (e) {
      const reason = e instanceof GscReconnectRequiredError ? "reconnect" : "inspect_failed";
      return json<ActionResult>({ ok: false, error: reason }, { status: 400 });
    }
  }

  // Content-Freshness "Ignorieren" (§5.3/§5.5): simplest-correct dismissed
  // store — a JSON array of "<resourceType>:<resourceId>" keys on the
  // existing per-shop AISettings row (see schema.prisma comment). No new
  // model: no history/reporting need of its own, and it rides along on a
  // row that's already purged on shop/redact.
  if (actionType === "dismissFreshness") {
    const resourceType = getFormString(form, "resourceType") as FreshnessResourceType | "";
    const resourceId = getFormString(form, "resourceId");
    if (!resourceType || !QUICK_WIN_RESOURCE_TYPES.includes(resourceType) || !resourceId) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const key = freshnessDismissKey(resourceType, resourceId);
    const settingsRow = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { seoFreshnessDismissed: true },
    });
    const existing = Array.isArray(settingsRow?.seoFreshnessDismissed)
      ? (settingsRow!.seoFreshnessDismissed as string[])
      : [];
    if (!existing.includes(key)) {
      // updateMany (not update-by-unique-key): mirrors the `stamp()` pattern
      // in gsc-auto-sync.service.ts — a no-op on zero matched rows instead of
      // throwing P2025 in the (should-never-happen) case AISettings doesn't
      // exist yet for this shop.
      await db.aISettings.updateMany({
        where: { shop: session.shop },
        data: { seoFreshnessDismissed: [...existing, key] },
      });
    }
    return json<ActionResult>({ ok: true, kind: "freshnessDismissed", key });
  }

  /**
   * The locale a "track this query" write should use. A GSC query has no
   * language of its own, so the UI asks whenever the shop has more than one —
   * this validates the answer with the same rule as every other keyword write
   * path ("" = primary, everything else must be a PUBLISHED secondary).
   *
   * Returns "" when the form carries no locale field at all (single-language
   * shops keep their one-click flow) and `null` when the posted value is not a
   * locale of this shop — the caller answers 400 rather than writing a keyword
   * under a language the merchant cannot see.
   */
  async function resolveTrackLocale(formData: FormData): Promise<string | null> {
    const raw = formData.get("locale");
    if (raw === null) return "";
    const value = String(raw);
    if (!value) return "";
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const isPublishedSecondary = shopLocales.some(
      (l: any) => !l.primary && l.published && l.locale === value,
    );
    return isPublishedSecondary ? value : null;
  }

  if (actionType === "trackQuickWin") {
    const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
    const resourceId = getFormString(form, "resourceId");
    const query = getFormString(form, "query");
    if (
      !QUICK_WIN_RESOURCE_TYPES.includes(resourceType) ||
      !resourceId ||
      !query.trim() ||
      query.trim().length > MAX_KEYWORD_LENGTH
    ) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // The language is the merchant's choice, not an assumption: the UI sends
    // the locale it asked for (multi-language shops) and "" for the primary
    // locale. Validated against the shop's published secondaries, like every
    // other keyword write path.
    const locale = await resolveTrackLocale(form);
    if (locale === null) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Don't overwrite an existing primary: the merchant may have deliberately
    // chosen a different target keyword for this resource already, and a
    // one-click "optimize" shouldn't clobber that — assignKeyword without
    // demoteExisting returns `primaryExists` instead of writing, which we treat
    // as "already tracked, fine". A full item at the keyword cap (`tooMany`) is
    // equally fine to skip silently here.
    await assignKeyword(db, session.shop, {
      resourceType,
      resourceId,
      keyword: query,
      locale,
      role: "primary",
    });
    return json<ActionResult>({ ok: true, kind: "quickWinTracked" });
  }

  // 1-click adopt from the Top-queries / Quick-wins tables
  // (PLAN_KEYWORDS_EXPANSION.md §4.2). Target resolution order: an explicit
  // resource (item-picker modal) wins; otherwise the row's page URL is
  // resolved via handle. Role: primary preferred, automatic fallback to
  // secondary when the item already has a primary — a 1-click flow must not
  // clobber a deliberate choice, but should still capture the keyword.
  if (actionType === "adoptKeyword") {
    const query = getFormString(form, "query").trim();
    if (!query || query.length > MAX_KEYWORD_LENGTH) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }

    let resourceType = getFormString(form, "resourceType") as KeywordResourceType | "";
    let resourceId = getFormString(form, "resourceId");

    // An explicitly posted language (the modal's picker) always wins; the URL
    // prefix below only fills in for a one-click track on a single-language
    // shop, where it is a hint rather than a competing choice.
    const localeExplicit = form.get("locale") !== null;
    let locale = await resolveTrackLocale(form);
    if (locale === null) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }

    if (!resourceType || !resourceId) {
      // Resolve the row's page URL → handle → cached item. The locale prefix
      // (e.g. /fr/products/…) becomes the keyword's locale SUGGESTION —
      // GSC queries carry no locale, but a French query ranking on the FR
      // page should be tracked against the FR edition (§4.2 Locale-Hinweis).
      const page = getFormString(form, "page");
      const resolved = page ? resolveGscPagePath(page) : null;
      // "Policy" is a resolvable storefront page (the crawl report deep-links
      // it) but not a keyword TARGET: ShopPolicy has no handle, no SEO title
      // and no meta description to optimize against. Left unresolved on
      // purpose, which routes the row into the existing item-picker modal.
      if (resolved && resolved.resourceType !== "Policy") {
        try {
          const model =
            resolved.resourceType === "Product"
              ? db.product
              : resolved.resourceType === "Collection"
                ? db.collection
                : resolved.resourceType === "Page"
                  ? db.page
                  : db.article;
          const item = await (model as any).findFirst({
            where: { shop: session.shop, handle: resolved.handle },
            select: { id: true },
          });
          if (item) {
            resourceType = resolved.resourceType;
            resourceId = item.id;
            if (resolved.locale && !localeExplicit) {
              const shopLocales = await getCachedShopLocales(admin, session.shop);
              const match = shopLocales.find(
                (l: any) => !l.primary && l.published && String(l.locale).toLowerCase() === resolved.locale,
              );
              // Store the shop's OWN casing (e.g. "pt-BR"), not the URL's — the
              // locale is a lookup key everywhere else in the keyword tables.
              if (match) locale = String(match.locale);
            }
          }
        } catch {
          // fall through to "unresolved" below
        }
      }
      if (!resourceType || !resourceId) {
        return json<ActionResult>({ ok: false, error: "unresolved", query }, { status: 422 });
      }
    } else if (!QUICK_WIN_RESOURCE_TYPES.includes(resourceType as KeywordResourceType)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }

    // GSC metrics from the row the merchant clicked — stamped onto the
    // assignment immediately (§4.2 step 3), no waiting for the next sync.
    const num = (name: string): number | null => {
      const raw = getFormString(form, name);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const gsc = {
      position: num("gscPosition"),
      clicks: num("gscClicks"),
      impressions: num("gscImpressions"),
      ctr: num("gscCtr"),
      updatedAt: new Date(),
    };

    const first = await assignKeyword(db, session.shop, {
      resourceType: resourceType as KeywordResourceType,
      resourceId,
      keyword: query,
      locale,
      role: "primary",
      gsc,
    });
    if (first.ok) return json<ActionResult>({ ok: true, kind: "keywordAdopted", query });
    if (first.reason === "primaryExists") {
      const second = await assignKeyword(db, session.shop, {
        resourceType: resourceType as KeywordResourceType,
        resourceId,
        keyword: query,
        locale,
        role: "secondary",
        gsc,
      });
      if (second.ok) return json<ActionResult>({ ok: true, kind: "keywordAdopted", query });
      return json<ActionResult>({ ok: false, error: "tooMany" }, { status: 409 });
    }
    return json<ActionResult>({ ok: false, error: "tooMany" }, { status: 409 });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

export default function SeoSearchConsole() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const g = t.seo.searchConsolePage;
  const fetcher = useFetcher<ActionResult>();
  const [, setSearchParams] = useSearchParams();

  // Export fetchers: one per table (Top Queries, Quick Wins)
  const topQueriesExportFetcher = useFetcher<ExportPayload>();
  const quickWinsExportFetcher = useFetcher<ExportPayload>();

  // Guards so one export click yields exactly one download. Keyed on the
  // fetcher.data object identity (each load produces a fresh object) — a
  // filename/rowCount key would wrongly suppress a re-export whose filtered
  // result happens to have the same row count.
  const consumedTopQueriesExport = useRef<ExportPayload | null>(null);
  const consumedQuickWinsExport = useRef<ExportPayload | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Country/device filters: reflected in the URL (?gscCountry/?gscDevice) so the
  // loader re-runs with the new filter and the choice survives a reload/share.
  // Other params (host, gsc status, etc.) are preserved via the prev-params spread.
  const setGscFilterParam = (key: "gscCountry" | "gscDevice", value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { preventScrollReset: true },
    );
  };
  // Property picker (only relevant when data.needsPropertySelection is true).
  const [selectedProperty, setSelectedProperty] = useState(data.availableProperties[0]?.siteUrl || "");
  // Separate fetcher for the Inspect URL card so its result doesn't get mixed
  // into (or cleared by) the disconnect/sync/sitemap/property actionMsg banner.
  const inspectFetcher = useFetcher<ActionResult>();
  const [inspectValue, setInspectValue] = useState("");

  // Quick wins "Optimize" button: its own fetcher so the disconnect/sync/
  // sitemap/property actionMsg banner above isn't clobbered by this action.
  const { handleNavigate } = useAppNavigation();
  const quickWinFetcher = useFetcher<ActionResult>();
  const [optimizingResourceId, setOptimizingResourceId] = useState<string | null>(null);
  // The row being submitted, remembered across the fetcher round-trip so the
  // success effect below knows which editor to deep-link into (the fetcher's
  // own response carries no row identity back).
  const optimizeTargetRef = useRef<{ resourceType: string; resourceId: string } | null>(null);

  const submitQuickWin = (
    row: { resourceType: string; resourceId: string; query: string },
    locale: string,
  ) => {
    optimizeTargetRef.current = { resourceType: row.resourceType, resourceId: row.resourceId };
    setOptimizingResourceId(row.resourceId);
    quickWinFetcher.submit(
      {
        actionType: "trackQuickWin",
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        query: row.query,
        locale,
      },
      { method: "post" },
    );
  };

  /** Optimize = track the query as this item's keyword, then open the editor.
   *  On a multi-language shop the language is asked for first — a GSC query
   *  carries none, and guessing the primary one is how keywords ended up in the
   *  wrong language. Single-language shops keep the one-click flow. */
  const handleOptimize = (row: {
    resourceType: string;
    resourceId: string;
    query: string;
    page?: string;
  }) => {
    if (hasMultipleLocales) {
      setAdoptError(null);
      setAdoptModal({
        mode: "quickWin",
        query: row.query,
        gsc: {},
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        locale: guessLocaleFromPage(row.page),
      });
      return;
    }
    submitQuickWin(row, "");
  };

  useEffect(() => {
    if (quickWinFetcher.state !== "idle" || !quickWinFetcher.data) return;
    setOptimizingResourceId(null);
    if (quickWinFetcher.data.ok && quickWinFetcher.data.kind === "quickWinTracked") {
      const target = optimizeTargetRef.current;
      optimizeTargetRef.current = null;
      if (target) {
        const path = QUICK_WIN_TYPE_PATH[target.resourceType];
        if (path) handleNavigate(path, { searchParams: new URLSearchParams({ select: target.resourceId }) });
      }
    }
  }, [quickWinFetcher.state, quickWinFetcher.data, handleNavigate]);

  // ── Content-Freshness panel (PLAN_SEO_SUITE_COMPLETION.md §5.3) ──
  // Own fetcher so the disconnect/sync/sitemap banner above isn't clobbered.
  const freshnessDismissFetcher = useFetcher<ActionResult>();
  const [dismissingFreshnessKey, setDismissingFreshnessKey] = useState<string | null>(null);
  // Dismissed in THIS session — hides the row instantly without waiting for a
  // reload; the loader's persisted dismissed-list covers earlier sessions.
  const [locallyDismissedFreshness, setLocallyDismissedFreshness] = useState<Set<string>>(new Set());

  const handleDismissFreshness = (resourceType: string, resourceId: string) => {
    setDismissingFreshnessKey(`${resourceType}:${resourceId}`);
    freshnessDismissFetcher.submit({ actionType: "dismissFreshness", resourceType, resourceId }, { method: "post" });
  };

  useEffect(() => {
    const result = freshnessDismissFetcher.data;
    if (freshnessDismissFetcher.state !== "idle" || !result) return;
    setDismissingFreshnessKey(null);
    if (result.ok && result.kind === "freshnessDismissed") {
      setLocallyDismissedFreshness((prev) => new Set(prev).add(result.key));
    }
  }, [freshnessDismissFetcher.state, freshnessDismissFetcher.data]);

  // "Mit AI überarbeiten": deep-link into the item's own editor, preselected
  // (?select=<GID>) with a refresh preset (?preset=refresh) — reuses the same
  // QUICK_WIN_TYPE_PATH resource→route map the Quick-wins "Optimize" button
  // uses. Deliberately NOT a new AI-instructions plumbing/template system
  // (PLAN_SEO_SUITE_COMPLETION.md §5.3 explicitly rules that out) — the target
  // editor route reads `preset=refresh` and shows a freshness hint banner.
  const handleRefreshWithAi = (resourceType: string, resourceId: string) => {
    const path = QUICK_WIN_TYPE_PATH[resourceType];
    if (path) {
      handleNavigate(path, { searchParams: new URLSearchParams({ select: resourceId, preset: "refresh" }) });
    }
  };

  const visibleFreshnessCandidates = data.freshnessCandidates.filter(
    (c) => !locallyDismissedFreshness.has(`${c.resourceType}:${c.resourceId}`),
  );

  // ── "Track as keyword" adopt flow (PLAN_KEYWORDS_EXPANSION.md §4) ──
  // Own fetcher so the disconnect/sync/sitemap banner isn't clobbered.
  const adoptFetcher = useFetcher<ActionResult>();
  // Queries adopted in THIS session, as `<query>::<locale>` — flips the row to
  // its "tracked" badge without a reload; the loader's trackedQueryLocales
  // covers earlier sessions. Keyed per locale for the same reason.
  const [adoptedQueries, setAdoptedQueries] = useState<Set<string>>(new Set());
  const [adoptingQuery, setAdoptingQuery] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  // The track modal. Two jobs: pick the LANGUAGE the query is tracked under
  // (whenever the shop has more than one — a GSC query carries none), and pick
  // the item for rows whose page URL couldn't be resolved. Carries the row's
  // GSC metrics along so the submit still stamps them.
  const [adoptModal, setAdoptModal] = useState<{
    /** "adopt" writes a tracked keyword; "quickWin" also opens the editor. */
    mode: "adopt" | "quickWin";
    query: string;
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number };
    /** Page URL to resolve the item from — absent means the picker is required. */
    page?: string;
    /** Quick-win rows (and a re-submit after the picker) know their item. */
    resourceType?: string;
    resourceId?: string;
    locale: string;
  } | null>(null);
  const [adoptType, setAdoptType] = useState<KeywordResourceType>("Product");
  const [adoptItemId, setAdoptItemId] = useState("");
  const [adoptItemInput, setAdoptItemInput] = useState("");
  // The click's row data, remembered across the fetcher round-trip — an
  // "unresolved" response carries only the query back, so the modal gets the
  // GSC metrics from here.
  const pendingAdoptRef = useRef<{
    query: string;
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number };
    locale: string;
  } | null>(null);

  /** Languages this query is already tracked in (stored + this session). */
  const trackedLocalesFor = (query: string): string[] => {
    const q = normalizeKeyword(query);
    const stored = ownEntry(data.trackedQueryLocales, q) ?? [];
    const session = Array.from(adoptedQueries)
      .filter((entry) => entry.startsWith(`${q}::`))
      .map((entry) => entry.slice(q.length + 2));
    return Array.from(new Set([...stored, ...session]));
  };

  const isQueryTracked = (query: string) => trackedLocalesFor(query).length > 0;

  /** More than one language to choose from ⇒ never guess one. */
  const hasMultipleLocales = data.localeOptions.length > 1;

  /** Is there still a language this query could be tracked for? On a
   *  single-language shop this collapses to "not tracked yet" — the previous
   *  behaviour. On a multi-language shop a German-tracked query keeps its
   *  button so it can also be tracked for French. */
  const hasUntrackedLocale = (query: string): boolean => {
    const tracked = trackedLocalesFor(query);
    if (data.localeOptions.length === 0) return tracked.length === 0;
    return data.localeOptions.some((l) => !tracked.includes(l.locale));
  };

  /** Pre-select the language from the row's page URL prefix (/fr/products/…)
   *  when it names a published secondary — the same hint the server applies to
   *  a one-click track, just made visible and overridable. */
  const guessLocaleFromPage = (page?: string): string => {
    if (!page) return "";
    let path = page;
    try {
      path = new URL(page).pathname;
    } catch {
      // Not an absolute URL — treat the value as a path already.
    }
    const first = path.split("/").filter(Boolean)[0]?.toLowerCase();
    if (!first) return "";
    const match = data.localeOptions.find((l) => !l.primary && l.locale.toLowerCase() === first);
    return match ? match.locale : "";
  };

  const submitAdopt = (
    query: string,
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number },
    target: { page?: string } | { resourceType: string; resourceId: string },
    locale: string,
  ) => {
    setAdoptingQuery(query);
    setAdoptError(null);
    pendingAdoptRef.current = { query, gsc, locale };
    const payload: Record<string, string> = { actionType: "adoptKeyword", query, locale };
    if ("page" in target && target.page) payload.page = target.page;
    if ("resourceId" in target) {
      payload.resourceType = target.resourceType;
      payload.resourceId = target.resourceId;
    }
    if (gsc.position != null) payload.gscPosition = String(gsc.position);
    if (gsc.clicks != null) payload.gscClicks = String(gsc.clicks);
    if (gsc.impressions != null) payload.gscImpressions = String(gsc.impressions);
    if (gsc.ctr != null) payload.gscCtr = String(gsc.ctr);
    adoptFetcher.submit(payload, { method: "post" });
  };

  /** Row click. Single-language shop with a resolvable page: one click, as
   *  before. Otherwise the modal opens — to pick the language, the item, or
   *  both. */
  const handleTrackClick = (
    query: string,
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number },
    page?: string,
  ) => {
    if (page && !hasMultipleLocales) {
      submitAdopt(query, gsc, { page }, "");
      return;
    }
    setAdoptError(null);
    setAdoptModal({ mode: "adopt", query, gsc, page, locale: guessLocaleFromPage(page) });
  };

  useEffect(() => {
    if (adoptFetcher.state !== "idle" || !adoptFetcher.data) return;
    const res = adoptFetcher.data;
    setAdoptingQuery(null);
    if (res.ok && res.kind === "keywordAdopted") {
      const adoptedLocale = pendingAdoptRef.current?.locale ?? "";
      pendingAdoptRef.current = null;
      setAdoptedQueries((prev) => new Set(prev).add(`${normalizeKeyword(res.query)}::${adoptedLocale}`));
      setAdoptModal(null);
      setAdoptItemId("");
      setAdoptItemInput("");
      return;
    }
    if (!res.ok && res.error === "unresolved" && "query" in res) {
      // No store item found for the row's page — let the merchant pick one.
      // `page` is dropped so the modal switches to the (now required) picker;
      // the language already chosen survives.
      const pending = pendingAdoptRef.current;
      setAdoptModal((prev) => ({
        mode: "adopt",
        query: res.query,
        gsc: pending && pending.query === res.query ? pending.gsc : {},
        locale: prev?.locale ?? "",
      }));
      return;
    }
    if (!res.ok) setAdoptError(res.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptFetcher.state, adoptFetcher.data]);

  // The item picker only appears when the target is still unknown: quick-win
  // rows carry their item, and an adopt row with a page URL is resolved
  // server-side (the picker appears on its "unresolved" answer).
  const needsItemPicker = !!adoptModal && !adoptModal.page && !adoptModal.resourceId;

  const adoptModalOptions = (data.pickers[adoptType] ?? []).map((i) => ({
    label: i.title || i.id,
    value: i.id,
  }));
  const filteredAdoptOptions = (() => {
    const q = adoptItemInput.trim().toLowerCase();
    if (!q) return adoptModalOptions;
    return adoptModalOptions.filter((o) => o.label.toLowerCase().includes(q));
  })();

  // Top Queries CSV export
  useEffect(() => {
    if (topQueriesExportFetcher.state !== "idle" || !topQueriesExportFetcher.data) return;
    if (consumedTopQueriesExport.current === topQueriesExportFetcher.data) return;
    consumedTopQueriesExport.current = topQueriesExportFetcher.data;
    // Error responses (gated/reconnect/export_failed) also land in fetcher.data
    // — without this guard we'd Blob-download a file containing "undefined".
    if ("error" in topQueriesExportFetcher.data) {
      setExportError(topQueriesExportFetcher.data.error);
      return;
    }
    setExportError(null);

    const blob = new Blob([topQueriesExportFetcher.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = topQueriesExportFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [topQueriesExportFetcher.state, topQueriesExportFetcher.data]);

  // Quick Wins CSV export
  useEffect(() => {
    if (quickWinsExportFetcher.state !== "idle" || !quickWinsExportFetcher.data) return;
    if (consumedQuickWinsExport.current === quickWinsExportFetcher.data) return;
    consumedQuickWinsExport.current = quickWinsExportFetcher.data;
    if ("error" in quickWinsExportFetcher.data) {
      setExportError(quickWinsExportFetcher.data.error);
      return;
    }
    setExportError(null);

    const blob = new Blob([quickWinsExportFetcher.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = quickWinsExportFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [quickWinsExportFetcher.state, quickWinsExportFetcher.data]);

  const actionMsg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (fetcher.data.ok) {
      if (fetcher.data.kind === "synced") {
        return { tone: "success" as const, msg: g.synced.replace("{count}", String(fetcher.data.count ?? 0)) };
      }
      if (fetcher.data.kind === "sitemap") return { tone: "success" as const, msg: g.sitemapSubmitted };
      if (fetcher.data.kind === "disconnected") return { tone: "info" as const, msg: g.disconnected };
      if (fetcher.data.kind === "propertySelected") {
        return { tone: "success" as const, msg: g.propertySaved };
      }
    } else {
      const map: Record<string, string> = {
        reconnect: g.errorReconnect,
        sync_failed: g.errorGeneric,
        sitemap_failed: g.errorGeneric,
        gated: g.errorGeneric,
      };
      return { tone: "critical" as const, msg: map[fetcher.data.error] || g.errorGeneric };
    }
    return null;
  })();

  return (
    <SeoSectionLayout sectionId="searchConsole">
      <BlockStack gap="400">
        <SeoHelpBanner title={g.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{g.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{g.helpBody2}</Text>
          </BlockStack>
        </SeoHelpBanner>

        {/* Status from the OAuth bounce-back */}
        {data.statusParam === "connected" && <Banner tone="success">{g.connectedBanner}</Banner>}
        {data.statusParam === "denied" && <Banner tone="warning">{g.deniedBanner}</Banner>}
        {data.statusParam === "select_property" && (
          <Banner tone="info">{g.selectPropertyBanner}</Banner>
        )}
        {(data.statusParam === "error" || data.statusParam === "no_sites" || data.statusParam === "no_refresh_token") && (
          <Banner tone="critical">{g.connectErrorBanner}</Banner>
        )}
        {actionMsg && <Banner tone={actionMsg.tone}>{actionMsg.msg}</Banner>}
        {exportError && (
          <Banner tone="critical" onDismiss={() => setExportError(null)}>
            {exportError === "reconnect" ? g.errorReconnect : g.errorGeneric}
          </Banner>
        )}

        {!data.configured && !data.gated ? (
          <Card>
            <div style={{ padding: "1rem" }}>
              <Text as="p" tone="subdued">
                {g.notConfigured}
              </Text>
            </div>
          </Card>
        ) : data.gated ? null /* SeoSectionLayout renders the Pro upsell */ : !data.connected ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {g.connectTitle}
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                {g.connectBody}
              </Text>
              {data.connectUrl && (
                <InlineStack>
                  {/* target=_top: take the whole window to Google's consent screen. */}
                  <Button variant="primary" url={data.connectUrl} target="_top">
                    {g.connectButton}
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        ) : (
          <>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        {g.connectedTitle}
                      </Text>
                      <Badge tone="success">{g.statusConnected}</Badge>
                    </InlineStack>
                    {data.property && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {g.property}: {data.property}
                        {data.email ? ` · ${data.email}` : ""}
                      </Text>
                    )}
                  </BlockStack>
                  <Button
                    onClick={() => fetcher.submit({ actionType: "disconnect" }, { method: "post" })}
                  >
                    {g.disconnect}
                  </Button>
                </InlineStack>

                {data.needsReconnect && data.connectUrl && (
                  <Banner tone="warning">
                    {g.reconnectNeeded}{" "}
                    <Button variant="plain" url={data.connectUrl} target="_top">
                      {g.reconnect}
                    </Button>
                  </Banner>
                )}

                {!data.needsPropertySelection && (
                  <BlockStack gap="150">
                    <InlineStack gap="200">
                      <Button
                        loading={fetcher.state !== "idle"}
                        onClick={() => fetcher.submit({ actionType: "sync" }, { method: "post" })}
                      >
                        {g.syncKeywords}
                      </Button>
                      <Button
                        onClick={() => fetcher.submit({ actionType: "submitSitemap" }, { method: "post" })}
                      >
                        {g.submitSitemap}
                      </Button>
                    </InlineStack>
                    {/* Merchant-facing note: app/services/seo/gsc-auto-sync.service.ts
                        also syncs rankings automatically once a day, independent of
                        this button. */}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {g.autoSyncNote}
                      {data.lastKeywordSyncAt
                        ? ` · ${g.lastSyncedLabel}: ${new Date(data.lastKeywordSyncAt).toLocaleDateString()}`
                        : ""}
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {data.needsPropertySelection && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {g.selectPropertyTitle}
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {g.selectPropertyBody}
                  </Text>
                  {data.availableProperties.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {g.selectPropertyEmpty}
                    </Text>
                  ) : (
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <div style={{ minWidth: "280px" }}>
                        <Select
                          label="Property"
                          labelHidden
                          options={data.availableProperties.map((s) => ({ label: s.siteUrl, value: s.siteUrl }))}
                          value={selectedProperty}
                          onChange={setSelectedProperty}
                        />
                      </div>
                      <Button
                        variant="primary"
                        disabled={!selectedProperty}
                        loading={fetcher.state !== "idle"}
                        onClick={() =>
                          fetcher.submit(
                            { actionType: "selectProperty", propertyUrl: selectedProperty },
                            { method: "post" },
                          )
                        }
                      >
                        {g.selectPropertyButton}
                      </Button>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Country/device filters — apply to Top queries, its deltas, Lost queries and
                Quick wins (all three analytics calls in the loader); the keyword-sync
                call stays global/unfiltered on purpose. */}
            {!data.needsPropertySelection && (
              <InlineStack gap="300" wrap>
                <div style={{ minWidth: "160px" }}>
                  <Select
                    label={g.filterDevice}
                    options={[
                      { label: g.filterAll, value: "" },
                      { label: g.deviceDesktop, value: "DESKTOP" },
                      { label: g.deviceMobile, value: "MOBILE" },
                      { label: g.deviceTablet, value: "TABLET" },
                    ]}
                    value={data.filterDevice ?? ""}
                    onChange={(value) => setGscFilterParam("gscDevice", value)}
                  />
                </div>
                <div style={{ minWidth: "160px" }}>
                  <Select
                    label={g.filterCountry}
                    options={[
                      { label: g.filterAll, value: "" },
                      ...data.availableCountries.map((c) => ({ label: c.code.toUpperCase(), value: c.code })),
                    ]}
                    value={data.filterCountry ?? ""}
                    onChange={(value) => setGscFilterParam("gscCountry", value)}
                  />
                </div>
              </InlineStack>
            )}

            {!data.needsPropertySelection && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {g.topQueries}
                    </Text>
                    {data.topQueries.length > 0 && (
                      <Button
                        size="slim"
                        variant="plain"
                        loading={topQueriesExportFetcher.state !== "idle"}
                        onClick={() => {
                          const params = new URLSearchParams();
                          params.set("dataset", "top");
                          if (data.filterCountry) params.set("gscCountry", data.filterCountry);
                          if (data.filterDevice) params.set("gscDevice", data.filterDevice);
                          topQueriesExportFetcher.load(`/app/seo/search-console/export?${params.toString()}`);
                        }}
                      >
                        {g.exportCsv}
                      </Button>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {g.deltaHint}
                  </Text>
                  {adoptError && (
                    <Banner tone="critical" onDismiss={() => setAdoptError(null)}>
                      {adoptError === "tooMany" ? g.adoptTooMany : g.errorGeneric}
                    </Banner>
                  )}
                  {data.error === "fetch_failed" ? (
                    <Text as="p" tone="subdued">
                      {g.errorGeneric}
                    </Text>
                  ) : data.topQueries.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {g.noQueries}
                    </Text>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                            <th style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{g.colQuery}</Text>
                            </th>
                            <th style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{g.colClicks}</Text>
                            </th>
                            <th style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{g.colImpressions}</Text>
                            </th>
                            <th style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{g.colPosition}</Text>
                            </th>
                            <th style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{g.colAction}</Text>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.topQueries.map((row, i) => {
                            const delta = ownEntry(data.deltas, (row.keys[0] ?? "").toLowerCase());
                            return (
                              <tr key={`${row.keys[0]}:${i}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                                  <Text as="span" variant="bodyMd" truncate>{row.keys[0]}</Text>
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                  <InlineStack gap="150" blockAlign="center">
                                    <Text as="span" variant="bodySm">{row.clicks}</Text>
                                    {delta && delta.clicksDelta !== 0 && (
                                      <Text as="span" variant="bodySm" tone={delta.clicksDelta > 0 ? "success" : "critical"}>
                                        {delta.clicksDelta > 0 ? "+" : "−"}
                                        {Math.abs(delta.clicksDelta)}
                                      </Text>
                                    )}
                                  </InlineStack>
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                  <Text as="span" variant="bodySm">{row.impressions}</Text>
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                  <InlineStack gap="150" blockAlign="center">
                                    <Text as="span" variant="bodySm">{row.position.toFixed(1)}</Text>
                                    {delta && delta.positionDelta !== 0 && (
                                      <Text as="span" variant="bodySm" tone={delta.positionDelta < 0 ? "success" : "critical"}>
                                        {delta.positionDelta < 0 ? "↑" : "↓"}
                                        {Math.abs(delta.positionDelta).toFixed(1)}
                                      </Text>
                                    )}
                                  </InlineStack>
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                  {(() => {
                                    const query = row.keys[0] ?? "";
                                    if (!query) return null;
                                    const tracked = isQueryTracked(query);
                                    // Badge AND button while another language
                                    // is still untracked — the badge alone used
                                    // to make the language picker unreachable.
                                    return (
                                      <InlineStack gap="150" blockAlign="center" wrap={false}>
                                        {tracked && <Badge tone="success">{g.trackedBadge}</Badge>}
                                        {hasUntrackedLocale(query) && (
                                          <Button
                                            size="slim"
                                            variant="plain"
                                            loading={adoptFetcher.state !== "idle" && adoptingQuery === query}
                                            disabled={adoptFetcher.state !== "idle" && adoptingQuery !== query}
                                            onClick={() =>
                                              handleTrackClick(
                                                query,
                                                {
                                                  position: row.position,
                                                  clicks: row.clicks,
                                                  impressions: row.impressions,
                                                  ctr: row.ctr,
                                                },
                                                ownEntry(data.topPages, query.toLowerCase()),
                                              )
                                            }
                                          >
                                            {tracked ? g.trackAnotherLanguage : g.trackKeyword}
                                          </Button>
                                        )}
                                      </InlineStack>
                                    );
                                  })()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Content-Freshness (§5.3): items that rank + get traffic (from the daily
                SeoGscPageStat rollup) but haven't been touched in FRESHNESS_STALE_DAYS.
                CTR-bonus rows (badge) reuse the Quick-wins position/impressions band. */}
            {!data.needsPropertySelection && visibleFreshnessCandidates.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {g.freshnessTitle}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {g.freshnessHint}
                  </Text>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.freshnessColItem}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colPosition}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colCtr}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colImpressions}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colLastModified}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colAction}</Text>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFreshnessCandidates.map((row) => {
                          const key = `${row.resourceType}:${row.resourceId}`;
                          return (
                            <tr key={key} style={{ borderBottom: "1px solid #f1f2f3" }}>
                              <td style={{ padding: "6px 8px", maxWidth: "280px" }}>
                                <InlineStack gap="150" blockAlign="center" wrap={false}>
                                  <Text as="span" variant="bodyMd" truncate>{row.title}</Text>
                                  {row.priority === 2 && (
                                    <Badge tone="attention">{g.freshnessBonusBadge}</Badge>
                                  )}
                                </InlineStack>
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <Text as="span" variant="bodySm">{row.position.toFixed(1)}</Text>
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <Text as="span" variant="bodySm">{(row.ctr * 100).toFixed(1)}%</Text>
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <Text as="span" variant="bodySm">{row.impressions}</Text>
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {g.freshnessDaysAgo.replace("{days}", String(row.daysSinceUpdate))}
                                </Text>
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
                                  <Button size="slim" onClick={() => handleRefreshWithAi(row.resourceType, row.resourceId)}>
                                    {g.freshnessRefreshAction}
                                  </Button>
                                  <Button
                                    size="slim"
                                    variant="plain"
                                    loading={freshnessDismissFetcher.state !== "idle" && dismissingFreshnessKey === key}
                                    disabled={freshnessDismissFetcher.state !== "idle" && dismissingFreshnessKey !== key}
                                    onClick={() => handleDismissFreshness(row.resourceType, row.resourceId)}
                                  >
                                    {g.freshnessDismissAction}
                                  </Button>
                                </InlineStack>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>
            )}

            {/* Quick wins: rows that already rank (position 4-20) with real impressions
                but weak CTR — a title/meta rewrite here has outsized leverage. Hidden
                entirely when the (best-effort) page-dimensioned query didn't come back. */}
            {!data.needsPropertySelection && data.opportunities.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {g.quickWinsTitle}
                    </Text>
                    <Button
                      size="slim"
                      variant="plain"
                      loading={quickWinsExportFetcher.state !== "idle"}
                      onClick={() => {
                        const params = new URLSearchParams();
                        params.set("dataset", "quickwins");
                        if (data.filterCountry) params.set("gscCountry", data.filterCountry);
                        if (data.filterDevice) params.set("gscDevice", data.filterDevice);
                        quickWinsExportFetcher.load(`/app/seo/search-console/export?${params.toString()}`);
                      }}
                    >
                      {g.exportCsv}
                    </Button>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {g.quickWinsHint}
                  </Text>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colQuery}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colPage}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colImpressions}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colPosition}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colCtr}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colAction}</Text>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.opportunities.map((row, i) => (
                          <tr key={`${row.query}:${i}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "6px 8px", maxWidth: "260px" }}>
                              <Text as="span" variant="bodyMd" truncate>{row.query}</Text>
                            </td>
                            <td style={{ padding: "6px 8px", maxWidth: "220px" }}>
                              <Text as="span" variant="bodySm" tone="subdued" truncate>
                                {pagePathOnly(row.page)}
                              </Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{row.impressions}</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{row.position.toFixed(1)}</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{(row.ctr * 100).toFixed(1)}%</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <InlineStack gap="200" blockAlign="center" wrap={false}>
                                {row.resourceId && row.resourceType && (
                                  <Button
                                    size="slim"
                                    loading={quickWinFetcher.state !== "idle" && optimizingResourceId === row.resourceId}
                                    disabled={quickWinFetcher.state !== "idle" && optimizingResourceId !== row.resourceId}
                                    onClick={() =>
                                      handleOptimize({
                                        resourceType: row.resourceType as string,
                                        resourceId: row.resourceId as string,
                                        query: row.query,
                                        page: row.page,
                                      })
                                    }
                                  >
                                    {g.quickWinOptimize}
                                  </Button>
                                )}
                                {isQueryTracked(row.query) && <Badge tone="success">{g.trackedBadge}</Badge>}
                                {hasUntrackedLocale(row.query) && (
                                  <Button
                                    size="slim"
                                    variant="plain"
                                    loading={adoptFetcher.state !== "idle" && adoptingQuery === row.query}
                                    disabled={adoptFetcher.state !== "idle" && adoptingQuery !== row.query}
                                    onClick={() => {
                                      const gsc = { position: row.position, impressions: row.impressions, ctr: row.ctr };
                                      if (row.resourceId && row.resourceType) {
                                        // Item already known — the modal only
                                        // has to ask for the language, and
                                        // only when there is a choice.
                                        if (hasMultipleLocales) {
                                          setAdoptError(null);
                                          setAdoptModal({
                                            mode: "adopt",
                                            query: row.query,
                                            gsc,
                                            resourceType: row.resourceType,
                                            resourceId: row.resourceId,
                                            locale: guessLocaleFromPage(row.page),
                                          });
                                        } else {
                                          submitAdopt(
                                            row.query,
                                            gsc,
                                            { resourceType: row.resourceType, resourceId: row.resourceId },
                                            "",
                                          );
                                        }
                                      } else {
                                        handleTrackClick(row.query, gsc, row.page);
                                      }
                                    }}
                                  >
                                    {isQueryTracked(row.query) ? g.trackAnotherLanguage : g.trackKeyword}
                                  </Button>
                                )}
                              </InlineStack>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {quickWinFetcher.state === "idle" && quickWinFetcher.data && !quickWinFetcher.data.ok && (
                    <Banner tone="critical">{g.errorGeneric}</Banner>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Lost queries: had real impressions last period but don't show up at all
                this period — a signal that ranking content may have regressed or been
                removed. Hidden entirely when nothing qualifies (or the best-effort
                previous-period fetch didn't come back). */}
            {!data.needsPropertySelection && data.lostQueries.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {g.lostQueriesTitle}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {g.lostQueriesHint}
                  </Text>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colQuery}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colClicks}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colImpressions}</Text>
                          </th>
                          <th style={{ padding: "6px 8px" }}>
                            <Text as="span" variant="bodySm" tone="subdued">{g.colPosition}</Text>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lostQueries.map((row, i) => (
                          <tr key={`${row.query}:${i}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                              <Text as="span" variant="bodyMd" truncate>{row.query}</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{row.clicks}</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{row.impressions}</Text>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <Text as="span" variant="bodySm">{row.position.toFixed(1)}</Text>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>
            )}

            {/* Inspect URL: surfaces the previously-dead inspectUrl() service call so a
                merchant can check a single page's live indexing status on demand. */}
            {!data.needsPropertySelection && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {g.inspectTitle}
                  </Text>
                  <InlineStack gap="200" blockAlign="end" wrap>
                    <div style={{ flex: "1 1 320px" }}>
                      <TextField
                        label={g.inspectTitle}
                        labelHidden
                        autoComplete="off"
                        placeholder={g.inspectPlaceholder}
                        value={inspectValue}
                        onChange={setInspectValue}
                      />
                    </div>
                    <Button
                      loading={inspectFetcher.state !== "idle"}
                      disabled={!inspectValue.trim()}
                      onClick={() =>
                        inspectFetcher.submit({ actionType: "inspectUrl", url: inspectValue }, { method: "post" })
                      }
                    >
                      {g.inspectButton}
                    </Button>
                  </InlineStack>
                  {inspectFetcher.state === "idle" && inspectFetcher.data && (
                    inspectFetcher.data.ok && inspectFetcher.data.kind === "inspected" ? (
                      <BlockStack gap="150">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">{g.inspectVerdict}:</Text>
                          <Badge tone={verdictTone(inspectFetcher.data.inspection.verdict)}>
                            {inspectFetcher.data.inspection.verdict}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {g.inspectCoverage}: {inspectFetcher.data.inspection.coverageState || "—"}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {g.inspectLastCrawl}: {inspectFetcher.data.inspection.lastCrawlTime || "—"}
                        </Text>
                      </BlockStack>
                    ) : !inspectFetcher.data.ok ? (
                      <Banner tone="critical">
                        {inspectFetcher.data.error === "reconnect" ? g.errorReconnect : g.inspectFailed}
                      </Banner>
                    ) : null
                  )}
                </BlockStack>
              </Card>
            )}
          </>
        )}
      </BlockStack>

      {/* Track modal: language picker (multi-language shops) plus the item
          picker for adopt rows whose page URL didn't resolve to a cached store
          item (PLAN_KEYWORDS_EXPANSION.md §4.3). */}
      <Modal
        open={!!adoptModal}
        onClose={() => setAdoptModal(null)}
        title={needsItemPicker ? g.adoptModalTitle : g.trackModalTitle}
        primaryAction={{
          content: g.trackKeyword,
          disabled: needsItemPicker && !adoptItemId,
          loading: adoptFetcher.state !== "idle" || quickWinFetcher.state !== "idle",
          onAction: () => {
            if (!adoptModal) return;
            if (adoptModal.mode === "quickWin" && adoptModal.resourceType && adoptModal.resourceId) {
              submitQuickWin(
                {
                  resourceType: adoptModal.resourceType,
                  resourceId: adoptModal.resourceId,
                  query: adoptModal.query,
                },
                adoptModal.locale,
              );
              setAdoptModal(null);
              return;
            }
            if (needsItemPicker) {
              if (!adoptItemId) return;
              submitAdopt(
                adoptModal.query,
                adoptModal.gsc,
                { resourceType: adoptType, resourceId: adoptItemId },
                adoptModal.locale,
              );
              return;
            }
            // Either the row resolved to an item already, or the server
            // resolves it from the page URL.
            submitAdopt(
              adoptModal.query,
              adoptModal.gsc,
              adoptModal.resourceType && adoptModal.resourceId
                ? { resourceType: adoptModal.resourceType, resourceId: adoptModal.resourceId }
                : { page: adoptModal.page },
              adoptModal.locale,
            );
          },
        }}
        secondaryActions={[{ content: g.adoptModalCancel, onAction: () => setAdoptModal(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            {(needsItemPicker ? g.adoptModalBody : g.trackModalBody).replace("{query}", adoptModal?.query ?? "")}
          </Text>
          {adoptError && (
            <Banner tone="critical">{adoptError === "tooMany" ? g.adoptTooMany : g.errorGeneric}</Banner>
          )}
          {hasMultipleLocales && (
            <Select
              label={g.trackLocaleLabel}
              helpText={g.trackLocaleHelp}
              options={data.localeOptions.map((l) => ({
                label: l.primary
                  ? `${l.name || l.locale} (${t.seo.keywordsPage.localePrimary})`
                  : l.name || l.locale,
                value: l.locale,
              }))}
              value={adoptModal?.locale ?? ""}
              onChange={(v) => setAdoptModal((prev) => (prev ? { ...prev, locale: v } : prev))}
            />
          )}
          {needsItemPicker && (
            <>
              <Select
                label={t.seo.keywordsPage.typeLabel}
                options={(["Product", "Collection", "Article", "Page"] as KeywordResourceType[]).map((rt) => ({
                  label: t.seo.keywordsPage.types[rt],
                  value: rt,
                }))}
                value={adoptType}
                onChange={(v) => {
                  setAdoptType(v as KeywordResourceType);
                  setAdoptItemId("");
                  setAdoptItemInput("");
                }}
              />
              <Autocomplete
                options={filteredAdoptOptions}
                selected={adoptItemId ? [adoptItemId] : []}
                onSelect={(selected) => {
                  const id = selected[0] ?? "";
                  setAdoptItemId(id);
                  const match = adoptModalOptions.find((o) => o.value === id);
                  setAdoptItemInput(match ? match.label : "");
                }}
                textField={
                  <Autocomplete.TextField
                    label={t.seo.keywordsPage.itemLabel}
                    autoComplete="off"
                    placeholder={t.seo.keywordsPage.selectItem}
                    value={adoptItemInput}
                    onChange={(value) => {
                      setAdoptItemInput(value);
                      if (adoptItemId) setAdoptItemId("");
                    }}
                  />
                }
              />
            </>
          )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </SeoSectionLayout>
  );
}

/** Path-only, truncated view of a GSC page URL for the Quick wins table. */
function pagePathOnly(pageUrl: string): string {
  try {
    const path = new URL(pageUrl).pathname;
    return path.length > 60 ? `${path.slice(0, 57)}...` : path;
  } catch {
    return pageUrl;
  }
}

/** PASS -> success, everything else (PARTIAL/FAIL/NEUTRAL/unknown) -> a cautionary tone. */
function verdictTone(verdict: string): "success" | "warning" | "critical" {
  if (verdict === "PASS") return "success";
  if (verdict === "FAIL") return "critical";
  return "warning";
}

/**
 * Google Search Console section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * Pro+ only — gated server-side in BOTH the loader and the action (the section
 * descriptor's planGate also gates the client). When the GOOGLE_OAUTH_* env vars
 * aren't set the section shows "not configured". Otherwise: connect (top-level
 * OAuth), then view top queries, sync keyword rankings, and submit the sitemap.
 */

import { useEffect, useRef, useState } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";

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
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
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
import { resolvePathsToResources } from "../services/seo/url-resolver.server";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
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
      resourceType: r?.id ? (r.resourceType as KeywordResourceType) : null,
      resourceId: r?.id ?? null,
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
    trackedQueries: [] as string[],
    // Per-type item pickers for the adopt modal (unresolvable rows) — same
    // shape/cap as the keywords tab's add form.
    pickers: { Product: [], Collection: [], Article: [], Page: [] } as Record<
      KeywordResourceType,
      Array<{ id: string; title: string }>
    >,
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
  base.property = connection.propertyUrl || null;
  base.email = connection.email;
  base.lastKeywordSyncAt = connection.lastKeywordSyncAt ? connection.lastKeywordSyncAt.toISOString() : null;

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
    const { startDate, endDate } = defaultDateRange(new Date());
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

    // Period-over-period comparison: the 28 days immediately before the
    // window above. Best-effort — any failure here just leaves
    // deltas/lostQueries empty; the table renders exactly as before.
    // SAME (query,page) dimensions + SAME aggregation as the current period
    // (review M5): comparing our impression-weighted positions against GSC's
    // query-dimension positions would fabricate position deltas for every
    // query that ranks on more than one page.
    try {
      const prevRange = previousDateRange(new Date());
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
          select: { keyword: true },
        });
        base.trackedQueries = Array.from(new Set(tracked.map((t: { keyword: string }) => t.keyword)));
      }
    } catch {
      base.trackedQueries = [];
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

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
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
    // Quick wins always track against the PRIMARY locale ("") — same
    // convention as the keyword→AI-prompt bridge in text-generation.handler.ts,
    // which only ever looks up locale "". Don't overwrite an existing primary:
    // the merchant may have deliberately chosen a different target keyword for
    // this resource already, and a one-click "optimize" shouldn't clobber that
    // — assignKeyword without demoteExisting returns `primaryExists` instead
    // of writing, which we treat as "already tracked, fine". A full item at
    // the keyword cap (`tooMany`) is equally fine to skip silently here.
    await assignKeyword(db, session.shop, {
      resourceType,
      resourceId,
      keyword: query,
      locale: "",
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
    let locale = "";

    if (!resourceType || !resourceId) {
      // Resolve the row's page URL → handle → cached item. The locale prefix
      // (e.g. /fr/products/…) becomes the keyword's locale SUGGESTION —
      // GSC queries carry no locale, but a French query ranking on the FR
      // page should be tracked against the FR edition (§4.2 Locale-Hinweis).
      const page = getFormString(form, "page");
      const resolved = page ? resolveGscPagePath(page) : null;
      if (resolved) {
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
            if (resolved.locale) {
              const shopLocales = await getCachedShopLocales(admin, session.shop);
              const isPublishedSecondary = shopLocales.some(
                (l: any) => !l.primary && l.published && l.locale.toLowerCase() === resolved.locale,
              );
              if (isPublishedSecondary) locale = resolved.locale;
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

  const handleOptimize = (row: { resourceType: string; resourceId: string; query: string }) => {
    optimizeTargetRef.current = { resourceType: row.resourceType, resourceId: row.resourceId };
    setOptimizingResourceId(row.resourceId);
    quickWinFetcher.submit(
      { actionType: "trackQuickWin", resourceType: row.resourceType, resourceId: row.resourceId, query: row.query },
      { method: "post" },
    );
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

  // ── "Track as keyword" adopt flow (PLAN_KEYWORDS_EXPANSION.md §4) ──
  // Own fetcher so the disconnect/sync/sitemap banner isn't clobbered.
  const adoptFetcher = useFetcher<ActionResult>();
  // Queries adopted in THIS session — flips the row to its "tracked" badge
  // without a reload; the loader's trackedQueries covers earlier sessions.
  const [adoptedQueries, setAdoptedQueries] = useState<Set<string>>(new Set());
  const [adoptingQuery, setAdoptingQuery] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  // Item-picker modal for rows whose page URL couldn't be resolved. Carries
  // the row's GSC metrics along so the re-submit still stamps them.
  const [adoptModal, setAdoptModal] = useState<{
    query: string;
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number };
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
  } | null>(null);

  const isQueryTracked = (query: string) => {
    const q = query.trim().toLowerCase();
    return adoptedQueries.has(q) || data.trackedQueries.includes(q);
  };

  const submitAdopt = (
    query: string,
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number },
    target: { page?: string } | { resourceType: string; resourceId: string },
  ) => {
    setAdoptingQuery(query);
    setAdoptError(null);
    pendingAdoptRef.current = { query, gsc };
    const payload: Record<string, string> = { actionType: "adoptKeyword", query };
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

  /** Row click: resolve via the row's page when we have one, else straight to
   *  the item-picker modal (no wasted server round-trip). */
  const handleTrackClick = (
    query: string,
    gsc: { position?: number; clicks?: number; impressions?: number; ctr?: number },
    page?: string,
  ) => {
    if (page) submitAdopt(query, gsc, { page });
    else {
      setAdoptError(null);
      setAdoptModal({ query, gsc });
    }
  };

  useEffect(() => {
    if (adoptFetcher.state !== "idle" || !adoptFetcher.data) return;
    const res = adoptFetcher.data;
    setAdoptingQuery(null);
    if (res.ok && res.kind === "keywordAdopted") {
      pendingAdoptRef.current = null;
      setAdoptedQueries((prev) => new Set(prev).add(res.query.trim().toLowerCase()));
      setAdoptModal(null);
      setAdoptItemId("");
      setAdoptItemInput("");
      return;
    }
    if (!res.ok && res.error === "unresolved" && "query" in res) {
      // No store item found for the row's page — let the merchant pick one.
      const pending = pendingAdoptRef.current;
      setAdoptModal({
        query: res.query,
        gsc: pending && pending.query === res.query ? pending.gsc : {},
      });
      return;
    }
    if (!res.ok) setAdoptError(res.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptFetcher.state, adoptFetcher.data]);

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
        <Banner tone="info" title={g.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{g.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{g.helpBody2}</Text>
          </BlockStack>
        </Banner>

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
                            const delta = data.deltas[(row.keys[0] ?? "").toLowerCase()];
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
                                    if (isQueryTracked(query)) {
                                      return <Badge tone="success">{g.trackedBadge}</Badge>;
                                    }
                                    return (
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
                                            data.topPages[query.toLowerCase()],
                                          )
                                        }
                                      >
                                        {g.trackKeyword}
                                      </Button>
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
                                      })
                                    }
                                  >
                                    {g.quickWinOptimize}
                                  </Button>
                                )}
                                {isQueryTracked(row.query) ? (
                                  <Badge tone="success">{g.trackedBadge}</Badge>
                                ) : (
                                  <Button
                                    size="slim"
                                    variant="plain"
                                    loading={adoptFetcher.state !== "idle" && adoptingQuery === row.query}
                                    disabled={adoptFetcher.state !== "idle" && adoptingQuery !== row.query}
                                    onClick={() => {
                                      const gsc = { position: row.position, impressions: row.impressions, ctr: row.ctr };
                                      if (row.resourceId && row.resourceType) {
                                        submitAdopt(row.query, gsc, {
                                          resourceType: row.resourceType,
                                          resourceId: row.resourceId,
                                        });
                                      } else {
                                        handleTrackClick(row.query, gsc, row.page);
                                      }
                                    }}
                                  >
                                    {g.trackKeyword}
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

      {/* Item-picker modal for adopt rows whose page URL didn't resolve to a
          cached store item (PLAN_KEYWORDS_EXPANSION.md §4.3). */}
      <Modal
        open={!!adoptModal}
        onClose={() => setAdoptModal(null)}
        title={g.adoptModalTitle}
        primaryAction={{
          content: g.trackKeyword,
          disabled: !adoptItemId,
          loading: adoptFetcher.state !== "idle",
          onAction: () => {
            if (adoptModal && adoptItemId) {
              submitAdopt(adoptModal.query, adoptModal.gsc, {
                resourceType: adoptType,
                resourceId: adoptItemId,
              });
            }
          },
        }}
        secondaryActions={[{ content: g.adoptModalCancel, onAction: () => setAdoptModal(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            {g.adoptModalBody.replace("{query}", adoptModal?.query ?? "")}
          </Text>
          {adoptError && (
            <Banner tone="critical">{adoptError === "tooMany" ? g.adoptTooMany : g.errorGeneric}</Banner>
          )}
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

/**
 * Google Search Console section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * Pro+ only — gated server-side in BOTH the loader and the action (the section
 * descriptor's planGate also gates the client). When the GOOGLE_OAUTH_* env vars
 * aren't set the section shows "not configured". Otherwise: connect (top-level
 * OAuth), then view top queries, sync keyword rankings, and submit the sitemap.
 */

import { useState } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
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
  revokeGoogleToken,
  inspectUrl,
  findCtrOpportunities,
  summarizeInspection,
  GscReconnectRequiredError,
  type SearchAnalyticsRow,
  type GscSite,
  type CtrOpportunity,
  type UrlInspectionSummary,
} from "../services/google-search-console.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";
  const statusParam = url.searchParams.get("gsc") || null;

  const base = {
    gated: false,
    configured: false,
    connected: false,
    connectUrl: null as string | null,
    property: null as string | null,
    email: null as string | null,
    topQueries: [] as SearchAnalyticsRow[],
    opportunities: [] as CtrOpportunity[],
    needsReconnect: false,
    needsPropertySelection: false,
    availableProperties: [] as GscSite[],
    error: null as string | null,
    statusParam,
    // Stamped by app/services/seo/gsc-auto-sync.service.ts (or a manual
    // "Sync keyword rankings" click) — trivially available on the connection
    // row already loaded below, so surfaced here for the auto-sync note.
    lastKeywordSyncAt: null as string | null,
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
    base.topQueries = await querySearchAnalytics(accessToken, propertyUrl, {
      startDate,
      endDate,
      dimensions: ["query"],
      rowLimit: 25,
    });

    // "Quick wins": a second, page-dimensioned query — only fired once the
    // first call above proved the token/property are good, so an auth failure
    // doesn't cost a second wasted GSC request. Best-effort: any failure here
    // just hides the Quick wins card instead of failing the whole page.
    try {
      const pageRows = await querySearchAnalytics(accessToken, propertyUrl, {
        startDate,
        endDate,
        dimensions: ["query", "page"],
        rowLimit: 1000,
      });
      base.opportunities = findCtrOpportunities(pageRows);
    } catch {
      base.opportunities = [];
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
  | { ok: false; error: string };

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

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

export default function SeoSearchConsole() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const g = t.seo.searchConsolePage;
  const fetcher = useFetcher<ActionResult>();
  // Property picker (only relevant when data.needsPropertySelection is true).
  const [selectedProperty, setSelectedProperty] = useState(data.availableProperties[0]?.siteUrl || "");
  // Separate fetcher for the Inspect URL card so its result doesn't get mixed
  // into (or cleared by) the disconnect/sync/sitemap/property actionMsg banner.
  const inspectFetcher = useFetcher<ActionResult>();
  const [inspectValue, setInspectValue] = useState("");

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

            {!data.needsPropertySelection && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {g.topQueries}
                  </Text>
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
                          </tr>
                        </thead>
                        <tbody>
                          {data.topQueries.map((row, i) => (
                            <tr key={`${row.keys[0]}:${i}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                              <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                                <Text as="span" variant="bodyMd" truncate>{row.keys[0]}</Text>
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
                  <Text as="h3" variant="headingMd">
                    {g.quickWinsTitle}
                  </Text>
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

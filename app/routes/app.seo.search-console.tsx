/**
 * Google Search Console section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * Pro+ only — gated server-side in BOTH the loader and the action (the section
 * descriptor's planGate also gates the client). When the GOOGLE_OAUTH_* env vars
 * aren't set the section shows "not configured". Otherwise: connect (top-level
 * OAuth), then view top queries, sync keyword rankings, and submit the sitemap.
 */

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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  isGscConfigured,
  getGscConnection,
  getGscAccessToken,
  deleteGscConnection,
  querySearchAnalytics,
  submitSitemap,
  enrichKeywordsFromGsc,
  buildGscAuthUrl,
  signOAuthState,
  defaultDateRange,
  GscReconnectRequiredError,
  type SearchAnalyticsRow,
} from "../services/google-search-console.server";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
    needsReconnect: false,
    error: null as string | null,
    statusParam,
  };

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) return json({ ...base, gated: true });

  if (!isGscConfigured()) return json(base);
  base.configured = true;

  const buildConnect = () => buildGscAuthUrl(signOAuthState({ shop: session.shop, host }));

  const connection = await getGscConnection(db, session.shop);
  if (!connection) {
    return json({ ...base, connectUrl: buildConnect() });
  }

  base.connected = true;
  base.property = connection.propertyUrl;
  base.email = connection.email;

  try {
    const { accessToken, propertyUrl } = await getGscAccessToken(db, session.shop);
    const { startDate, endDate } = defaultDateRange(new Date());
    base.topQueries = await querySearchAnalytics(accessToken, propertyUrl, {
      startDate,
      endDate,
      dimensions: ["query"],
      rowLimit: 25,
    });
  } catch (e) {
    if (e instanceof GscReconnectRequiredError) {
      base.needsReconnect = true;
      base.connectUrl = buildConnect();
    } else {
      base.error = "fetch_failed";
    }
  }

  return json(base);
};

type ActionResult =
  | { ok: true; kind: "disconnected" | "synced" | "sitemap"; count?: number }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "disconnect") {
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
      await submitSitemap(accessToken, propertyUrl, "sitemap.xml");
      return json<ActionResult>({ ok: true, kind: "sitemap" });
    } catch (e) {
      const reason = e instanceof GscReconnectRequiredError ? "reconnect" : "sitemap_failed";
      return json<ActionResult>({ ok: false, error: reason }, { status: 400 });
    }
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

export default function SeoSearchConsole() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const g = (t.seo as any).searchConsolePage;
  const fetcher = useFetcher<ActionResult>();

  const actionMsg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (fetcher.data.ok) {
      if (fetcher.data.kind === "synced") {
        return { tone: "success" as const, msg: g.synced.replace("{count}", String(fetcher.data.count ?? 0)) };
      }
      if (fetcher.data.kind === "sitemap") return { tone: "success" as const, msg: g.sitemapSubmitted };
      if (fetcher.data.kind === "disconnected") return { tone: "info" as const, msg: g.disconnected };
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
        {/* Status from the OAuth bounce-back */}
        {data.statusParam === "connected" && <Banner tone="success">{g.connectedBanner}</Banner>}
        {data.statusParam === "denied" && <Banner tone="warning">{g.deniedBanner}</Banner>}
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
                    <Text as="p" variant="bodySm" tone="subdued">
                      {g.property}: {data.property}
                      {data.email ? ` · ${data.email}` : ""}
                    </Text>
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
              </BlockStack>
            </Card>

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
          </>
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

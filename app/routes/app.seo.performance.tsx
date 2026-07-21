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
import { useMemo, useState } from "react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone } from "../utils/seo-score";
import { getFormString } from "../utils/form-data.utils";
import {
  isAllowedAuditUrl,
  runPageSpeedAudit,
  listPageSpeedHistory,
  findLatestPageSpeedAudit,
  PageSpeedQuotaExceededError,
} from "../services/seo/pagespeed.service";
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

  const [products, collections, pages, history, rum] = await Promise.all([
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
  ]);

  // Theme-editor deep link for enabling the RUM app embed — house pattern from
  // app.seo.structured-data.tsx: myshopify domain (custom domains only proxy
  // /admin via redirect) + activateAppId to preselect the embed when possible.
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const rumEmbedUrl = apiKey
    ? `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/web-vitals`
    : `https://${shop}/admin/themes/current/editor?context=apps`;

  return json({ domain, products, collections, pages, history, rum, rumEmbedUrl });
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
    const result = await runPageSpeedAudit({ db, shop, url, strategy, force });
    return json<ActionResult>({ ok: true, result });
  } catch (err: any) {
    // Google's daily/per-minute PSI quota is exhausted. Try to serve a stored
    // audit (any age) so the merchant sees something rather than a hard error.
    if (err instanceof PageSpeedQuotaExceededError) {
      const stale = await findLatestPageSpeedAudit(db, shop, url, strategy);
      if (stale) return json<ActionResult>({ ok: true, result: stale });
      return json<ActionResult>({ ok: false, error: "quotaExceeded" }, { status: 429 });
    }
    return json<ActionResult>(
      { ok: false, error: "auditFailed", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
};

/** Fixed 8-color palette shared by the screenshot overlay and the findings list, so box N and finding N always match. */
const ANNOTATION_COLORS = [
  "#e51c23",
  "#ff9800",
  "#9c27b0",
  "#2196f3",
  "#009688",
  "#795548",
  "#607d8b",
  "#4caf50",
];

function annotationColor(index: number): string {
  return ANNOTATION_COLORS[index % ANNOTATION_COLORS.length];
}

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
  const { products, collections, pages, history, rum, rumEmbedUrl } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const p = t.seo.performancePage;

  const fetcher = useFetcher<ActionResult>();

  const [selectedPath, setSelectedPath] = useState<string>("/");
  const [customUrl, setCustomUrl] = useState("");
  const [strategy, setStrategy] = useState<PageSpeedStrategy>("mobile");

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
  const data = fetcher.data;
  const result = data && data.ok ? data.result : null;
  const errorMessage =
    data && !data.ok
      ? data.error === "invalidUrl"
        ? p.errors.invalidUrl
        : data.error === "quotaExceeded"
          ? p.errors.quotaExceeded
          : `${p.errors.auditFailed}${data.detail ? `: ${data.detail}` : ""}`
      : null;

  const submitAudit = (force: boolean) => {
    fetcher.submit(
      { intent: "runAudit", url: effectiveUrl, strategy, force: force ? "1" : "0" },
      { method: "post" },
    );
  };

  const strategyLabel = (s: PageSpeedStrategy) => (s === "desktop" ? p.strategyDesktop : p.strategyMobile);

  const annotationIndexById = useMemo(() => {
    const map = new Map<string, number>();
    result?.annotations.forEach((a, i) => map.set(a.id, i));
    return map;
  }, [result]);

  const annotatable = !!result?.screenshot?.fullPage;
  const visibleHistory = history.slice(0, HISTORY_VISIBLE_LIMIT);

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
              <Button variant="primary" loading={running} disabled={!effectiveUrl} onClick={() => submitAudit(false)}>
                {p.testButton}
              </Button>
              {result && (
                <Button loading={running} onClick={() => submitAudit(true)}>
                  {p.retestButton}
                </Button>
              )}
            </InlineStack>
            {running && (
              <Text as="p" variant="bodySm" tone="subdued">
                {p.runningHint}
              </Text>
            )}
          </BlockStack>
        </Card>

        {errorMessage && <Banner tone="critical">{errorMessage}</Banner>}

        {result && (
          <BlockStack gap="400">
            {result.stale && <Banner tone="warning">{p.staleQuotaNotice}</Banner>}
            {/* Score header */}
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="span" variant="heading2xl">
                    {result.performanceScore != null ? String(result.performanceScore) : "–"}
                  </Text>
                  {result.performanceScore != null && (
                    <Badge tone={scoreTone(result.performanceScore) as any}>{p.scoreTitle}</Badge>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {p.testedLabel
                    .replace("{url}", pathOnly(result.url))
                    .replace("{strategy}", strategyLabel(result.strategy))
                    .replace("{date}", new Date(result.fetchedAt).toLocaleString())}
                </Text>
              </BlockStack>
            </Card>

            {!annotatable && <Banner tone="info">{p.noHighlightNote}</Banner>}

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
                    <div style={{ position: "relative" }}>
                      <img
                        src={result.screenshot.data}
                        alt=""
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
                {/* Metrics */}
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">{p.metricsTitle}</Text>
                    {result.metrics.map((m) => (
                      <InlineStack key={m.id} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd">
                          {p.metricNames[m.id as PageSpeedMetricId] || m.id}
                        </Text>
                        <Badge tone={metricTone(m.score)}>{m.displayValue}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </Card>

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
                      </BlockStack>
                    )}

                    {result.opportunities.length > 0 && (
                      <BlockStack gap="200">
                        <Text as="h4" variant="headingSm">{p.opportunitiesTitle}</Text>
                        {result.opportunities.map((o) => (
                          <BlockStack key={o.id} gap="100">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{o.title}</Text>
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
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                {/* Real-user field data */}
                {result.fieldData && (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingMd">{p.fieldDataTitle}</Text>
                      {result.fieldData.lcp && (
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">{p.fieldLcpLabel}</Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {formatMs(result.fieldData.lcp.percentile)}
                            </Text>
                            <Badge tone={FIELD_CATEGORY_TONE[result.fieldData.lcp.category]}>
                              {p.fieldCategory[result.fieldData.lcp.category]}
                            </Badge>
                          </InlineStack>
                        </InlineStack>
                      )}
                      {result.fieldData.cls && (
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">{p.fieldClsLabel}</Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {(result.fieldData.cls.percentile / 100).toFixed(2)}
                            </Text>
                            <Badge tone={FIELD_CATEGORY_TONE[result.fieldData.cls.category]}>
                              {p.fieldCategory[result.fieldData.cls.category]}
                            </Badge>
                          </InlineStack>
                        </InlineStack>
                      )}
                      {result.fieldData.inp && (
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">{p.fieldInpLabel}</Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {formatMs(result.fieldData.inp.percentile)}
                            </Text>
                            <Badge tone={FIELD_CATEGORY_TONE[result.fieldData.inp.category]}>
                              {p.fieldCategory[result.fieldData.inp.category]}
                            </Badge>
                          </InlineStack>
                        </InlineStack>
                      )}
                      {result.fieldData.originFallback && (
                        <Text as="p" variant="bodySm" tone="subdued">{p.fieldOriginFallback}</Text>
                      )}
                    </BlockStack>
                  </Card>
                )}
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
                {visibleHistory.map((entry, index) => (
                  <IndexTable.Row id={entry.id} key={entry.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">{pathOnly(entry.url)}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">{strategyLabel(entry.strategy)}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {entry.performanceScore != null ? (
                        <Badge tone={scoreTone(entry.performanceScore) as any}>{String(entry.performanceScore)}</Badge>
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
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}

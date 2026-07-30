/**
 * Sitemap & indexation control section (PLAN_SEO_SUITE_COMPLETION.md §6.2,
 * Phase 4) — Pro+ (§6.2: full apply flow -> "pro" planGate, per plan default).
 *
 * Loader calls sitemap.service.ts's `analyze()` — DB-cache-first exclusion
 * suggestions (upserted idempotently) + the live sitemap-index fetch (the ONE
 * live call this section makes, cached ~1h) + the broken-links-in-sitemap
 * crossmatch (only meaningful once a Phase-1 crawl snapshot exists).
 *
 * ── Empirical spike NOT run (§6.1) ──────────────────────────────────────────
 * No dev store is available in this environment, so the ~1h spike verifying
 * `seo.hidden` behavior (does it really clear the sitemap? is the metafield
 * type/scope right? does revert clean up?) was never executed. The Apply/
 * Revert actions below call `applyExclusion`/`revertExclusion`
 * (sitemap.service.ts), which are ECHO-GUARDED: `SeoSitemapExclusion.status`
 * only moves to "applied"/"reverted" once Shopify's response confirms the
 * write. If the spike's assumptions turn out wrong (wrong metafield type,
 * missing scope, etc.), the mutation's `userErrors` or a missing echo simply
 * makes the action return `ok: false` — the row stays "suggested", the UI
 * shows an error banner, and nothing is silently corrupted. This degrades
 * safely; it does not require the spike to have run first.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Card, BlockStack, InlineStack, Text, Badge, Button, Banner, DataTable, Modal, List,
  Collapsible, TextField, Thumbnail, Tooltip, Icon, Select,
} from "@shopify/polaris";
import { EditIcon, ImageIcon, SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { SubNavBar } from "../components/nav/SubNavBar";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  analyze,
  applyExclusion,
  revertExclusion,
  searchExclusionCandidates,
  ensureManualExclusion,
  EXCLUDABLE_RESOURCE_TYPES,
  type SitemapAnalysis,
  type SitemapExclusionRow,
  type SitemapExclusionResourceType,
  type ExclusionSearchHit,
} from "../services/seo/sitemap.service";

function parseResourceType(raw: string): SitemapExclusionResourceType | null {
  return (EXCLUDABLE_RESOURCE_TYPES as string[]).includes(raw)
    ? (raw as SitemapExclusionResourceType)
    : null;
}

const TYPE_PATH: Record<SitemapExclusionResourceType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  page: "/app/pages",
  article: "/app/blog",
};

/** Picker options. Kept as a local literal rather than importing the service's
 *  EXCLUDABLE_RESOURCE_TYPES — the component must not pull sitemap.service.ts
 *  (and with it cheerio) into the client bundle. */
const MANUAL_TYPE_OPTIONS: SitemapExclusionResourceType[] = ["product", "collection", "page", "article"];

/** Mirrors the service's PRODUCT_STATUSES — same client-bundle reason as above. */
const PRODUCT_STATUS_OPTIONS = ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"];

/** Emoji markers, matching how SubNavBar carries icons elsewhere. */
const TYPE_ICON: Record<SitemapExclusionResourceType, string> = {
  product: "📦",
  collection: "🗂️",
  page: "📄",
  article: "📝",
};

const SHOP_DOMAIN_QUERY = `#graphql
  query seoSitemapShopDomain {
    shop { primaryDomain { host } }
  }
`;

async function fetchPrimaryDomain(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_DOMAIN_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.primaryDomain?.host || fallbackShop;
  } catch {
    return fallbackShop;
  }
}

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return (settings?.subscriptionPlan || "free") as Plan;
}

// Static, non-shop-specific example shown to Free/Basic merchants alongside
// the upgrade card (same pattern as crawl.tsx §3.7 / internal-links.tsx).
const EXAMPLE_ANALYSIS: SitemapAnalysis = {
  sitemapUrl: "https://example-shop.com/sitemap.xml",
  attemptedSitemapUrl: "https://example-shop.com/sitemap.xml",
  entryCount: 248,
  sitemapFetchError: false,
  sitemapFailureReason: null,
  sitemapHttpStatus: null,
  hasCrawlSnapshot: false,
  brokenInSitemap: [],
  exclusions: [
    {
      id: "example-1",
      resourceType: "collection",
      resourceId: "example",
      reason: "emptyCollection",
      status: "suggested",
      appliedAt: null,
      title: "Sommer 2023 (leer)",
      handle: "sommer-2023",
      caution: false,
    },
    {
      id: "example-2",
      resourceType: "page",
      resourceId: "example",
      reason: "thinContent",
      status: "suggested",
      appliedAt: null,
      title: "Versand & Rückgabe",
      handle: "versand-rueckgabe",
      caution: true,
    },
  ],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ gated: true, analysis: EXAMPLE_ANALYSIS });
  }

  const primaryDomain = await fetchPrimaryDomain(admin, shop);
  const analysis = await analyze(shop, { db, primaryDomain });

  return json({ gated: false, analysis });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = getFormString(formData, "actionType");
  const exclusionId = getFormString(formData, "exclusionId");

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "Not available on this plan" }, { status: 403 });
  }

  if (actionType === "apply") {
    const result = await applyExclusion(admin, db, shop, exclusionId);
    return json({ success: result.ok, error: result.error });
  }

  if (actionType === "revert") {
    const result = await revertExclusion(admin, db, shop, exclusionId);
    return json({ success: result.ok, error: result.error });
  }

  // Type-ahead for the manual picker. Read-only, so it returns hits rather
  // than the usual {success} envelope.
  if (actionType === "search") {
    const resourceType = parseResourceType(getFormString(formData, "resourceType"));
    if (!resourceType) return json({ success: false, error: "Unknown resourceType" }, { status: 400 });
    const requestedPage = Number.parseInt(getFormString(formData, "page") || "1", 10);
    const result = await searchExclusionCandidates(
      db,
      shop,
      resourceType,
      getFormString(formData, "query"),
      requestedPage,
      getFormString(formData, "statusFilter") || "all",
    );
    // Echo the type back so the client can discard a response that arrived
    // after the user already switched tabs.
    return json({ success: true, resourceType, ...result });
  }

  // Exclude an arbitrary resource: create (or reuse) the row, then run it
  // through the SAME echo-verified applyExclusion as a suggestion — there is
  // no second write path. `ensureManualExclusion` returns null for an id that
  // isn't in this shop's cache, so a forged POST can't reach metafieldsSet.
  if (actionType === "excludeManual") {
    const resourceType = parseResourceType(getFormString(formData, "resourceType"));
    const resourceId = getFormString(formData, "resourceId");
    if (!resourceType || !resourceId) {
      return json({ success: false, error: "Unknown resource" }, { status: 400 });
    }
    const row = await ensureManualExclusion(db, shop, resourceType, resourceId);
    if (!row) return json({ success: false, error: "not_found" }, { status: 404 });
    const result = await applyExclusion(admin, db, shop, row.id);
    return json({ success: result.ok, error: result.error });
  }

  return json({ success: false, error: `Unknown actionType: ${actionType}` }, { status: 400 });
};

export default function SeoSitemap() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const c = (t.seo as any).sitemapPage as Record<string, string>;
  const resourceTypeLabel = (t.tasks as any).resourceType as Record<string, string>;

  const rowFetcher = useFetcher<{ success: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const [banner, setBanner] = useState<{ tone: "critical" | "success"; message: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Neither direction writes without an explicit confirmation: both flip a
  // metafield that changes what Google may index, and the row label alone
  // ("Grund: Dünner Inhalt") never made the consequence visible. Normalized to
  // what the dialog renders, so a suggestion row and a manually picked search
  // hit share one modal.
  const [confirm, setConfirm] = useState<{
    mode: "apply" | "revert";
    key: string;
    title: string;
    reason: string | null;
    caution: boolean;
    /** The resource's product status already keeps it out of sitemap.xml, so
     *  this apply would be a no-op — shown in the dialog so the merchant is
     *  told BEFORE the metafield write, not after. Suggestion rows never set
     *  it (they are only ever raised for statuses this does not cover). */
    noEffect?: boolean;
    submit: () => void;
  } | null>(null);

  // Manual picker
  const [manualType, setManualType] = useState<SitemapExclusionResourceType>("product");
  const [manualQuery, setManualQuery] = useState("");
  const [manualPage, setManualPage] = useState(1);
  const [manualStatus, setManualStatus] = useState<string>("all");
  const searchFetcher = useFetcher<{
    success: boolean;
    resourceType?: string;
    hits?: ExclusionSearchHit[];
    total?: number;
    page?: number;
    pageSize?: number;
  }>();

  // Switching type or editing the filter must go back to page 1 — page 7 of
  // the old result set is meaningless for the new one. Both setters run in the
  // same handler, so React batches them into ONE render and the search effect
  // fires once with the new type/query AND page 1, not twice.
  const changeManualType = (next: SitemapExclusionResourceType) => {
    setManualType(next);
    setManualPage(1);
    // Only products have a status; carrying a stale "DRAFT" into the pages tab
    // would silently look like a filter that does nothing.
    if (next !== "product") setManualStatus("all");
  };
  const changeManualQuery = (next: string) => {
    setManualQuery(next);
    setManualPage(1);
  };
  const changeManualStatus = (next: string) => {
    setManualStatus(next);
    setManualPage(1);
  };

  useEffect(() => {
    if (rowFetcher.state !== "idle" || !rowFetcher.data) return;
    setPendingId(null);
    if (rowFetcher.data.success) {
      setBanner({ tone: "success", message: c.actionSuccess });
      revalidatorRef.current.revalidate();
    } else {
      setBanner({ tone: "critical", message: rowFetcher.data.error || c.actionError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowFetcher.state, rowFetcher.data]);

  const submitRowAction = (exclusionId: string, actionType: "apply" | "revert") => {
    setBanner(null);
    setPendingId(exclusionId);
    const formData = new FormData();
    formData.append("actionType", actionType);
    formData.append("exclusionId", exclusionId);
    rowFetcher.submit(formData, { method: "post" });
  };

  const submitManualExclude = (hit: ExclusionSearchHit) => {
    setBanner(null);
    setPendingId(hit.resourceId);
    const formData = new FormData();
    formData.append("actionType", "excludeManual");
    formData.append("resourceType", hit.resourceType);
    formData.append("resourceId", hit.resourceId);
    rowFetcher.submit(formData, { method: "post" });
  };

  // The picker loads on mount and on every tab switch, and re-queries as you
  // type — no search button to press. The debounce keeps a fast typist from
  // firing one request per keystroke; a tab switch is not debounced, since
  // that's a deliberate single action.
  const searchRef = useRef(searchFetcher);
  searchRef.current = searchFetcher;
  // Effects run regardless of which branch renders, so the gated (Free/Basic)
  // view would otherwise fire a POST the action answers with 403.
  const pickerActive = !data.gated;
  useEffect(() => {
    if (!pickerActive) return;
    const send = () => {
      const formData = new FormData();
      formData.append("actionType", "search");
      formData.append("resourceType", manualType);
      formData.append("query", manualQuery);
      formData.append("page", String(manualPage));
      formData.append("statusFilter", manualStatus);
      searchRef.current.submit(formData, { method: "post" });
    };
    if (!manualQuery) {
      send();
      return;
    }
    const timer = setTimeout(send, 300);
    return () => clearTimeout(timer);
  }, [manualType, manualQuery, manualPage, manualStatus, pickerActive]);

  // Results only count while they belong to the active tab — the fetcher keeps
  // the previous payload during the next request, which would otherwise show
  // products under the "Kollektionen" tab for a moment. null = still loading.
  const searchData =
    searchFetcher.data?.hits && searchFetcher.data.resourceType === manualType ? searchFetcher.data : null;
  const hits = searchData?.hits ?? null;
  // Paging reads the SERVER's page, not local state: the service clamps an
  // out-of-range request, and showing the clamped value is what keeps the
  // controls honest after a filter narrows the result set.
  const manualTotal = searchData?.total ?? 0;
  const manualPageSize = searchData?.pageSize ?? 20;
  const serverPage = searchData?.page ?? 1;
  const manualTotalPages = Math.max(1, Math.ceil(manualTotal / manualPageSize));
  const firstOnPage = manualTotal === 0 ? 0 : (serverPage - 1) * manualPageSize + 1;
  const lastOnPage = Math.min(serverPage * manualPageSize, manualTotal);

  // A successful exclude must refresh the picker too, not just the lists
  // above — otherwise the row keeps offering "Ausschließen" for something
  // that is already applied.
  const lastActionData = rowFetcher.data;
  useEffect(() => {
    if (!pickerActive || rowFetcher.state !== "idle" || !lastActionData?.success) return;
    const formData = new FormData();
    formData.append("actionType", "search");
    formData.append("resourceType", manualType);
    formData.append("query", manualQuery);
    formData.append("page", String(manualPage));
    formData.append("statusFilter", manualStatus);
    searchRef.current.submit(formData, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowFetcher.state, lastActionData]);

  const confirmRowAction = () => {
    if (!confirm) return;
    const submit = confirm.submit;
    setConfirm(null);
    submit();
  };

  const askExclusionRow = (row: SitemapExclusionRow, mode: "apply" | "revert") =>
    setConfirm({
      mode,
      key: row.id,
      title: row.title,
      reason: row.reason,
      caution: row.caution,
      submit: () => submitRowAction(row.id, mode),
    });

  const askManualExclude = (hit: ExclusionSearchHit) =>
    setConfirm({
      mode: "apply",
      key: hit.resourceId,
      title: hit.title,
      reason: "manual",
      caution: hit.caution,
      noEffect: hit.alreadyOutOfSitemap,
      submit: () => submitManualExclude(hit),
    });

  const openInEditor = (type: SitemapExclusionResourceType, id: string) => {
    const path = TYPE_PATH[type];
    if (path) handleNavigate(path, { searchParams: new URLSearchParams({ select: id }) });
  };

  const typeLabel = (type: SitemapExclusionResourceType): string => resourceTypeLabel[type] || type;
  const reasonLabel = (reason: string | null): string => (reason ? c[`reason_${reason}`] || reason : "");
  const reasonHelp = (reason: string | null): string => (reason ? c[`reasonHelp_${reason}`] || "" : "");
  const statusLabel = (status: string): string => c[`status_${status}`] || status;

  const analysis = data.analysis;
  const suggested = analysis.exclusions.filter((e) => e.status === "suggested");
  const decided = analysis.exclusions.filter((e) => e.status !== "suggested");

  // The guidance lives inside the intro banner, collapsed by default — it's
  // reference material you read once, not something worth a permanent card.
  const intro = (
    <Banner tone="info" title={c.introTitle}>
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
        <div>
          <Button
            variant="plain"
            disclosure={helpOpen ? "up" : "down"}
            onClick={() => setHelpOpen((v) => !v)}
            ariaExpanded={helpOpen}
            ariaControls="sitemap-guidance"
          >
            {helpOpen ? c.guidanceHide : c.guidanceShow}
          </Button>
        </div>
        <Collapsible open={helpOpen} id="sitemap-guidance" transition={{ duration: "150ms", timingFunction: "ease-in-out" }}>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h4" variant="headingSm">{c.guidanceYesTitle}</Text>
              <List type="bullet">
                <List.Item>{c.guidanceYes1}</List.Item>
                <List.Item>{c.guidanceYes2}</List.Item>
                <List.Item>{c.guidanceYes3}</List.Item>
                <List.Item>{c.guidanceYes4}</List.Item>
              </List>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="h4" variant="headingSm">{c.guidanceNoTitle}</Text>
              <List type="bullet">
                <List.Item>{c.guidanceNo1}</List.Item>
                <List.Item>{c.guidanceNo2}</List.Item>
                <List.Item>{c.guidanceNo3}</List.Item>
                <List.Item>{c.guidanceNo4}</List.Item>
              </List>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="h4" variant="headingSm">{c.guidanceBetterTitle}</Text>
              <List type="bullet">
                <List.Item>{c.guidanceBetter1}</List.Item>
                <List.Item>{c.guidanceBetter2}</List.Item>
                <List.Item>{c.guidanceBetter3}</List.Item>
              </List>
            </BlockStack>
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Banner>
  );

  // "Try again later" is the wrong advice for the most common cause, so the
  // banner names the actual reason and what to do about it.
  const fetchErrorBanner = (
    <Banner tone="warning" title={c.sitemapFetchError}>
      <BlockStack gap="150">
        <Text as="p" variant="bodyMd">
          {analysis.sitemapFailureReason
            ? (c[`fetchError_${analysis.sitemapFailureReason}`] || c.fetchError_unknown)
                .replace("{status}", String(analysis.sitemapHttpStatus ?? ""))
            : c.fetchError_unknown}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {c.fetchErrorAttempted}:{" "}
          <a href={analysis.attemptedSitemapUrl} target="_blank" rel="noreferrer">
            {analysis.attemptedSitemapUrl}
          </a>
        </Text>
      </BlockStack>
    </Banner>
  );

  const body = (
    <BlockStack gap="400">
      {intro}

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">{c.sitemapCardTitle}</Text>
          {analysis.sitemapFetchError ? (
            fetchErrorBanner
          ) : (
            <InlineStack gap="400" wrap>
              <Text as="p" variant="bodyMd">
                {c.sitemapUrlLabel}: <a href={analysis.sitemapUrl ?? undefined} target="_blank" rel="noreferrer">{analysis.sitemapUrl}</a>
              </Text>
              <Text as="p" variant="bodyMd">
                {c.entryCountLabel}: {analysis.entryCount}
              </Text>
            </InlineStack>
          )}
        </BlockStack>
      </Card>

      {banner && (
        <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
          {banner.message}
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">{c.recommendationsTitle}</Text>
          {suggested.length === 0 ? (
            <Text as="p" tone="subdued">{c.empty}</Text>
          ) : (
            <BlockStack gap="300">
              {suggested.map((row) => (
                <InlineStack key={row.id} gap="300" align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge>{typeLabel(row.resourceType)}</Badge>
                      <Button variant="plain" size="slim" onClick={() => openInEditor(row.resourceType, row.resourceId)}>
                        {row.title}
                      </Button>
                      {row.caution && <Badge tone="warning">{c.cautionBadge}</Badge>}
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {c.colReason}: {reasonLabel(row.reason)}
                      {reasonHelp(row.reason) ? ` — ${reasonHelp(row.reason)}` : ""}
                    </Text>
                    {row.caution && (
                      <Text as="span" variant="bodySm" tone="caution">
                        {c.cautionTitle}
                      </Text>
                    )}
                  </BlockStack>
                  <Button
                    size="slim"
                    variant="primary"
                    onClick={() => askExclusionRow(row, "apply")}
                    disabled={rowFetcher.state !== "idle"}
                    loading={pendingId === row.id && rowFetcher.state !== "idle"}
                  >
                    {c.apply}
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      {/* Manual picker — the recommendations only ever surface three rules;
          anything else the merchant wants hidden is chosen here. */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">{c.manualTitle}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{c.manualIntro}</Text>

          {/* Same shared component the "Inhalte" tab uses for its type level,
              so the two read as one system. level3 = flat sub-tabs, which is
              the right weight for a switcher nested inside a card. */}
          <SubNavBar
            variant="level3"
            ariaLabel={c.manualTypeLabel}
            items={MANUAL_TYPE_OPTIONS.map((v) => ({ id: v, label: typeLabel(v), icon: TYPE_ICON[v] }))}
            activeId={manualType}
            onSelect={(item) => changeManualType(item.id as SitemapExclusionResourceType)}
          />

          {/* Search + status filter share one row. The field is deliberately
              not full-width — the filter sits beside it, the way the content
              list pairs its search with a filter control. */}
          <InlineStack gap="200" blockAlign="center" wrap>
            <div style={{ flex: "1 1 220px", minWidth: 200, maxWidth: 380 }}>
              <TextField
                label={c.manualSearchLabel}
                labelHidden
                value={manualQuery}
                onChange={changeManualQuery}
                placeholder={c.manualSearchPlaceholder}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => changeManualQuery("")}
                prefix={<Icon source={SearchIcon} tone="subdued" />}
              />
            </div>
            {/* Products only — no other cached model has a status column. */}
            {manualType === "product" && (
              <div style={{ minWidth: 170 }}>
                <Select
                  label={c.statusFilterLabel}
                  labelHidden
                  options={[
                    { label: c.statusFilterAll, value: "all" },
                    ...PRODUCT_STATUS_OPTIONS.map((v) => ({ label: c[`productStatus_${v}`] || v, value: v })),
                  ]}
                  value={manualStatus}
                  onChange={changeManualStatus}
                />
              </div>
            )}
          </InlineStack>

          {/* `hits` is only rendered when it belongs to the active tab —
              otherwise switching types would briefly show the previous type's
              results under the new tab. */}
          {hits === null ? (
            <Text as="p" tone="subdued">{c.manualLoading}</Text>
          ) : hits.length === 0 ? (
            <Text as="p" tone="subdued">{c.manualNoResults}</Text>
          ) : (
            <BlockStack gap="100">
              {hits.map((hit) => (
                <div
                  key={hit.resourceId}
                  style={{
                    borderTop: "1px solid var(--p-color-border-secondary)",
                    paddingTop: "0.5rem",
                  }}
                >
                  <InlineStack gap="300" align="space-between" blockAlign="center" wrap={false}>
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail
                        size="small"
                        source={hit.imageUrl || ImageIcon}
                        alt=""
                      />
                      <BlockStack gap="050">
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" variant="bodyMd" fontWeight="medium">{hit.title}</Text>
                          {/* Same tone mapping as UnifiedItemList's status
                              badge — UNLISTED is caution, not "info": the
                              product IS live, it just needs a direct link. */}
                          {hit.status && (
                            <Badge
                              tone={
                                hit.status === "ACTIVE"
                                  ? "success"
                                  : hit.status === "UNLISTED"
                                    ? "attention"
                                    : "info"
                              }
                            >
                              {c[`productStatus_${hit.status}`] || hit.status}
                            </Badge>
                          )}
                          {hit.caution && <Badge tone="warning">{c.cautionBadge}</Badge>}
                          {hit.existingStatus === "applied" && (
                            <Badge tone="success">{statusLabel("applied")}</Badge>
                          )}
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">/{hit.handle}</Text>
                      </BlockStack>
                    </InlineStack>

                    <InlineStack gap="150" blockAlign="center" wrap={false}>
                      {/* Any non-ACTIVE product is already absent from
                          sitemap.xml — DRAFT, UNLISTED and (since 2026-07-30)
                          ARCHIVED were each measured, see sitemap.service.ts.
                          Excluding one would write a metafield that changes
                          nothing while reporting "Aktion erfolgreich" and
                          filing the row under "Angewendet". No button at all
                          beats a button that lies. It takes the action slot so
                          the state is where the eye already looks — the same
                          treatment the already-applied case gets. */}
                      {hit.alreadyOutOfSitemap && hit.existingStatus !== "applied" ? (
                        <Tooltip content={c.alreadyOutOfSitemap}>
                          {/* warning, not info: this replaces an action the
                              merchant came here to take, so it has to catch
                              the eye. Not critical — nothing is broken, the
                              state is simply already what they wanted. It can
                              never collide with the yellow cautionBadge, which
                              only applies to pages. */}
                          <Badge tone="warning">{c.alreadyOutOfSitemapBadge}</Badge>
                        </Tooltip>
                      ) : hit.existingStatus !== "applied" ? (
                        <Button
                          size="slim"
                          onClick={() => askManualExclude(hit)}
                          disabled={rowFetcher.state !== "idle"}
                          loading={pendingId === hit.resourceId && rowFetcher.state !== "idle"}
                        >
                          {c.apply}
                        </Button>
                      ) : null}
                      <Tooltip content={c.openInEditor}>
                        <Button
                          variant="plain"
                          size="slim"
                          icon={EditIcon}
                          accessibilityLabel={c.openInEditor}
                          onClick={() => openInEditor(hit.resourceType, hit.resourceId)}
                        />
                      </Tooltip>
                    </InlineStack>
                  </InlineStack>
                </div>
              ))}
            </BlockStack>
          )}

          {manualTotalPages > 1 && (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {c.paginationRange
                  .replace("{start}", String(firstOnPage))
                  .replace("{end}", String(lastOnPage))
                  .replace("{total}", String(manualTotal))}
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Button
                  icon={ChevronLeftIcon}
                  accessibilityLabel={c.paginationPrevious}
                  disabled={serverPage <= 1 || searchFetcher.state !== "idle"}
                  onClick={() => setManualPage(serverPage - 1)}
                />
                <Text as="span" variant="bodySm">{`${serverPage} / ${manualTotalPages}`}</Text>
                <Button
                  icon={ChevronRightIcon}
                  accessibilityLabel={c.paginationNext}
                  disabled={serverPage >= manualTotalPages || searchFetcher.state !== "idle"}
                  onClick={() => setManualPage(serverPage + 1)}
                />
              </InlineStack>
            </InlineStack>
          )}
        </BlockStack>
      </Card>

      {decided.length > 0 && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{c.decidedTitle}</Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={[c.colTitle, c.colType, c.colReason, c.colStatus, c.colActions]}
              rows={decided.map((row) => [
                <Button key={`t-${row.id}`} variant="plain" size="slim" onClick={() => openInEditor(row.resourceType, row.resourceId)}>
                  {row.title}
                </Button>,
                typeLabel(row.resourceType),
                reasonLabel(row.reason),
                statusLabel(row.status),
                row.status === "applied" ? (
                  <Button
                    key={`a-${row.id}`}
                    size="slim"
                    onClick={() => askExclusionRow(row, "revert")}
                    disabled={rowFetcher.state !== "idle"}
                    loading={pendingId === row.id && rowFetcher.state !== "idle"}
                  >
                    {c.revert}
                  </Button>
                ) : (
                  ""
                ),
              ])}
            />
          </BlockStack>
        </Card>
      )}

      {analysis.hasCrawlSnapshot && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{c.brokenTileTitle}</Text>
            <Text as="p" tone="subdued">{c.brokenTileIntro}</Text>
            {analysis.brokenInSitemap.length === 0 ? (
              <Text as="p" tone="subdued">{c.emptyBroken}</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={[c.colBrokenUrl, c.colBrokenStatus]}
                rows={analysis.brokenInSitemap.map((b) => [b.url, String(b.statusCode)])}
              />
            )}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );

  // Spells out the actual effect of the metafield write (out of sitemap +
  // noindex + still reachable + reversible) before anything is sent, and
  // repeats the caution for keep-visible pages where the row's only evidence
  // is a word count.
  const confirmModal = (
    <Modal
      open={!!confirm}
      onClose={() => setConfirm(null)}
      title={confirm?.mode === "revert" ? c.revertConfirmTitle : c.confirmTitle}
      primaryAction={{
        content: confirm?.mode === "revert" ? c.revertCta : c.confirmCta,
        destructive: confirm?.mode === "apply",
        onAction: confirmRowAction,
      }}
      secondaryActions={[{ content: c.confirmCancel, onAction: () => setConfirm(null) }]}
    >
      <Modal.Section>
        {confirm && (
          <BlockStack gap="300">
            {confirm.mode === "revert" ? (
              <Text as="p" variant="bodyMd">
                {c.revertConfirmIntro.replace("{title}", confirm.title)}
              </Text>
            ) : (
              <>
                {confirm.caution && (
                  <Banner tone="warning" title={c.cautionTitle}>
                    <Text as="p" variant="bodyMd">{c.cautionBody}</Text>
                  </Banner>
                )}
                {confirm.noEffect && (
                  <Banner tone="info" title={c.noEffectTitle}>
                    <Text as="p" variant="bodyMd">{c.noEffectBody}</Text>
                  </Banner>
                )}
                <Text as="p" variant="bodyMd">
                  {c.confirmIntro.replace("{title}", confirm.title)}
                </Text>
                <List type="bullet">
                  <List.Item>{c.confirmEffect1}</List.Item>
                  <List.Item>{c.confirmEffect2}</List.Item>
                  <List.Item>{c.confirmEffect3}</List.Item>
                </List>
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {c.confirmReasonLabel}: {reasonLabel(confirm.reason)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {reasonHelp(confirm.reason)}
                  </Text>
                </BlockStack>
                <Text as="p" variant="bodySm" tone="subdued">{c.confirmReversible}</Text>
              </>
            )}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );

  if (data.gated) {
    return (
      <SeoSectionLayout
        sectionId="sitemap"
        lockedExtra={
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{c.upgradeExampleTitle}</Text>
              <BlockStack gap="200">
                {EXAMPLE_ANALYSIS.exclusions.map((row) => (
                  <InlineStack key={row.id} gap="300" align="space-between" blockAlign="center" wrap>
                    <Text as="span" variant="bodySm">
                      {row.title} — {reasonLabel(row.reason)}
                    </Text>
                    <Badge>{typeLabel(row.resourceType)}</Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        }
      >
        {null}
      </SeoSectionLayout>
    );
  }

  return (
    <SeoSectionLayout sectionId="sitemap">
      {body}
      {confirmModal}
    </SeoSectionLayout>
  );
}

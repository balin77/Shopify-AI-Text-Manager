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
import { Card, BlockStack, InlineStack, Text, Badge, Button, Banner, DataTable } from "@shopify/polaris";
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
  type SitemapAnalysis,
  type SitemapExclusionResourceType,
} from "../services/seo/sitemap.service";

const TYPE_PATH: Record<SitemapExclusionResourceType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  page: "/app/pages",
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
  entryCount: 248,
  sitemapFetchError: false,
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
    },
    {
      id: "example-2",
      resourceType: "product",
      resourceId: "example",
      reason: "archivedProduct",
      status: "suggested",
      appliedAt: null,
      title: "Auslaufmodell XY",
      handle: "auslaufmodell-xy",
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

  const openInEditor = (type: SitemapExclusionResourceType, id: string) => {
    const path = TYPE_PATH[type];
    if (path) handleNavigate(path, { searchParams: new URLSearchParams({ select: id }) });
  };

  const typeLabel = (type: SitemapExclusionResourceType): string => resourceTypeLabel[type] || type;
  const reasonLabel = (reason: string | null): string => (reason ? c[`reason_${reason}`] || reason : "");
  const statusLabel = (status: string): string => c[`status_${status}`] || status;

  const analysis = data.analysis;
  const suggested = analysis.exclusions.filter((e) => e.status === "suggested");
  const decided = analysis.exclusions.filter((e) => e.status !== "suggested");

  const body = (
    <BlockStack gap="400">
      <Banner tone="info" title={c.introTitle}>
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
      </Banner>

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">{c.sitemapCardTitle}</Text>
          {analysis.sitemapFetchError ? (
            <Banner tone="warning">{c.sitemapFetchError}</Banner>
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
            <BlockStack gap="200">
              {suggested.map((row) => (
                <InlineStack key={row.id} gap="300" align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge>{typeLabel(row.resourceType)}</Badge>
                      <Button variant="plain" size="slim" onClick={() => openInEditor(row.resourceType, row.resourceId)}>
                        {row.title}
                      </Button>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {c.colReason}: {reasonLabel(row.reason)}
                    </Text>
                  </BlockStack>
                  <Button
                    size="slim"
                    variant="primary"
                    onClick={() => submitRowAction(row.id, "apply")}
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
                    tone="critical"
                    onClick={() => submitRowAction(row.id, "revert")}
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

  return <SeoSectionLayout sectionId="sitemap">{body}</SeoSectionLayout>;
}

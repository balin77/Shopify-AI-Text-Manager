/**
 * Pages Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.pages.old.tsx - we went from ~734 lines to ~150 lines (80% reduction!)
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PAGES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader } from "~/utils/loader-factory.server";

// ============================================================================
// LOADER - Load pages directly from Shopify (no DB sync)
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "PAGES",
  resourceType: "Page",
  itemsKey: "pages",

  async loadData(ctx) {
    // Load pages directly from Shopify (not from DB)
    // This reduces database storage for multi-tenant SaaS
    const pagesResponse = await ctx.admin.graphql(
      `#graphql
        query getPages {
          pages(first: 250) {
            edges {
              node {
                id
                title
                handle
                body
                seoTitle: metafield(namespace: "global", key: "title_tag") { value }
                seoDescription: metafield(namespace: "global", key: "description_tag") { value }
              }
            }
          }
        }`,
    );
    const pagesData = await pagesResponse.json();
    const pages = pagesData.data?.pages?.edges?.map((e: any) => e.node) || [];

    return {
      items: pages.map((p: any) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        body: p.body,
        seo: {
          title: p.seoTitle?.value ?? null,
          description: p.seoDescription?.value ?? null,
        },
      })),
      ids: pages.map((p: any) => p.id),
    };
  },
});

// ============================================================================
// ACTION - Handle all actions via unified handler
// ============================================================================

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  // Load AI settings
  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  // Use unified action handler
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: PAGES_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

export default function PagesPage() {
  const { pages, shopLocales, primaryLocale, markets, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Deep-link from the SEO dashboard: ?select=<Shopify GID> preselects the item.
  const [searchParams] = useSearchParams();
  const initialItemId = searchParams.get("select") || undefined;

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: PAGES_CONFIG,
    items: pages as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
    initialItemId,
  });

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  // Measure page load performance
  useEffect(() => {
    measurePageLoad('PagesPage', {
      pageCount: pages.length,
    });
  }, [pages]);

  return (
    <PlanAccessGate contentType="pages">
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={PAGES_CONFIG}
          items={pages as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={true}
          hideItemListStatusBars={true}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
            { field: "shopifyUpdatedAt", label: "Last Updated", type: "date" },
          ]}
        />
      </div>
    </div>
    </PlanAccessGate>
  );
}

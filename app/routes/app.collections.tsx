/**
 * Collections Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.collections.old.tsx - we went from ~990 lines to ~130 lines (87% reduction!)
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { COLLECTIONS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader, incrementalSync } from "~/utils/loader-factory.server";

// ============================================================================
// LOADER - Incremental sync + load from database
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "COLLECTIONS",
  resourceType: "Collection",
  itemsKey: "collections",

  async loadData(ctx) {
    const { ContentSyncService } = await import("../services/content-sync.service");
    const { getPlanLimits } = await import("../utils/planUtils");
    const syncService = new ContentSyncService(ctx.admin, ctx.session.shop);

    // Load plan limits for collection cap
    const settings = await ctx.db.aISettings.findUnique({
      where: { shop: ctx.session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);
    const maxCollections = planLimits.maxCollections === Infinity ? 250 : Math.min(250, planLimits.maxCollections);

    // Fetch collection IDs from Shopify (capped to plan limit)
    const response = await ctx.admin.graphql(
      `#graphql
        query getCollectionIds($first: Int!) {
          collections(first: $first) {
            edges { node { id } }
          }
        }`,
      { variables: { first: maxCollections } },
    );
    const data = await response.json();
    const shopifyIds = new Set<string>(
      (data.data?.collections?.edges || []).map((e: any) => e.node.id),
    );

    // Sync missing + remove deleted (with plan cap awareness)
    await incrementalSync(ctx, {
      shopifyIds,
      dbModel: ctx.db.collection,
      resourceType: "Collection",
      logPrefix: "COLLECTIONS",
      syncFn: (id) => syncService.syncCollection(id),
      maxItems: planLimits.maxCollections === Infinity ? undefined : planLimits.maxCollections,
    });

    // Load from database (capped to plan limit)
    const collections = await ctx.db.collection.findMany({
      where: { shop: ctx.session.shop },
      orderBy: { title: "asc" },
      ...(planLimits.maxCollections !== Infinity ? { take: planLimits.maxCollections } : {}),
    });

    // Load image alt-text translations from contentTranslation table
    const collectionIds = collections.map((c: any) => c.id);
    const imageAltTranslations = collectionIds.length > 0
      ? await ctx.db.contentTranslation.findMany({
          where: {
            shop: ctx.session.shop,
            resourceId: { in: collectionIds },
            resourceType: "Collection",
            key: "image_alt_text",
          },
        })
      : [];

    // Group translations by collection ID
    const altTranslationsByCollection = new Map<string, Array<{ locale: string; altText: string }>>();
    for (const t of imageAltTranslations) {
      if (!altTranslationsByCollection.has(t.resourceId)) {
        altTranslationsByCollection.set(t.resourceId, []);
      }
      altTranslationsByCollection.get(t.resourceId)!.push({ locale: t.locale, altText: t.value });
    }

    return {
      items: collections.map((c: any) => ({
        id: c.id,
        title: c.title,
        handle: c.handle,
        descriptionHtml: c.descriptionHtml,
        featuredImage: c.imageUrl
          ? {
              url: c.imageUrl,
              altText: c.imageAltText || "",
              altTextTranslations: altTranslationsByCollection.get(c.id) || [],
            }
          : undefined,
        images: [],
        seo: { title: c.seoTitle, description: c.seoDescription },
      })),
      ids: collections.map((c: any) => c.id),
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
    contentConfig: COLLECTIONS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

export default function CollectionsPage() {
  const { collections, shopLocales, primaryLocale, markets, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: COLLECTIONS_CONFIG,
    items: collections as unknown as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
  });

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  // Measure page load performance
  useEffect(() => {
    measurePageLoad('CollectionsPage', {
      collectionCount: collections.length,
    });
  }, [collections]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={COLLECTIONS_CONFIG}
          items={collections as unknown as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={false}
          hideItemListStatusBars={true}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
            { field: "shopifyUpdatedAt", label: "Last Updated", type: "date" },
          ]}
        />
      </div>
    </div>
  );
}

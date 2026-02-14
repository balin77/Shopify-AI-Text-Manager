/**
 * Collections Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.collections.old.tsx - we went from ~990 lines to ~130 lines (87% reduction!)
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { COLLECTIONS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { logger } from "~/utils/logger.server";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");

    // Load shopLocales (with caching)
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    // Incremental sync: fetch collection IDs from Shopify, sync only missing ones
    const { ContentSyncService } = await import("../services/content-sync.service");
    const syncService = new ContentSyncService(admin, session.shop);

    const collectionsResponse = await admin.graphql(
      `#graphql
        query getCollectionIds {
          collections(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );
    const collectionsData = await collectionsResponse.json();
    const shopifyCollectionIds = new Set<string>(
      (collectionsData.data?.collections?.edges || []).map((e: any) => e.node.id)
    );

    const localCollections = await db.collection.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const localCollectionIds = new Set(localCollections.map(c => c.id));

    // Sync missing collections
    const missingIds = [...shopifyCollectionIds].filter(id => !localCollectionIds.has(id));
    if (missingIds.length > 0) {
      logger.info(`[COLLECTIONS-LOADER] Syncing ${missingIds.length} new collection(s) from Shopify`);
      await Promise.all(missingIds.map(id => syncService.syncCollection(id)));
    }

    // Remove deleted collections
    const removedIds = [...localCollectionIds].filter(id => !shopifyCollectionIds.has(id));
    if (removedIds.length > 0) {
      logger.info(`[COLLECTIONS-LOADER] Removing ${removedIds.length} deleted collection(s) from DB`);
      await db.collection.deleteMany({
        where: { shop: session.shop, id: { in: removedIds } },
      });
      await db.contentTranslation.deleteMany({
        where: { resourceType: 'Collection', resourceId: { in: removedIds } },
      });
    }

    // Load collections from database
    const [collections, aiSettings] = await Promise.all([
      db.collection.findMany({
        where: { shop: session.shop },
        orderBy: { title: 'asc' },
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    // Load translations only for this shop's collections
    const collectionIds = collections.map(c => c.id);
    const allTranslations = collectionIds.length > 0
      ? await db.contentTranslation.findMany({
          where: {
            resourceType: 'Collection',
            resourceId: { in: collectionIds }
          }
        })
      : [];

    // Group translations by resourceId
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform collections
    const transformedCollections = collections.map(c => ({
      id: c.id,
      title: c.title,
      handle: c.handle,
      descriptionHtml: c.descriptionHtml,
      featuredImage: c.imageUrl ? {
        url: c.imageUrl,
        altText: c.imageAltText || '',
      } : undefined,
      images: [], // Collections only have featured image, no gallery
      seo: {
        title: c.seoTitle,
        description: c.seoDescription,
      },
      translations: translationsByResource[c.id] || [],
    }));

    return json({
      collections: transformedCollections,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      aiSettings,
    });
  } catch (error: any) {
    logger.error("[COLLECTIONS-LOADER] Error", { error: error instanceof Error ? error.message : String(error) });
    return json({
      collections: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "en",
      error: error.message,
      aiSettings: null,
    }, { status: 500 });
  }
};

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
  const { collections, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
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
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MainNavigation />
      <ContentTypeNavigation />
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
            { field: "shopifyUpdatedAt", label: "Last Updated" },
          ]}
        />
      </div>
    </div>
  );
}

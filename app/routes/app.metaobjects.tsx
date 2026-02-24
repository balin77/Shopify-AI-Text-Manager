/**
 * Metaobjects Management - Manage metaobject option values
 *
 * This page displays metaobjects that are linked to product options.
 * NOTE: Currently shows ALL metaobjects. Future enhancement: Filter to show
 * ONLY metaobjects that are actually used as product option values.
 *
 * Only the metaobject VALUES are editable/translatable here - names are NOT editable.
 * Uses the UnifiedContentEditor system for consistency.
 */

import { useEffect } from "react";
import { type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { METAOBJECTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader } from "~/utils/loader-factory.server";
import { logger } from "~/utils/logger.server";

// ============================================================================
// LOADER - Load metaobjects with fields
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "METAOBJECTS",
  resourceType: "Metaobject",
  itemsKey: "metaobjects",

  async loadData(ctx) {
    const { db } = await import("../db.server");

    // LAZY LOADING: Load navigation metadata (type list) from DB
    const definitions = await db.metaobjectDefinition.findMany({
      where: {
        shop: ctx.shop
      },
      orderBy: {
        name: 'asc'
      }
    });

    if (definitions.length === 0) {
      return { items: [], ids: [] };
    }

    // For each type, count metaobjects from DB
    const metaobjectTypes: any[] = [];

    for (const definition of definitions) {
      try {
        // Count metaobjects for this type from DB
        const count = await db.metaobject.count({
          where: {
            shop: ctx.shop,
            type: definition.type
          }
        });

        // Create lightweight navigation item (no full metaobject data)
        const typeItem = {
          id: `metaobject_type_${definition.type}`,
          type: definition.type,
          title: definition.name,
          handle: definition.type,
          definitionName: definition.name,
          definitionId: definition.id,
          role: "METAOBJECT_TYPE",
          contentCount: count,
          metaobjects: [], // Empty - will be loaded on-demand via API route
          translations: [], // Empty - will be loaded on-demand
        };

        logger.debug('[METAOBJECTS-LOADER] Type item created from DB', {
          type: definition.type,
          count
        });

        metaobjectTypes.push(typeItem);
      } catch (error) {
        logger.error('[METAOBJECTS-LOADER] Error counting metaobjects for type', {
          error: error instanceof Error ? error.message : String(error),
          type: definition.type
        });
      }
    }

    return {
      items: metaobjectTypes,
      ids: metaobjectTypes.map((t: any) => t.id),
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
    contentConfig: METAOBJECTS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Configuration only!
// ============================================================================

export default function MetaobjectsPage() {
  const { metaobjects, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: METAOBJECTS_CONFIG,
    items: metaobjects as unknown as ContentItem[],
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
    measurePageLoad('MetaobjectsPage', {
      metaobjectCount: metaobjects.length,
    });
  }, [metaobjects]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MainNavigation />
      <ContentTypeNavigation />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={METAOBJECTS_CONFIG}
          items={metaobjects}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={true}
          hideItemListStatusBars={true}
          revalidator={revalidator}
        />
      </div>
    </div>
  );
}

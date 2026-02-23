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
    const { ContentService } = await import("../services/content.service");
    const contentService = new ContentService(ctx.admin);

    // Load metaobject definitions
    const definitions = await contentService.getMetaobjectDefinitions(50);

    logger.info('[METAOBJECTS-LOADER] Metaobject definitions loaded', {
      count: definitions.length,
      types: definitions.map((d: any) => ({ type: d.type, name: d.name }))
    });

    if (definitions.length === 0) {
      logger.warn('[METAOBJECTS-LOADER] No metaobject definitions found');
      return { items: [], ids: [] };
    }

    const allMetaobjects: any[] = [];

    // For each definition, fetch metaobjects with fields
    for (const definition of definitions) {
      try {
        logger.debug('[METAOBJECTS-LOADER] Fetching metaobjects for type', {
          type: definition.type,
          name: definition.name
        });

        const response = await ctx.admin.graphql(
          `#graphql
            query getMetaobjectsWithFields($type: String!, $first: Int!) {
              metaobjects(type: $type, first: $first) {
                edges {
                  node {
                    id
                    handle
                    displayName
                    type
                    updatedAt
                    fields {
                      key
                      value
                      type
                    }
                  }
                }
              }
            }`,
          {
            variables: { type: definition.type, first: 50 }
          }
        );
        const data = await response.json();

        // Check for GraphQL errors
        if (data.errors) {
          logger.error('[METAOBJECTS-LOADER] GraphQL errors', {
            type: definition.type,
            errors: data.errors
          });
          continue;
        }

        const metaobjects = data.data?.metaobjects?.edges?.map((edge: { node: any }) => ({
          ...edge.node,
          definitionName: definition.name,
          fields: edge.node.fields || [],
        })) || [];

        logger.debug('[METAOBJECTS-LOADER] Fetched metaobjects', {
          type: definition.type,
          count: metaobjects.length
        });

        allMetaobjects.push(...metaobjects);
      } catch (error) {
        logger.error('[METAOBJECTS-LOADER] Error fetching metaobjects for type', {
          error: error instanceof Error ? error.message : String(error),
          type: definition.type
        });
      }
    }

    logger.info('[METAOBJECTS-LOADER] Loaded metaobjects', { count: allMetaobjects.length });

    return {
      items: allMetaobjects,
      ids: allMetaobjects.map((m: any) => m.id),
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

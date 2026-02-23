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

    if (definitions.length === 0) {
      return { items: [], ids: [] };
    }

    // Group items: Each "item" is a metaobject definition with its metaobjects
    const groupedItems: any[] = [];

    for (const definition of definitions) {
      try {
        // Fetch metaobjects for this type WITH translations
        const response = await ctx.admin.graphql(
          `#graphql
            query getMetaobjectsWithTranslations($type: String!, $first: Int!) {
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
                    translations(locale: "*") {
                      key
                      value
                      locale
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

        if (data.errors) {
          logger.error('[METAOBJECTS-LOADER] GraphQL errors', {
            type: definition.type,
            errors: data.errors
          });
          continue;
        }

        const metaobjects = data.data?.metaobjects?.edges?.map((edge: { node: any }) => edge.node) || [];

        // Build translations array for the unified editor
        // Format: { key: metaobjectId, value: translatedLabel, locale: "de" }
        const translationsArray: any[] = [];

        metaobjects.forEach((metaobj: any) => {
          // Get translations for this metaobject
          if (metaobj.translations && Array.isArray(metaobj.translations)) {
            metaobj.translations.forEach((trans: any) => {
              // Only include display_name/name/label translations
              if (trans.key === 'display_name' || trans.key === 'name' || trans.key === 'label') {
                translationsArray.push({
                  key: metaobj.id, // Use metaobject ID as translation key
                  value: trans.value,
                  locale: trans.locale,
                });
              }
            });
          }
        });

        // Create a grouped item representing this metaobject type
        // Structure: One "item" per type, containing all metaobjects of that type
        const groupItem = {
          id: `metaobject_type_${definition.type}`,
          type: definition.type,
          title: definition.name, // Display name for the type
          handle: definition.type,
          definitionName: definition.name,
          definitionId: definition.id,
          metaobjects: metaobjects, // All metaobjects of this type
          translations: translationsArray, // Translations for all metaobjects
        };

        groupedItems.push(groupItem);
      } catch (error) {
        logger.error('[METAOBJECTS-LOADER] Error fetching metaobjects for type', {
          error: error instanceof Error ? error.message : String(error),
          type: definition.type
        });
      }
    }

    return {
      items: groupedItems,
      ids: groupedItems.map((g: any) => g.id),
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

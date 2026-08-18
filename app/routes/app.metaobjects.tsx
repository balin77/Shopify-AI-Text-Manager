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

import { useEffect, useState, useMemo, useRef } from "react";
import { type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import {
  resolveMetaobjectSelection,
  type MetaobjectTypeItem,
} from "../services/metaobject-select.shared";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { METAOBJECTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader } from "~/utils/loader-factory.server";
import { logger } from "~/utils/logger.server";
import type { FetcherData } from "~/types/content-editor.types";

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
        shop: ctx.session.shop
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
            shop: ctx.session.shop,
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

    // A `?select=` carrying a Metaobject GID -- what the product editor sends
    // for a linked option value -- names an ENTRY, and this page's items are
    // TYPES (`metaobject_type_<type>`). Only the server can bridge that: the
    // cache knows which type an entry belongs to. Resolved here so the client
    // has an id it can actually match, instead of a GID that matches nothing.
    let selectedType: string | undefined;
    const select = new URL(ctx.request.url).searchParams.get("select") ?? "";
    if (select.startsWith("gid://shopify/Metaobject/")) {
      try {
        const entry = await db.metaobject.findFirst({
          where: { shop: ctx.session.shop, id: select },
          select: { type: true },
        });
        selectedType = entry?.type ?? undefined;
      } catch {
        // An unresolvable id is a page that opens where it usually does, which
        // is what happened before this link existed.
        selectedType = undefined;
      }
    }

    return {
      items: metaobjectTypes,
      ids: metaobjectTypes.map((t: any) => t.id),
      selectedType,
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
  const { metaobjects, shopLocales, primaryLocale, markets, error, aiSettings, selectedType } =
    useLoaderData<typeof loader>() as ReturnType<typeof useLoaderData<typeof loader>> & { selectedType?: string };
  const fetcher = useFetcher<FetcherData>();
  const entryFetcher = useFetcher();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const [searchParams] = useSearchParams();

  // Track loaded entries per metaobject type (keyed by item id)
  const [loadedEntries, setLoadedEntries] = useState<Record<string, any>>({});
  const loadingTypeRef = useRef<string | null>(null);

  // Augment metaobjects with lazily loaded entries
  const augmentedMetaobjects = useMemo(() => {
    return metaobjects.map((item: any) => {
      const loaded = loadedEntries[item.id];
      if (!loaded) return item;
      return {
        ...item,
        metaobjects: loaded.metaobjects,
        translations: loaded.translations,
        marketTranslations: loaded.marketTranslations,
        contentCount: loaded.contentCount ?? item.contentCount,
      };
    });
  }, [metaobjects, loadedEntries]);

  // Resolve ?select= URL param to an initial item ID (e.g. linked from product options)
  // `selectedType` is set by the loader when `?select=` carried a Metaobject GID.
  const selectParam = searchParams.get("select");
  const initialItemId = useMemo(
    // The rule lives in its own module because it is not testable inline —
    // which is how it shipped wrong. See `metaobject-select.shared.ts`.
    () => resolveMetaobjectSelection(metaobjects as MetaobjectTypeItem[], selectParam, selectedType),
    [selectParam, selectedType, metaobjects],
  );

  // Initialize unified content editor with augmented items
  const editor = useUnifiedContentEditor({
    config: METAOBJECTS_CONFIG,
    items: augmentedMetaobjects as unknown as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
    initialItemId,
  });

  // Lazy load entries when a type is selected
  useEffect(() => {
    const selectedId = editor.state.selectedItemId;
    if (!selectedId) return;

    // Already loaded or currently loading this type
    if (loadedEntries[selectedId] || loadingTypeRef.current === selectedId) return;

    // Find the item to get its type
    const item = metaobjects.find((m: any) => m.id === selectedId);
    if (!item?.type) return;

    loadingTypeRef.current = selectedId;
    entryFetcher.load(`/api/metaobjects/${item.type}`);
  }, [editor.state.selectedItemId, metaobjects, loadedEntries]);

  // Process entry fetcher response
  useEffect(() => {
    if (entryFetcher.state === "idle" && entryFetcher.data) {
      const data = (entryFetcher.data as any)?.metaobject;
      if (data?.id) {
        setLoadedEntries((prev) => ({
          ...prev,
          [data.id]: data,
        }));
      }
      loadingTypeRef.current = null;
    }
  }, [entryFetcher.state, entryFetcher.data]);

  // Reset loaded entries when loader data changes (e.g. after sync)
  useEffect(() => {
    setLoadedEntries({});
  }, [metaobjects]);

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
    <PlanAccessGate contentType="metaobjects">
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={METAOBJECTS_CONFIG}
          items={augmentedMetaobjects}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={true}
          hideItemListStatusBars={true}
          revalidator={revalidator}
          isFieldsLoading={entryFetcher.state !== "idle" || (!!editor.state.selectedItemId && !loadedEntries[editor.state.selectedItemId])}
        />
      </div>
    </div>
    </PlanAccessGate>
  );
}

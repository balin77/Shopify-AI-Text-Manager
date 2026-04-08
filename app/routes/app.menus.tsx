/**
 * Menus Management — Translate store navigation menus
 *
 * Uses Shopify's MENU/LINK translatable resource types to enable
 * translation of menu titles and menu item (link) titles.
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { MENUS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader, incrementalSync } from "~/utils/loader-factory.server";
import type { ContentItem } from "../types/content-editor.types";

// ============================================================================
// Types
// ============================================================================

/** Menu item stored in JSON */
interface StoredMenuItem {
  id: string;
  title: string;
  url: string | null;
  type: string;
  items?: StoredMenuItem[];
}

/** Link resource entry stored in Menu.linkResources JSON */
interface LinkResourceEntry {
  resourceId: string;
  title: string;
}

// ============================================================================
// LOADER — Incremental sync + load from database with translations
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "MENUS",
  resourceType: "Menu",
  itemsKey: "menus",

  async loadData(ctx) {
    const { ContentSyncService } = await import("../services/content-sync.service");
    const syncService = new ContentSyncService(ctx.admin, ctx.session.shop);

    // Fetch menu IDs from Shopify
    const response = await ctx.admin.graphql(
      `#graphql
        query getMenuIds {
          menus(first: 250) {
            edges { node { id } }
          }
        }`,
    );
    const data = await response.json();
    const shopifyIds = new Set<string>(
      (data.data?.menus?.edges || []).map((e: { node: { id: string } }) => e.node.id),
    );

    // Sync missing + remove deleted
    await incrementalSync(ctx, {
      shopifyIds,
      dbModel: ctx.db.menu,
      resourceType: "Menu",
      logPrefix: "MENUS",
      syncFn: (id) => syncService.syncMenu(id),
    });

    // Load from database
    const menus = await ctx.db.menu.findMany({
      where: { shop: ctx.session.shop },
      orderBy: { title: "asc" },
    });

    // Build menu items for the editor.
    // Each menu is a content item; its menuLinks are built from linkResources.
    const items = menus.map((menu) => {
      const linkResources = (menu.linkResources ?? {}) as unknown as Record<string, LinkResourceEntry>;
      const menuLinks = Object.values(linkResources).map((link) => ({
        resourceId: link.resourceId,
        title: link.title,
        menuItemId: link.resourceId,
      }));

      return {
        id: menu.id,
        title: menu.title,
        handle: menu.handle,
        menuLinks,
      };
    });

    // Collect all resource IDs that have translations:
    // Menu GIDs (for menu title translations) + Link GIDs (for link translations)
    const ids: string[] = [];
    for (const menu of menus) {
      ids.push(menu.id);
      const linkResources = (menu.linkResources ?? {}) as unknown as Record<string, LinkResourceEntry>;
      for (const link of Object.values(linkResources)) {
        ids.push(link.resourceId);
      }
    }

    // Load translations for both Menu and Link resources
    const allTranslations = await ctx.db.contentTranslation.findMany({
      where: {
        shop: ctx.session.shop,
        resourceType: { in: ["Menu", "Link"] },
        resourceId: { in: ids },
      },
    });

    // Attach translations to items — for each menu, merge its own translations
    // with translations of all its links into a single flat translations array.
    const translationsByResourceId = new Map<string, Array<{ key: string; value: string; locale: string }>>();
    for (const t of allTranslations) {
      const arr = translationsByResourceId.get(t.resourceId) ?? [];
      arr.push({ key: t.key, value: t.value, locale: t.locale });
      translationsByResourceId.set(t.resourceId, arr);
    }

    const itemsWithTranslations = items.map((item) => {
      // Menu title translations use key "title"
      const menuTranslations = (translationsByResourceId.get(item.id) ?? []).map((t) => ({
        key: "title",
        value: t.value,
        locale: t.locale,
      }));

      // Link translations: remap key from "title" to the link's resourceId
      // (so the UnifiedContentEditor can match them to the dynamic field keys)
      const linkTranslations: Array<{ key: string; value: string; locale: string }> = [];
      for (const link of item.menuLinks) {
        const translations = translationsByResourceId.get(link.resourceId) ?? [];
        for (const t of translations) {
          linkTranslations.push({
            key: link.resourceId, // field key = link resource GID
            value: t.value,
            locale: t.locale,
          });
        }
      }

      return {
        ...item,
        translations: [...menuTranslations, ...linkTranslations],
      };
    });

    return { items: itemsWithTranslations, ids: [] };
  },
});

// ============================================================================
// ACTION — Handle all actions via unified handler
// ============================================================================

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: MENUS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT
// ============================================================================

export default function MenusPage() {
  const { menus, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  const editor = useUnifiedContentEditor({
    config: MENUS_CONFIG,
    items: menus as unknown as ContentItem[],
    shopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
  });

  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  useEffect(() => {
    measurePageLoad("MenusPage", { menuCount: menus.length });
  }, [menus]);

  return (
    <PlanAccessGate contentType="menus">
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <MainNavigation />
        <ContentTypeNavigation />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <UnifiedContentEditor
            config={MENUS_CONFIG}
            items={menus as unknown as ContentItem[]}
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
    </PlanAccessGate>
  );
}

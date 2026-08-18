/**
 * Menus Management - View store navigation menus
 *
 * Note: Menus are READ-ONLY because Shopify API doesn't support
 * translating menu items via GraphQL API
 */

import { useState, useEffect, type ReactElement } from "react";
import { useLoaderData } from "react-router";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  Banner,
  TextField,
} from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { CONTENT_MAX_HEIGHT } from "../constants/layout";
import { createContentLoader, incrementalSync } from "~/utils/loader-factory.server";

// ============================================================================
// LOADER - Incremental sync + load from database (read-only, no translations)
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "MENUS",
  resourceType: null, // Menus don't have translations
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
      (data.data?.menus?.edges || []).map((e: any) => e.node.id),
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

    return { items: menus, ids: [] };
  },
});

export default function MenusPage() {
  const { menus, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { getTotalNavHeight } = useNavigationHeight();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Parse menu items from JSON
  const parsedMenus = menus.map((menu: any) => ({
    ...menu,
    items: Array.isArray(menu.items) ? menu.items : []
  }));

  const selectedItem = parsedMenus.find((item: any) => item.id === selectedItemId);

  // Auto-select first item on mount
  useEffect(() => {
    if (parsedMenus.length > 0 && !selectedItemId) {
      setSelectedItemId(parsedMenus[0].id);
    }
  }, [parsedMenus, selectedItemId]);

  // Recursive function to render menu items with unlimited nesting
  const renderMenuItem = (item: any, index: number, path: number[]): ReactElement => {
    const label = `Menu Item ${path.join('.')}`;

    return (
      <div key={item.id || index} style={{ marginBottom: "0.5rem" }}>
        <TextField
          label={label}
          value={item.title}
          onChange={() => {}}
          disabled
          autoComplete="off"
        />
        {item.items && item.items.length > 0 && (
          <div style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
            {item.items.map((subItem: any, subIndex: number) =>
              renderMenuItem(subItem, subIndex, [...path, subIndex + 1])
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <PlanAccessGate contentType="menus">
    <Page fullWidth>
      {/* Own viewport calc rather than height:100% (the Polaris Page chain has
          no definite height here). It therefore has to subtract the bottom
          inset itself — the app shell's padding-bottom does not reach a box
          sized off the viewport. */}
      {/* Capped at the shared content width (.app-page-width-start,
          responsive.css :root) — this page has no SEO-score sidebar, so nothing
          else would stop the editor column from growing on a wide screen.
          Left-aligned, so the menus list stays flush with the gutter. */}
      <div className="app-page-width-start" style={{ height: `calc(var(--app-shell-height) - ${getTotalNavHeight()}px - var(--app-bottom-inset))`, display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Menus List. Width from --app-list-column-width
            (responsive.css :root), the same token every other item column of
            the app spends — do not hardcode a width here. */}
        <div style={{ width: "var(--app-list-column-width)", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.menus || "Menus"} ({parsedMenus.length})
              </Text>
            </div>
            <div style={{ maxHeight: CONTENT_MAX_HEIGHT, overflowY: "auto" }}>
              {parsedMenus.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Menu", plural: "Menus" }}
                  items={parsedMenus}
                  renderItem={(item: any) => {
                    const { id, title } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => setSelectedItemId(id)}
                      >
                        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                          {title}
                        </Text>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content?.noEntries || "No menus found"}
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Menu Viewer */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content?.error || "Error"} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {selectedItem ? (
              <BlockStack gap="500">
                {/* API Limitation Banner */}
                <Banner tone="warning">
                  <p>{t.content?.menuLimitation || "Menu items cannot be translated via the Shopify API. This is a limitation of the Shopify platform."}</p>
                </Banner>

                {/* Item ID */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.content?.idPrefix || "ID:"} {selectedItem.id.split("/").pop()}
                </Text>

                {/* Menu Title */}
                <TextField
                  label="Menu Title"
                  value={selectedItem.title}
                  onChange={() => {}}
                  disabled
                  autoComplete="off"
                />

                {/* Menu Handle */}
                <TextField
                  label="Menu Handle"
                  value={selectedItem.handle}
                  onChange={() => {}}
                  disabled
                  autoComplete="off"
                />

                {/* Menu Items */}
                {selectedItem.items && selectedItem.items.length > 0 && (
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h3" variant="headingMd">
                        Menu Items ({selectedItem.items.length})
                      </Text>
                      {selectedItem.items.map((item: any, index: number) =>
                        renderMenuItem(item, index, [index + 1])
                      )}
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">
                  {t.content?.selectFromList || "Select a menu from the list"}
                </Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
    </PlanAccessGate>
  );
}

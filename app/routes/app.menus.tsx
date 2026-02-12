/**
 * Menus Management - View store navigation menus
 *
 * Note: Menus are READ-ONLY because Shopify API doesn't support
 * translating menu items via GraphQL API
 */

import { useState, useEffect, type ReactElement } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { useI18n } from "../contexts/I18nContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { CONTENT_MAX_HEIGHT } from "../constants/layout";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Load shopLocales
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    // Incremental sync: fetch menu IDs from Shopify, sync only missing ones
    const { db } = await import("../db.server");
    const { ContentSyncService } = await import("../services/content-sync.service");
    const syncService = new ContentSyncService(admin, session.shop);

    const menusResponse = await admin.graphql(
      `#graphql
        query getMenuIds {
          menus(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );
    const menusData = await menusResponse.json();
    const shopifyMenuIds = new Set<string>(
      (menusData.data?.menus?.edges || []).map((e: any) => e.node.id)
    );

    let localMenus: any[] = [];
    try {
      localMenus = await db.menu.findMany({
        where: { shop: session.shop },
        select: { id: true },
      });
    } catch (dbError: any) {
      // If table doesn't exist yet, treat as empty
      if (dbError.code === 'P2021') {
        logger.debug("[MENUS-LOADER] Menu table does not exist yet", { context: "Menus" });
      }
    }
    const localMenuIds = new Set(localMenus.map(m => m.id));

    // Sync missing menus
    const missingIds = [...shopifyMenuIds].filter(id => !localMenuIds.has(id));
    if (missingIds.length > 0) {
      logger.info(`[MENUS-LOADER] Syncing ${missingIds.length} new menu(s) from Shopify`);
      for (const id of missingIds) {
        await syncService.syncMenu(id);
      }
    }

    // Remove deleted menus
    const removedIds = [...localMenuIds].filter(id => !shopifyMenuIds.has(id));
    if (removedIds.length > 0) {
      logger.info(`[MENUS-LOADER] Removing ${removedIds.length} deleted menu(s) from DB`);
      await db.menu.deleteMany({
        where: { shop: session.shop, id: { in: removedIds } },
      });
    }

    // Load menus from database
    let menus: any[] = [];
    try {
      menus = await db.menu.findMany({
        where: { shop: session.shop },
        orderBy: { title: "asc" },
      });
    } catch (dbError: any) {
      logger.error("[MENUS-LOADER] Failed to load menus from DB", { context: "Menus", error: dbError.message });
    }

    return json({
      menus,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    logger.error("[MENUS-LOADER] Error", { context: "Menus", error: error.message, stack: error.stack });
    return json({
      menus: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "en",
      error: error.message
    }, { status: 500 });
  }
};

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
    <Page fullWidth>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: `calc(100vh - ${getTotalNavHeight()}px)`, display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Menus List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
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
  );
}

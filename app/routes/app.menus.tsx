/**
 * Menus Management - View store navigation menus
 *
 * Note: Menus are READ-ONLY because Shopify API doesn't support
 * translating menu items via GraphQL API
 */

import { useState, type ReactElement } from "react";
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
import { useI18n } from "../contexts/I18nContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { ContentService } from "../services/content.service";

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
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    // Try to load menus from database first
    console.log(`[MENUS-LOADER] Attempting to load menus from database for shop: ${session.shop}`);
    const { db } = await import("../db.server");

    let menus = [];
    try {
      menus = await db.menu.findMany({
        where: { shop: session.shop },
        orderBy: { title: "asc" }
      });
      console.log(`[MENUS-LOADER] ✅ Successfully loaded ${menus.length} menus from database`);

      if (menus.length > 0) {
        console.log(`[MENUS-LOADER] Sample menu:`, {
          id: menus[0].id,
          title: menus[0].title,
          hasItems: !!menus[0].items,
          itemsType: typeof menus[0].items
        });
      }
    } catch (dbError: any) {
      console.error(`[MENUS-LOADER] ❌ Database error:`, dbError.message);
      console.error(`[MENUS-LOADER] Error code:`, dbError.code);
      // If table doesn't exist, continue to API fallback
      if (dbError.code === 'P2021') {
        console.log(`[MENUS-LOADER] Menu table does not exist yet, falling back to API`);
      }
    }

    // If no menus in database, fetch from API and cache them
    if (menus.length === 0) {
      console.log("[MENUS-LOADER] No cached menus found, fetching from Shopify API...");
      const contentService = new ContentService(admin);
      const apiMenus = await contentService.getMenus();
      console.log(`[MENUS-LOADER] API returned ${apiMenus.length} menus`);

      // Cache them in database
      if (apiMenus.length > 0) {
        console.log("[MENUS-LOADER] Starting sync to database...");
        const { ContentSyncService } = await import("../services/content-sync.service");
        const syncService = new ContentSyncService(admin, session.shop);

        try {
          await syncService.syncAllMenus();
          console.log("[MENUS-LOADER] ✅ Sync completed successfully");

          // Re-fetch from database
          menus = await db.menu.findMany({
            where: { shop: session.shop },
            orderBy: { title: "asc" }
          });
          console.log(`[MENUS-LOADER] ✅ Successfully cached and re-fetched ${menus.length} menus from database`);
        } catch (syncError: any) {
          console.error(`[MENUS-LOADER] ❌ Sync failed:`, syncError.message);
          console.log(`[MENUS-LOADER] Falling back to API data`);
          // Use API data as fallback
          menus = apiMenus;
        }
      } else {
        console.log("[MENUS-LOADER] No menus found in API either");
      }
    } else {
      console.log(`[MENUS-LOADER] 🚀 Using cached menus (${menus.length}) - FAST PATH!`);
    }

    return json({
      menus,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[MENUS-LOADER] Error:", error);
    return json({
      menus: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export default function MenusPage() {
  const { menus, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { mainNavHeight } = useNavigationHeight();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Parse menu items from JSON
  const parsedMenus = menus.map((menu: any) => ({
    ...menu,
    items: Array.isArray(menu.items) ? menu.items : []
  }));

  const selectedItem = parsedMenus.find((item: any) => item.id === selectedItemId);

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

      <div style={{ height: `calc(100vh - ${mainNavHeight}px)`, display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Menus List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.menus || "Menus"} ({parsedMenus.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
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

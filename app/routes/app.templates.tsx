/**
 * Theme Templates Management - View and manage theme translatable content
 *
 * Displays theme content grouped by resource type (Articles, Collections, Pages, etc.)
 */

import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  ResourceList,
  ResourceItem,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ThemeContentViewer } from "../components/ThemeContentViewer";
import { useI18n } from "../contexts/I18nContext";

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

    // LAZY LOADING: Only load navigation metadata, not the full content
    const { db } = await import("../db.server");

    // Load only unique groups with their metadata (no translatableContent or translations)
    const themeGroups = await db.themeContent.findMany({
      where: { shop: session.shop },
      select: {
        groupId: true,
        groupName: true,
        groupIcon: true,
      },
      distinct: ['groupId'],
      orderBy: { groupName: 'asc' }
    });

    // Count content items per group
    const contentCounts = await Promise.all(
      themeGroups.map(async (group) => {
        const count = await db.themeContent.count({
          where: {
            shop: session.shop,
            groupId: group.groupId
          }
        });
        return { groupId: group.groupId, count };
      })
    );

    const countMap = Object.fromEntries(
      contentCounts.map(c => [c.groupId, c.count])
    );

    // Create lightweight navigation items (sorted alphabetically)
    const themes = themeGroups
      .map(group => ({
        id: `group_${group.groupId}`,
        title: group.groupName,
        name: group.groupName,
        icon: group.groupIcon,
        groupId: group.groupId,
        role: 'THEME_GROUP',
        contentCount: countMap[group.groupId] || 0
      }))
      .sort((a, b) => a.title.localeCompare(b.title)); // Alphabetical sort

    return json({
      themes,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[TEMPLATES-LOADER] Error:", error);
    return json({
      themes: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export default function TemplatesPage() {
  const { themes, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [loadedThemes, setLoadedThemes] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(false);

  // Auto-select and load first item on mount
  useEffect(() => {
    if (themes.length > 0 && !selectedItemId) {
      const firstTheme = themes[0];
      setSelectedItemId(firstTheme.id);
      loadThemeData(firstTheme.groupId);
    }
  }, [themes]);

  // Function to load theme data on-demand
  const loadThemeData = async (groupId: string) => {
    // Check if already loaded
    if (loadedThemes[groupId]) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/templates/${groupId}`);
      if (!response.ok) {
        throw new Error('Failed to load theme data');
      }
      const data = await response.json();

      setLoadedThemes(prev => ({
        ...prev,
        [groupId]: data.theme
      }));
    } catch (error) {
      console.error('Error loading theme data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle item click: load data if not loaded, then select
  const handleItemClick = (itemId: string, groupId: string) => {
    setSelectedItemId(itemId);
    loadThemeData(groupId);
  };

  // Get selected item from loaded themes or navigation data
  const selectedItem = selectedItemId && loadedThemes[themes.find((t: any) => t.id === selectedItemId)?.groupId];

  return (
    <Page fullWidth>
      <MainNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Theme Resources List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.templates || "Theme Content"} ({themes.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {themes.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Resource", plural: "Resources" }}
                  items={themes}
                  renderItem={(item: any) => {
                    const { id, title, icon, contentCount, groupId } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => handleItemClick(id, groupId)}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {icon && <span style={{ marginRight: "0.5rem" }}>{icon}</span>}
                            {title}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {contentCount} translatable fields
                          </Text>
                        </BlockStack>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content?.noEntries || "No theme resources found"}
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Theme Content Viewer */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content?.error || "Error"} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {isLoading ? (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <BlockStack gap="300">
                  <Text as="p" variant="headingLg">
                    Loading...
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Loading theme content data
                  </Text>
                </BlockStack>
              </div>
            ) : selectedItem ? (
              <BlockStack gap="500">
                {/* Language Selector */}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {shopLocales.map((locale: any) => (
                    <Button
                      key={locale.locale}
                      variant={currentLanguage === locale.locale ? "primary" : undefined}
                      onClick={() => setCurrentLanguage(locale.locale)}
                      size="slim"
                    >
                      {locale.name} {locale.primary && `(${t.content?.primaryLanguageSuffix || "Primary"})`}
                    </Button>
                  ))}
                </div>

                {/* Item ID */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.content?.idPrefix || "ID:"} {selectedItem.id.split("/").pop()}
                </Text>

                {/* Theme Content Viewer */}
                <ThemeContentViewer
                  themeResource={selectedItem}
                  currentLanguage={currentLanguage}
                  shopLocales={shopLocales}
                />
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">
                  {t.content?.selectFromList || "Select a theme resource from the list"}
                </Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

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

    // Load theme resources from database (synced by background sync)
    const { db } = await import("../db.server");

    const [themeGroups, themeTranslations] = await Promise.all([
      db.themeContent.findMany({
        where: { shop: session.shop },
        orderBy: { groupName: 'asc' }
      }),
      db.themeTranslation.findMany({
        where: { shop: session.shop }
      })
    ]);

    // Group translations by resourceId and groupId
    const translationsByGroup: Record<string, any[]> = {};
    for (const trans of themeTranslations) {
      const key = `${trans.resourceId}_${trans.groupId}`;
      if (!translationsByGroup[key]) {
        translationsByGroup[key] = [];
      }
      translationsByGroup[key].push(trans);
    }

    // Group theme content by groupId to avoid duplicates
    const groupedByGroupId = new Map<string, any>();

    for (const group of themeGroups) {
      const existingGroup = groupedByGroupId.get(group.groupId);

      if (!existingGroup) {
        // First occurrence of this groupId
        groupedByGroupId.set(group.groupId, {
          groupId: group.groupId,
          groupName: group.groupName,
          groupIcon: group.groupIcon,
          resources: [{
            resourceId: group.resourceId,
            translatableContent: group.translatableContent as any[],
            translations: translationsByGroup[`${group.resourceId}_${group.groupId}`] || []
          }]
        });
      } else {
        // Add to existing group
        existingGroup.resources.push({
          resourceId: group.resourceId,
          translatableContent: group.translatableContent as any[],
          translations: translationsByGroup[`${group.resourceId}_${group.groupId}`] || []
        });
      }
    }

    // Transform to match frontend structure
    const themes = Array.from(groupedByGroupId.values()).map(group => {
      // Merge all translatable content from all resources
      const allContent = group.resources.flatMap((r: any) => r.translatableContent);
      const allTranslations = group.resources.flatMap((r: any) => r.translations);

      return {
        id: `group_${group.groupId}`,
        title: group.groupName,
        name: group.groupName,
        icon: group.groupIcon,
        groupId: group.groupId,
        role: 'THEME_GROUP',
        translatableContent: allContent,
        translations: allTranslations,
        contentCount: allContent.length
      };
    });

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

  const selectedItem = themes.find((item: any) => item.id === selectedItemId);

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
                    const { id, title, icon, contentCount } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => setSelectedItemId(id)}
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
            {selectedItem ? (
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

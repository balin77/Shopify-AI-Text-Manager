/**
 * Metaobjects Management - Manage custom content types
 *
 * Note: This feature is coming soon. Metaobjects require special Shopify permissions.
 */

import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  ResourceList,
  ResourceItem,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { useI18n } from "../contexts/I18nContext";
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

    // Load metaobjects
    const contentService = new ContentService(admin);
    const metaobjects = await contentService.getMetaobjects();

    return json({
      metaobjects,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[METAOBJECTS-LOADER] Error:", error);
    return json({
      metaobjects: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export default function MetaobjectsPage() {
  const { metaobjects, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const { t } = useI18n();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const selectedItem = metaobjects.find((item: any) => item.id === selectedItemId);

  return (
    <Page fullWidth>
      <MainNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Metaobjects List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.metaobjects || "Metaobjects"} ({metaobjects.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {metaobjects.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Metaobject", plural: "Metaobjects" }}
                  items={metaobjects}
                  renderItem={(item: any) => {
                    const { id, displayName, definitionName } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => setSelectedItemId(id)}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {displayName || id}
                          </Text>
                          {definitionName && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Type: {definitionName}
                            </Text>
                          )}
                        </BlockStack>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <BlockStack gap="300">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.content?.noEntries || "No metaobjects found"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Create metaobject definitions in your Shopify admin to get started.
                    </Text>
                  </BlockStack>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Metaobject Viewer */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content?.error || "Error"} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {selectedItem ? (
              <BlockStack gap="500">
                {/* Coming Soon Banner */}
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      🚀 Metaobjects support is coming soon!
                    </Text>
                    <Text as="p" variant="bodyMd">
                      We're working on adding full translation and editing support for metaobjects.
                    </Text>
                  </BlockStack>
                </Banner>

                {/* Item ID */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.content?.idPrefix || "ID:"} {selectedItem.id.split("/").pop()}
                </Text>

                {/* Display Name */}
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    {selectedItem.displayName || "Untitled Metaobject"}
                  </Text>
                  {selectedItem.definitionName && (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Definition: {selectedItem.definitionName}
                    </Text>
                  )}
                </BlockStack>

                {/* Fields */}
                {selectedItem.fields && selectedItem.fields.length > 0 && (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h4" variant="headingSm">
                        Fields ({selectedItem.fields.length})
                      </Text>
                      {selectedItem.fields.map((field: any, index: number) => (
                        <BlockStack key={index} gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {field.key}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {JSON.stringify(field.value)}
                          </Text>
                        </BlockStack>
                      ))}
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <BlockStack gap="300">
                  <Text as="p" variant="headingLg" tone="subdued">
                    {t.content?.selectFromList || "Select a metaobject from the list"}
                  </Text>
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      🚀 Full metaobject editing and translation support coming soon!
                    </Text>
                  </Banner>
                </BlockStack>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

/**
 * Metaobjects Management - Manage metaobject option values
 *
 * This page displays metaobjects that are linked to product options.
 * NOTE: Currently shows ALL metaobjects. Future enhancement: Filter to show
 * ONLY metaobjects that are actually used as product option values.
 *
 * Only the metaobject VALUES are editable/translatable here - names are NOT editable.
 * Structure similar to templates, but without "Improve with AI" buttons per element.
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
  TextField,
  Button,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { useI18n } from "../contexts/I18nContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { ContentService } from "../services/content.service";
import { CONTENT_MAX_HEIGHT } from "../constants/layout";
import { logger } from "~/utils/logger.server";

interface MetaobjectField {
  key: string;
  value: string | null;
  type?: string;
}

interface MetaobjectItem {
  id: string;
  displayName?: string | null;
  definitionName?: string;
  handle?: string;
  type?: string;
  fields?: MetaobjectField[];
}

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
    const primaryLocale = shopLocales.find((l: { primary: boolean }) => l.primary)?.locale || "en";

    // Load metaobject definitions
    const contentService = new ContentService(admin);
    const definitions = await contentService.getMetaobjectDefinitions(50);

    const allMetaobjects: MetaobjectItem[] = [];

    // For each definition, fetch metaobjects with fields
    for (const definition of definitions) {
      try {
        const response = await admin.graphql(
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

        const metaobjects = data.data?.metaobjects?.edges?.map((edge: { node: any }) => ({
          ...edge.node,
          definitionName: definition.name,
          fields: edge.node.fields || [],
        })) || [];

        allMetaobjects.push(...metaobjects);
      } catch (error) {
        logger.error('[METAOBJECTS-LOADER] Error fetching metaobjects for type', {
          error: error instanceof Error ? error.message : String(error),
          type: definition.type
        });
      }
    }

    logger.info('[METAOBJECTS-LOADER] Loaded metaobjects', { count: allMetaobjects.length });

    return json({
      metaobjects: allMetaobjects,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: unknown) {
    logger.error("[METAOBJECTS-LOADER] Error", { error: error instanceof Error ? error.message : String(error) });
    return json({
      metaobjects: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "en",
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
};

export default function MetaobjectsPage() {
  const { metaobjects, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { mainNavHeight } = useNavigationHeight();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editedFields, setEditedFields] = useState<Record<string, string>>({});

  const selectedItem = (metaobjects as MetaobjectItem[]).find((item) => item.id === selectedItemId);

  const handleFieldChange = (fieldKey: string, value: string) => {
    setEditedFields(prev => ({
      ...prev,
      [fieldKey]: value
    }));
  };

  const handleSave = () => {
    // TODO: Implement save functionality via GraphQL mutations
    console.log('Saving fields:', editedFields);
    alert('Save functionality coming soon!');
  };

  return (
    <Page fullWidth>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: `calc(100vh - ${mainNavHeight}px - 85px)`, display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Metaobjects List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.metaobjects || "Metaobjects"} ({metaobjects.length})
              </Text>
            </div>
            <div style={{ maxHeight: CONTENT_MAX_HEIGHT, overflowY: "auto" }}>
              {metaobjects.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Metaobject", plural: "Metaobjects" }}
                  items={metaobjects}
                  renderItem={(item: MetaobjectItem) => {
                    const { id, displayName, definitionName, handle } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => {
                          setSelectedItemId(id);
                          setEditedFields({});
                        }}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {displayName || handle || id.split("/").pop()}
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

        {/* Middle: Metaobject Editor */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content?.error || "Error"} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {selectedItem ? (
              <BlockStack gap="500">
                {/* Info Banner */}
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Metaobject Option Values - Prototype
                    </Text>
                    <Text as="p" variant="bodyMd">
                      This is a prototype version. You can view metaobject fields here.
                      Full editing and translation functionality will be added in future updates.
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Note: Currently showing ALL metaobjects. Future versions will filter to show only those used as product option values.
                    </Text>
                  </BlockStack>
                </Banner>

                {/* Header with Save Button */}
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingLg">
                      {selectedItem.displayName || selectedItem.handle || "Untitled Metaobject"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      ID: {selectedItem.id.split("/").pop()}
                    </Text>
                    {selectedItem.definitionName && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Definition: {selectedItem.definitionName}
                      </Text>
                    )}
                    {selectedItem.handle && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Handle: {selectedItem.handle}
                      </Text>
                    )}
                  </BlockStack>

                  <Button primary onClick={handleSave} disabled={Object.keys(editedFields).length === 0}>
                    {t.content?.saveChanges || "Save"}
                  </Button>
                </InlineStack>

                {/* Fields */}
                {selectedItem.fields && selectedItem.fields.length > 0 ? (
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h4" variant="headingMd">
                        Fields ({selectedItem.fields.length})
                      </Text>
                      {selectedItem.fields.map((field, index) => {
                        const currentValue = editedFields[field.key] !== undefined
                          ? editedFields[field.key]
                          : (field.value || "");

                        return (
                          <BlockStack key={index} gap="200">
                            <TextField
                              label={field.key}
                              value={currentValue}
                              onChange={(value) => handleFieldChange(field.key, value)}
                              autoComplete="off"
                              helpText={field.type ? `Type: ${field.type}` : undefined}
                            />
                          </BlockStack>
                        );
                      })}
                    </BlockStack>
                  </Card>
                ) : (
                  <Banner>
                    <Text as="p" variant="bodyMd">
                      This metaobject has no fields.
                    </Text>
                  </Banner>
                )}
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <BlockStack gap="300">
                  <Text as="p" variant="headingLg" tone="subdued">
                    {t.content?.selectFromList || "Select a metaobject from the list"}
                  </Text>
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        Metaobjects - Product Option Values
                      </Text>
                      <Text as="p" variant="bodyMd">
                        Select a metaobject from the list to view and edit its field values.
                        This page is designed for managing metaobjects that are used as product option values.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Full translation and advanced editing features coming soon.
                      </Text>
                    </BlockStack>
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

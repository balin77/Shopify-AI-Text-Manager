/**
 * Shop Metadata Management - Manage store metadata fields
 *
 * Note: This feature is coming soon. Shop metadata includes store-level metafields.
 */

import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
  TextField,
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

    // Load shop metadata
    const contentService = new ContentService(admin);
    const metadata = await contentService.getShopMetadata();

    return json({
      metadata,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[METADATA-LOADER] Error:", error);
    return json({
      metadata: { metafields: [] },
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export default function MetadataPage() {
  const { metadata, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const { t } = useI18n();

  return (
    <Page fullWidth>
      <MainNavigation />

      <div style={{ padding: "2rem" }}>
        <BlockStack gap="600">
          {/* Page Header */}
          <BlockStack gap="200">
            <Text as="h1" variant="heading2xl">
              {t.content?.shopMetadata || "Shop Metadata"}
            </Text>
            <Text as="p" variant="bodyLg" tone="subdued">
              Manage store-level metadata and metafields
            </Text>
          </BlockStack>

          {error && (
            <Banner title={t.content?.error || "Error"} tone="critical">
              <p>{error}</p>
            </Banner>
          )}

          {/* Coming Soon Banner */}
          <Banner tone="info">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                🚀 Shop Metadata editing is coming soon!
              </Text>
              <Text as="p" variant="bodyMd">
                We're working on adding full translation and editing support for shop metafields.
              </Text>
            </BlockStack>
          </Banner>

          {/* Current Metadata (Read-Only) */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">
                Current Shop Information
              </Text>

              {/* Shop Name */}
              {metadata.name && (
                <TextField
                  label="Shop Name"
                  value={metadata.name}
                  onChange={() => {}}
                  disabled
                  autoComplete="off"
                />
              )}

              {/* Shop Email */}
              {metadata.email && (
                <TextField
                  label="Shop Email"
                  value={metadata.email}
                  onChange={() => {}}
                  disabled
                  autoComplete="off"
                />
              )}

              {/* Shop Domain */}
              {metadata.primaryDomain?.url && (
                <TextField
                  label="Primary Domain"
                  value={metadata.primaryDomain.url}
                  onChange={() => {}}
                  disabled
                  autoComplete="off"
                />
              )}
            </BlockStack>
          </Card>

          {/* Metafields */}
          {metadata.metafields && metadata.metafields.length > 0 && (
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingLg">
                  Shop Metafields ({metadata.metafields.length})
                </Text>

                <Banner tone="info">
                  <Text as="p" variant="bodyMd">
                    Metafield editing will be available in a future update.
                  </Text>
                </Banner>

                <BlockStack gap="300">
                  {metadata.metafields.map((metafield: any, index: number) => (
                    <Card key={index}>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {metafield.namespace}.{metafield.key}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Type: {metafield.type}
                        </Text>
                        <TextField
                          label="Value"
                          value={metafield.value || ""}
                          onChange={() => {}}
                          disabled
                          autoComplete="off"
                          multiline={3}
                        />
                      </BlockStack>
                    </Card>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          )}

          {/* No Metafields Message */}
          {(!metadata.metafields || metadata.metafields.length === 0) && (
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">
                  Shop Metafields
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  No metafields found. Create metafields in your Shopify admin to get started.
                </Text>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}

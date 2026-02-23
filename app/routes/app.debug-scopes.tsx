/**
 * Debug page to check current Shopify API scopes
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, Text, BlockStack, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return json({
    shop: session.shop,
    scopes: session.scope,
    accessToken: session.accessToken ? "Present" : "Missing",
  });
};

export default function DebugScopesPage() {
  const { shop, scopes, accessToken } = useLoaderData<typeof loader>();

  const scopesList = scopes?.split(',') || [];
  const hasMetaobjectRead = scopesList.includes('read_metaobjects');
  const hasMetaobjectWrite = scopesList.includes('write_metaobjects');

  return (
    <Page title="Debug: API Scopes">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Shop Information</Text>
            <Text as="p">Shop: {shop}</Text>
            <Text as="p">Access Token: {accessToken}</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Current Scopes ({scopesList.length})</Text>

            {!hasMetaobjectRead && (
              <Banner tone="critical">
                <Text as="p" fontWeight="bold">Missing: read_metaobjects</Text>
              </Banner>
            )}
            {!hasMetaobjectWrite && (
              <Banner tone="critical">
                <Text as="p" fontWeight="bold">Missing: write_metaobjects</Text>
              </Banner>
            )}
            {hasMetaobjectRead && hasMetaobjectWrite && (
              <Banner tone="success">
                <Text as="p" fontWeight="bold">✓ Metaobject scopes are present!</Text>
              </Banner>
            )}

            <div style={{ fontFamily: 'monospace', fontSize: '12px', background: '#f6f6f7', padding: '12px', borderRadius: '4px' }}>
              {scopesList.map((scope, i) => (
                <div key={i} style={{
                  color: scope.includes('metaobject') ? '#008060' : '#000',
                  fontWeight: scope.includes('metaobject') ? 'bold' : 'normal'
                }}>
                  {scope}
                </div>
              ))}
            </div>
          </BlockStack>
        </Card>

        {(!hasMetaobjectRead || !hasMetaobjectWrite) && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">How to Fix</Text>
              <Text as="p">The app needs to be reauthorized with the new scopes. Choose one option:</Text>

              <Banner tone="info">
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">Option 1: Reinstall via URL</Text>
                  <Text as="p">Visit: https://{shop}/admin/oauth/authorize?client_id=9e5abc8c0e9e03ed24d4a2a2b1174c88&amp;scope=read_legal_policies,write_legal_policies,read_locales,read_online_store_navigation,read_online_store_pages,write_online_store_pages,read_product_listings,read_products,write_products,read_content,write_content,read_themes,write_themes,read_translations,write_translations,read_metaobjects,write_metaobjects&amp;redirect_uri=https://contentpilotai.up.railway.app/auth/callback</Text>
                </BlockStack>
              </Banner>

              <Banner tone="info">
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">Option 2: Uninstall and Reinstall</Text>
                  <Text as="p">1. Go to Shopify Admin → Apps</Text>
                  <Text as="p">2. Uninstall ContentPilot AI</Text>
                  <Text as="p">3. Reinstall via your installation link</Text>
                </BlockStack>
              </Banner>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

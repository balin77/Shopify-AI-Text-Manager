import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Layout, Card, Button, Banner, Text, BlockStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { db } = await import("../db.server");

  // Get product count
  const productCount = await db.product.count({
    where: { shop: session.shop },
  });

  // Get translation count
  const translationCount = await db.translation.count({
    where: {
      product: {
        shop: session.shop,
      },
    },
  });

  // Get webhook count
  const webhookCount = await db.webhookLog.count({
    where: { shop: session.shop },
  });

  return json({
    shop: session.shop,
    productCount,
    translationCount,
    webhookCount,
  });
};

export default function Setup() {
  const { shop, productCount, translationCount, webhookCount } = useLoaderData<typeof loader>();
  const webhookFetcher = useFetcher();
  const syncFetcher = useFetcher();

  const [webhookStatus, setWebhookStatus] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("");

  const handleSetupWebhooks = async () => {
    setWebhookStatus("Setting up webhooks...");
    webhookFetcher.submit({}, { method: "POST", action: "/api/setup-webhooks" });
  };

  const handleSyncProducts = async (force: boolean = false) => {
    setSyncStatus("Syncing products...");
    syncFetcher.submit(
      {},
      {
        method: "POST",
        action: force ? "/api/sync-products?force=true" : "/api/sync-products",
      }
    );
  };

  // Update status when fetchers complete
  if (webhookFetcher.data && webhookStatus === "Setting up webhooks...") {
    if (webhookFetcher.data.success) {
      setWebhookStatus(`✓ ${webhookFetcher.data.message}`);
    } else {
      setWebhookStatus(`✗ Error: ${webhookFetcher.data.error}`);
    }
  }

  if (syncFetcher.data && syncStatus === "Syncing products...") {
    if (syncFetcher.data.success) {
      setSyncStatus(`✓ ${syncFetcher.data.message}`);
    } else {
      setSyncStatus(`✗ Error: ${syncFetcher.data.error}`);
    }
  }

  return (
    <Page fullWidth title="App Setup">
      <MainNavigation />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Banner title="Setup Instructions" tone="info">
              <p>
                This page helps you set up the app for the first time. Follow
                the steps below:
              </p>
              <ol>
                <li>Setup Webhooks - Register webhooks with Shopify</li>
                <li>
                  Sync Products - Import all products and translations to local
                  database
                </li>
              </ol>
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Current Status
                </Text>
                <BlockStack gap="200">
                  <Text as="p">Shop: {shop}</Text>
                  <Text as="p">Products in database: {productCount}</Text>
                  <Text as="p">Translations in database: {translationCount}</Text>
                  <Text as="p">Webhook events received: {webhookCount}</Text>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  1. Setup Webhooks
                </Text>
                <Text as="p">
                  Register webhooks to automatically sync products when they
                  change in Shopify.
                </Text>
                <Button
                  onClick={handleSetupWebhooks}
                  loading={webhookFetcher.state !== "idle"}
                >
                  Setup Webhooks
                </Button>
                {webhookStatus && (
                  <Banner
                    tone={
                      webhookStatus.startsWith("✓") ? "success" : "critical"
                    }
                  >
                    {webhookStatus}
                  </Banner>
                )}
                {webhookFetcher.data?.webhooks && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="bold">
                      Registered webhooks:
                    </Text>
                    {webhookFetcher.data.webhooks.map((w: any, i: number) => (
                      <Text as="p" key={i}>
                        • {w.topic} → {w.callbackUrl}
                      </Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  2. Sync Products
                </Text>
                <Text as="p">
                  Import all products and their translations from Shopify to
                  the local database.
                </Text>
                <BlockStack gap="200">
                  <Button
                    onClick={() => handleSyncProducts(false)}
                    loading={syncFetcher.state !== "idle"}
                    variant="primary"
                  >
                    Sync Products
                  </Button>
                  {productCount > 0 && (
                    <Button
                      onClick={() => handleSyncProducts(true)}
                      loading={syncFetcher.state !== "idle"}
                      variant="secondary"
                    >
                      Force Re-Sync (overwrite existing)
                    </Button>
                  )}
                </BlockStack>
                {syncStatus && (
                  <Banner
                    tone={syncStatus.startsWith("✓") ? "success" : "critical"}
                  >
                    {syncStatus}
                  </Banner>
                )}
                {syncFetcher.data?.errors && syncFetcher.data.errors.length > 0 && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="bold">
                      Errors:
                    </Text>
                    {syncFetcher.data.errors.map((err: string, i: number) => (
                      <Text as="p" key={i} tone="critical">
                        • {err}
                      </Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {productCount > 0 && (
              <Banner title="Setup Complete!" tone="success">
                <p>
                  Your app is ready to use! All products and translations are
                  synced. Webhooks will keep them up to date automatically.
                </p>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

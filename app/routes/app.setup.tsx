import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
  const initialData = useLoaderData<typeof loader>();

  const [shop] = useState(initialData.shop);
  const [productCount, setProductCount] = useState(initialData.productCount);
  const [translationCount, setTranslationCount] = useState(initialData.translationCount);
  const [webhookCount, setWebhookCount] = useState(initialData.webhookCount);

  const [webhookStatus, setWebhookStatus] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [webhookData, setWebhookData] = useState<any>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);

  const handleSetupWebhooks = async () => {
    setWebhookStatus("Setting up webhooks...");
    setWebhookLoading(true);
    setWebhookData(null);

    try {
      const response = await fetch("/api/setup-webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (data.success) {
        setWebhookStatus(`✓ ${data.message}`);
        setWebhookData(data);
      } else {
        setWebhookStatus(`✗ Error: ${data.error}`);
      }
    } catch (error: any) {
      setWebhookStatus(`✗ Error: ${error.message}`);
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleSyncProducts = async (force: boolean = false) => {
    setSyncStatus("Syncing products...");
    setSyncLoading(true);
    setSyncErrors([]);

    try {
      const url = force ? "/api/sync-products?force=true" : "/api/sync-products";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (data.success) {
        setSyncStatus(`✓ ${data.message}`);
        if (data.errors) {
          setSyncErrors(data.errors);
        }
        // Refresh counts
        if (data.synced > 0) {
          // Reload page to get fresh counts
          window.location.reload();
        }
      } else {
        setSyncStatus(`✗ Error: ${data.error}`);
      }
    } catch (error: any) {
      setSyncStatus(`✗ Error: ${error.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

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
                  loading={webhookLoading}
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
                {webhookData?.webhooks && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="bold">
                      Registered webhooks:
                    </Text>
                    {webhookData.webhooks.map((w: any, i: number) => (
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
                    loading={syncLoading}
                    variant="primary"
                  >
                    Sync Products
                  </Button>
                  {productCount > 0 && (
                    <Button
                      onClick={() => handleSyncProducts(true)}
                      loading={syncLoading}
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
                {syncErrors.length > 0 && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="bold">
                      Errors:
                    </Text>
                    {syncErrors.map((err: string, i: number) => (
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

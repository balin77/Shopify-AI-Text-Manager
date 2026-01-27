import { useState } from "react";
import { Card, Text, BlockStack, Button, Banner, ProgressBar, InlineStack, Box } from "@shopify/polaris";

interface SettingsSetupTabProps {
  shop: string;
  productCount: number;
  collectionCount: number;
  articleCount: number;
  translationCount: number;
  webhookCount: number;
  t: any; // i18n translations
}

export function SettingsSetupTab({
  shop,
  productCount,
  collectionCount,
  articleCount,
  translationCount,
  webhookCount,
  t,
}: SettingsSetupTabProps) {
  const [webhookStatus, setWebhookStatus] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [webhookData, setWebhookData] = useState<any>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [syncProgress, setSyncProgress] = useState<{
    phase: string;
    message: string;
    current: number;
    total: number;
  } | null>(null);

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

  const phaseLabels: Record<string, string> = {
    products: "Products",
    collections: "Collections",
    articles: "Articles",
    pages: "Pages",
    policies: "Policies",
    themes: "Themes",
  };

  const handleSyncProducts = async (force: boolean = false) => {
    setSyncStatus("");
    setSyncLoading(true);
    setSyncErrors([]);
    setSyncProgress({ phase: "starting", message: "Starting sync...", current: 0, total: 100 });

    try {
      const streamUrl = force ? "/api/sync-all-stream?force=true" : "/api/sync-all-stream";
      const response = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalStats: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "progress") {
                setSyncProgress({
                  phase: data.phase,
                  message: data.message,
                  current: data.current || 0,
                  total: data.total || 100,
                });
              } else if (data.type === "complete") {
                finalStats = data.stats;
                setSyncProgress(null);
                setSyncStatus(
                  `✓ Synced ${finalStats.products} products, ${finalStats.collections} collections, ${finalStats.articles} articles, ${finalStats.pages} pages`
                );
              } else if (data.type === "error") {
                setSyncProgress(null);
                setSyncStatus(`✗ Error: ${data.message}`);
              }
            } catch (e) {
              console.error("Failed to parse SSE message:", e);
            }
          }
        }
      }

      // Reload page to refresh counts if anything was synced
      if (finalStats && (finalStats.products > 0 || finalStats.collections > 0 || finalStats.articles > 0)) {
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (error: any) {
      setSyncProgress(null);
      setSyncStatus(`✗ Error: ${error.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

  return (
    <>
      <Banner title={t.settings.setupInstructions} tone="info">
        <p>{t.settings.setupDescription}</p>
        <ol>
          <li>{t.settings.setupStep1}</li>
          <li>{t.settings.setupStep2}</li>
        </ol>
      </Banner>

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            {t.settings.currentStatus}
          </Text>
          <BlockStack gap="200">
            <Text as="p">{t.settings.shop}: {shop}</Text>
            <Text as="p" fontWeight="semibold">Products & Content:</Text>
            <Text as="p">{t.settings.productsInDb}: {productCount}</Text>
            <Text as="p">Collections in DB: {collectionCount}</Text>
            <Text as="p">Articles in DB: {articleCount}</Text>
            <div style={{ marginTop: "0.5rem" }}>
              <Text as="p" fontWeight="semibold">Translations:</Text>
            </div>
            <Text as="p">{t.settings.translationsInDb}: {translationCount}</Text>
            <div style={{ marginTop: "0.5rem" }}>
              <Text as="p" fontWeight="semibold">Webhooks:</Text>
            </div>
            <Text as="p">{t.settings.webhookEventsReceived}: {webhookCount}</Text>
          </BlockStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            1. {t.settings.setupWebhooks}
          </Text>
          <Text as="p">
            {t.settings.setupWebhooksDescription}
          </Text>
          <Button
            onClick={handleSetupWebhooks}
            loading={webhookLoading}
          >
            {t.settings.setupWebhooks}
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
                {t.settings.registeredWebhooks}
              </Text>
              <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                <BlockStack gap="100">
                  {webhookData.webhooks.filter((w: any) => w.topic.includes('PRODUCTS')).length > 0 && (
                    <Text as="p" fontWeight="semibold">Products: {webhookData.webhooks.filter((w: any) => w.topic.includes('PRODUCTS')).length} webhooks</Text>
                  )}
                  {webhookData.webhooks.filter((w: any) => w.topic.includes('COLLECTIONS')).length > 0 && (
                    <Text as="p" fontWeight="semibold">Collections: {webhookData.webhooks.filter((w: any) => w.topic.includes('COLLECTIONS')).length} webhooks</Text>
                  )}
                  {webhookData.webhooks.filter((w: any) => w.topic.includes('ARTICLES')).length > 0 && (
                    <Text as="p" fontWeight="semibold">Articles: {webhookData.webhooks.filter((w: any) => w.topic.includes('ARTICLES')).length} webhooks</Text>
                  )}
                </BlockStack>
              </div>
              <details>
                <summary style={{ cursor: "pointer", padding: "0.5rem 0" }}>Show all webhook details</summary>
                <BlockStack gap="100" >
                  {webhookData.webhooks.map((w: any, i: number) => (
                    <Text as="p" key={i} tone="subdued">
                      • {w.topic}
                    </Text>
                  ))}
                </BlockStack>
              </details>
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            2. {t.settings.syncProducts}
          </Text>
          <Text as="p">
            {t.settings.syncProductsDescription}
          </Text>
          <Text as="p" tone="subdued">
            This will sync all products, collections, and articles from Shopify to the database. Auto-updates via webhooks.
          </Text>
          <BlockStack gap="200">
            <Button
              onClick={() => handleSyncProducts(false)}
              loading={syncLoading}
              variant="primary"
            >
              Sync All Content
            </Button>
            {productCount > 0 && (
              <Button
                onClick={() => handleSyncProducts(true)}
                loading={syncLoading}
                variant="secondary"
              >
                Force Full Re-Sync
              </Button>
            )}
          </BlockStack>
          {syncProgress && (
            <Box padding="400" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {phaseLabels[syncProgress.phase] || syncProgress.phase}
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {syncProgress.current}%
                  </Text>
                </InlineStack>
                <ProgressBar progress={syncProgress.current} size="small" />
                <Text as="p" variant="bodySm" tone="subdued">
                  {syncProgress.message}
                </Text>
              </BlockStack>
            </Box>
          )}
          {syncStatus && !syncProgress && (
            <Banner
              tone={syncStatus.startsWith("✓") ? "success" : "critical"}
            >
              {syncStatus}
            </Banner>
          )}
          {syncErrors.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="bold">
                {t.settings.errors}
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
        <Banner title={t.settings.setupComplete} tone="success">
          <p>
            {t.settings.setupCompleteDescription}
          </p>
        </Banner>
      )}
    </>
  );
}

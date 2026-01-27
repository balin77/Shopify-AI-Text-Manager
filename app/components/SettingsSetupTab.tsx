import { useState } from "react";
import { Card, Text, BlockStack, Button, Banner, ProgressBar, InlineStack, Box } from "@shopify/polaris";
import { useSyncProgress, type SyncProgress } from "./SyncProgressBar";

interface SettingsSetupTabProps {
  shop: string;
  productCount: number;
  collectionCount: number;
  articleCount: number;
  translationCount: number;
  webhookCount: number;
  t: any; // i18n translations
}

const phaseLabels: Record<string, string> = {
  products: "Products",
  collections: "Collections",
  articles: "Articles",
  pages: "Pages",
  policies: "Policies",
  themes: "Themes",
};

const phaseOrder = ["products", "collections", "articles", "pages", "policies", "themes"];

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
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookData, setWebhookData] = useState<any>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);

  // Use the reusable sync progress hook
  const { syncStatus, syncLoading, syncProgress, startSync } = useSyncProgress();

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
    setSyncErrors([]);
    const stats = await startSync(force);

    // Reload page to refresh counts if anything was synced
    if (stats && (stats.products > 0 || stats.collections > 0 || stats.articles > 0)) {
      setTimeout(() => window.location.reload(), 1500);
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
          <Button
            onClick={() => handleSyncProducts(true)}
            loading={syncLoading}
            variant="primary"
          >
            Sync All Content
          </Button>
          {syncProgress && (
            <Box padding="400" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Syncing Content
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {syncProgress.current}%
                  </Text>
                </InlineStack>
                <ProgressBar progress={syncProgress.current} size="small" />
                <InlineStack gap="300" wrap={true}>
                  {phaseOrder.map((phase) => {
                    const isCompleted = syncProgress.completedPhases.includes(phase);
                    const isCurrent = syncProgress.phase === phase;
                    return (
                      <Text
                        key={phase}
                        as="span"
                        variant="bodySm"
                        tone={isCompleted ? "success" : isCurrent ? "base" : "subdued"}
                        fontWeight={isCurrent ? "semibold" : "regular"}
                      >
                        {isCompleted ? "✓ " : isCurrent ? "● " : "○ "}
                        {phaseLabels[phase]}
                      </Text>
                    );
                  })}
                </InlineStack>
                {syncProgress.detailTotal && syncProgress.detailTotal > 1 && (
                  <Box paddingBlockStart="200">
                    <BlockStack gap="100">
                      <InlineStack align="space-between">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {syncProgress.detailMessage || `${syncProgress.detailCurrent}/${syncProgress.detailTotal}`}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {syncProgress.detailCurrent}/{syncProgress.detailTotal}
                        </Text>
                      </InlineStack>
                      <ProgressBar
                        progress={Math.round(((syncProgress.detailCurrent || 0) / syncProgress.detailTotal) * 100)}
                        size="small"
                        tone="highlight"
                      />
                    </BlockStack>
                  </Box>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  {syncProgress.message}
                </Text>
              </BlockStack>
            </Box>
          )}
          {syncStatus && !syncProgress && (
            <Banner
              tone={syncStatus.startsWith("Error") ? "critical" : "success"}
            >
              {syncStatus.startsWith("Error") ? syncStatus : `✓ ${syncStatus}`}
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

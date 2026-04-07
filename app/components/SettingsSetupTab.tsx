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

const phaseKeys: Record<string, string> = {
  products: "phaseProducts",
  collections: "phaseCollections",
  articles: "phaseArticles",
  pages: "phasePages",
  policies: "phasePolicies",
  themes: "phaseThemes",
  metaobjects: "phaseMetaobjects",
};

const phaseOrder = ["products", "collections", "articles", "pages", "policies", "themes", "metaobjects"];

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
    setWebhookStatus(t.settings.settingUpWebhooks || "Setting up webhooks...");
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
    } catch (error: unknown) {
      setWebhookStatus(`✗ Error: ${error instanceof Error ? error.message : String(error)}`);
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
            <Text as="p" fontWeight="semibold">{t.settings.productsAndContent}</Text>
            <Text as="p">{t.settings.productsInDb}: {productCount}</Text>
            <Text as="p">{t.settings.collectionsInDb}: {collectionCount}</Text>
            <Text as="p">{t.settings.articlesInDb}: {articleCount}</Text>
            <div style={{ marginTop: "0.5rem" }}>
              <Text as="p" fontWeight="semibold">{t.settings.translationsLabel}</Text>
            </div>
            <Text as="p">{t.settings.translationsInDb}: {translationCount}</Text>
            <div style={{ marginTop: "0.5rem" }}>
              <Text as="p" fontWeight="semibold">{t.settings.webhooksLabel}</Text>
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
                    <Text as="p" fontWeight="semibold">{t.settings.phaseProducts}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: any) => w.topic.includes('PRODUCTS')).length)}</Text>
                  )}
                  {webhookData.webhooks.filter((w: any) => w.topic.includes('COLLECTIONS')).length > 0 && (
                    <Text as="p" fontWeight="semibold">{t.settings.phaseCollections}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: any) => w.topic.includes('COLLECTIONS')).length)}</Text>
                  )}
                  {webhookData.webhooks.filter((w: any) => w.topic.includes('ARTICLES')).length > 0 && (
                    <Text as="p" fontWeight="semibold">{t.settings.phaseArticles}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: any) => w.topic.includes('ARTICLES')).length)}</Text>
                  )}
                </BlockStack>
              </div>
              <details>
                <summary style={{ cursor: "pointer", padding: "0.5rem 0" }}>{t.settings.showWebhookDetails}</summary>
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
            {t.content?.syncDescription || t.settings.syncProductsDescription}
          </Text>
          <Button
            onClick={() => handleSyncProducts(true)}
            loading={syncLoading}
            variant="primary"
          >
            {t.content?.syncAllContent || t.settings.syncProducts}
          </Button>
          {syncProgress && (
            <Box padding="400" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {t.settings.syncingContent}
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
                        {t.settings[phaseKeys[phase]] || phase}
                      </Text>
                    );
                  })}
                </InlineStack>
                {syncProgress.detailTotal != null && syncProgress.detailTotal > 0 && (
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

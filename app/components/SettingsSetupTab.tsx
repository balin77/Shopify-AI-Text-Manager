import { useState } from "react";
import { Card, Text, BlockStack, Button, Banner } from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";

interface WebhookEntry {
  topic: string;
  callbackUrl?: string;
}

interface SettingsSetupTabProps {
  shop: string;
  productCount: number;
  collectionCount: number;
  articleCount: number;
  translationCount: number;
  webhookCount: number;
  t: I18nTranslation;
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
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookData, setWebhookData] = useState<any>(null);
  const [syncTriggerLoading, setSyncTriggerLoading] = useState(false);
  const [syncTriggered, setSyncTriggered] = useState(false);
  const [syncTriggerError, setSyncTriggerError] = useState<string>("");

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

  const handleSyncProducts = async () => {
    setSyncTriggerError("");
    setSyncTriggerLoading(true);
    try {
      const response = await fetch("/api/sync-trigger", { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setSyncTriggered(true);
    } catch (error: unknown) {
      setSyncTriggerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncTriggerLoading(false);
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
                  {webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('PRODUCTS')).length > 0 && (
                    <Text as="p" fontWeight="semibold">{t.settings.phaseProducts}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('PRODUCTS')).length)}</Text>
                  )}
                  {webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('COLLECTIONS')).length > 0 && (
                    <Text as="p" fontWeight="semibold">{t.settings.phaseCollections}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('COLLECTIONS')).length)}</Text>
                  )}
                  {webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('ARTICLES')).length > 0 && (
                    <Text as="p" fontWeight="semibold">{t.settings.phaseArticles}: {t.settings.webhooksCount.replace('{count}', webhookData.webhooks.filter((w: WebhookEntry) => w.topic.includes('ARTICLES')).length)}</Text>
                  )}
                </BlockStack>
              </div>
              <details>
                <summary style={{ cursor: "pointer", padding: "0.5rem 0" }}>{t.settings.showWebhookDetails}</summary>
                <BlockStack gap="100" >
                  {webhookData.webhooks.map((w: WebhookEntry, i: number) => (
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
            onClick={handleSyncProducts}
            loading={syncTriggerLoading}
            disabled={syncTriggered}
            variant="primary"
          >
            {t.content?.syncAllContent || t.settings.syncProducts}
          </Button>
          {syncTriggered && (
            <Banner tone="info">
              <p>{t.settings.syncTriggeredHint}</p>
            </Banner>
          )}
          {syncTriggerError && (
            <Banner tone="critical">
              {syncTriggerError}
            </Banner>
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

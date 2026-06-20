import { useState } from "react";
import { Card, Text, BlockStack, Button, Banner, Box, Divider } from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";

interface WebhookEntry {
  topic: string;
  callbackUrl?: string;
}

interface SettingsSetupTabProps {
  shop: string;
  shopifyApiKey: string;
  productCount: number;
  collectionCount: number;
  articleCount: number;
  translationCount: number;
  webhookCount: number;
  t: I18nTranslation;
}

export function SettingsSetupTab({
  shop,
  shopifyApiKey,
  productCount,
  collectionCount,
  articleCount,
  translationCount,
  webhookCount,
  t,
}: SettingsSetupTabProps) {
  // Theme-editor deep links must use the app's api_key (Shopify client_id),
  // NOT the extension UID. The uuid form has been deprecated and Shopify
  // responds with "app embed doesn't exist" for those URLs.
  const buildEmbedUrl = (blockHandle: string) =>
    `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${shopifyApiKey}/${blockHandle}`;
  const variantGalleryEmbedUrl = buildEmbedUrl("variant-gallery-embed");
  const localeSwitcherEmbedUrl = buildEmbedUrl("locale-switcher");
  const directTranslationEmbedUrl = buildEmbedUrl("direct-translation");
  const ts = t.settings as unknown as Record<string, string>;
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

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            3. {t.settings.themeSetupTitle}
          </Text>
          <Text as="p" tone="subdued">
            {t.settings.themeSetupDescription}
          </Text>

          <Box background="bg-surface-secondary" borderRadius="200" padding="400">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {t.settings.themeSetupOptionATitle}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {t.settings.themeSetupOptionADescription}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {ts.themeSetupSelectorHint ??
                  "If your theme's product gallery is not replaced automatically, open the embed settings and set the “Native gallery CSS selector” to your theme's product gallery element (inspect it in the browser; e.g. media-gallery or .product__media-wrapper)."}
              </Text>
              <div>
                <Button url={variantGalleryEmbedUrl} external variant="primary" size="slim">
                  {t.settings.themeSetupOptionAButton}
                </Button>
              </div>
            </BlockStack>
          </Box>

          <Divider />

          <Box background="bg-surface-secondary" borderRadius="200" padding="400">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {ts.themeSetupOptionBTitle ?? "Language & Currency switcher"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {ts.themeSetupOptionBDescription ??
                  "Lets customers pick the storefront language and country/currency. Uses Shopify's native localization API — no extra setup beyond activating the embed."}
              </Text>
              <div>
                <Button url={localeSwitcherEmbedUrl} external variant="primary" size="slim">
                  {ts.themeSetupOptionBButton ?? "Activate switcher"}
                </Button>
              </div>
            </BlockStack>
          </Box>

          <Divider />

          <Box background="bg-surface-secondary" borderRadius="200" padding="400">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {ts.themeSetupOptionCTitle ?? "Direct translations"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {ts.themeSetupOptionCDescription ??
                  "Translates text from 3rd-party apps (reviews, badges, page builders) that Shopify's native translations can't reach. Without the embed enabled, nothing happens on the storefront."}
              </Text>
              <div>
                <Button url={directTranslationEmbedUrl} external variant="primary" size="slim">
                  {ts.themeSetupOptionCButton ?? "Activate direct translations"}
                </Button>
              </div>
            </BlockStack>
          </Box>

          <Text as="p" variant="bodySm" tone="subdued">
            {t.settings.themeSetupNote}
          </Text>
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

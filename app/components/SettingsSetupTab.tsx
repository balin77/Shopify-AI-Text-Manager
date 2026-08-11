import { useState } from "react";
import { Card, Text, BlockStack, InlineStack, Button, Banner, Box, Divider, Collapsible } from "@shopify/polaris";
import type { FetcherWithComponents } from "@remix-run/react";
import type { Translation as I18nTranslation } from "~/i18n/de";
import { meetsPlan, getPlanDisplayName, type Plan } from "../utils/planUtils";
import { SettingsLanguageTab } from "./SettingsLanguageTab";

interface WebhookEntry {
  topic: string;
  callbackUrl?: string;
}

interface SettingsSetupTabProps {
  shop: string;
  shopifyApiKey: string;
  subscriptionPlan: Plan;
  productCount: number;
  collectionCount: number;
  articleCount: number;
  translationCount: number;
  webhookCount: number;
  t: I18nTranslation;
  languageSettings: { appLanguage: string; [key: string]: any };
  languageFetcher: FetcherWithComponents<any>;
  onLanguageHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsSetupTab({
  shop,
  shopifyApiKey,
  subscriptionPlan,
  productCount,
  collectionCount,
  articleCount,
  translationCount,
  webhookCount,
  t,
  languageSettings,
  languageFetcher,
  onLanguageHasChangesChange,
}: SettingsSetupTabProps) {
  // Theme-editor deep links must use the app's api_key (Shopify client_id),
  // NOT the extension UID. The uuid form has been deprecated and Shopify
  // responds with "app embed doesn't exist" for those URLs.
  const buildEmbedUrl = (blockHandle: string) =>
    `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${shopifyApiKey}/${blockHandle}`;
  const variantGalleryEmbedUrl = buildEmbedUrl("variant-gallery-embed");
  const localeSwitcherEmbedUrl = buildEmbedUrl("locale-switcher");
  const directTranslationEmbedUrl = buildEmbedUrl("direct-translation");
  // SEO embeds. Their own sections link HERE rather than to the theme editor:
  // every embed the app owns is activated in one place, so a merchant never has
  // to remember which feature hid its activation on which page.
  const jsonLdEmbedUrl = buildEmbedUrl("structured-data");
  const socialMetaEmbedUrl = buildEmbedUrl("social-meta");
  const webVitalsEmbedUrl = buildEmbedUrl("web-vitals");
  const ts = t.settings as unknown as Record<string, string>;
  // The long-form explanations, folded away per embed. Optional on purpose:
  // a locale that hasn't got them yet simply renders the box without a toggle.
  const details = (t.settings as unknown as { themeSetupDetails?: Record<string, EmbedDetails> })
    .themeSetupDetails;
  const detailLabels = {
    detailsShowLabel: ts.themeSetupDetailsShow,
    detailsHideLabel: ts.themeSetupDetailsHide,
    whatLabel: ts.themeSetupDetailsWhat,
    stepsLabel: ts.themeSetupDetailsSteps,
    verifyLabel: ts.themeSetupDetailsVerify,
  };
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
      <SettingsLanguageTab
        settings={languageSettings}
        fetcher={languageFetcher}
        t={t}
        onHasChangesChange={onLanguageHasChangesChange}
      />

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

          {/* Order: Language & Currency → Variant Gallery → Direct Translations.
              Sprache & Währung läuft auf jedem Plan, Variant Gallery braucht
              Pro (für Bulk-Image-Upload + WebP), Direct Translations braucht
              Max. EmbedActivateBox kapselt das Gating + Plan-Hinweis. */}
          <EmbedActivateBox
            title={ts.themeSetupOptionBTitle ?? "Language & Currency switcher"}
            description={
              ts.themeSetupOptionBDescription ??
              "Lets customers pick the storefront language and country/currency. Uses Shopify's native localization API — no extra setup beyond activating the embed."
            }
            url={localeSwitcherEmbedUrl}
            details={details?.localeSwitcher}
            {...detailLabels}
            buttonLabel={ts.themeSetupOptionBButton ?? "Activate switcher"}
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

          <Divider />

          <EmbedActivateBox
            title={t.settings.themeSetupOptionATitle}
            description={t.settings.themeSetupOptionADescription}
            extraDescription={
              ts.themeSetupSelectorHint ??
              "If your theme's product gallery is not replaced automatically, open the embed settings and set the “Native gallery CSS selector” to your theme's product gallery element (inspect it in the browser; e.g. media-gallery or .product__media-wrapper)."
            }
            url={variantGalleryEmbedUrl}
            details={details?.variantGallery}
            {...detailLabels}
            buttonLabel={t.settings.themeSetupOptionAButton}
            requiredPlan="pro"
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

          <Divider />

          <EmbedActivateBox
            title={ts.themeSetupOptionCTitle ?? "Direct translations"}
            description={
              ts.themeSetupOptionCDescription ??
              "Translates text from 3rd-party apps (reviews, badges, page builders) that Shopify's native translations can't reach. Without the embed enabled, nothing happens on the storefront."
            }
            url={directTranslationEmbedUrl}
            details={details?.directTranslation}
            {...detailLabels}
            buttonLabel={ts.themeSetupOptionCButton ?? "Activate direct translations"}
            requiredPlan="max"
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

          <Divider />

          <Text as="h3" variant="headingSm">
            {ts.themeSetupSeoGroup ?? "SEO"}
          </Text>

          <EmbedActivateBox
            title={ts.themeSetupJsonLdTitle ?? "Structured data (JSON-LD)"}
            description={
              ts.themeSetupJsonLdDescription ??
              "Emits schema.org markup for products, collections and blog articles — the basis for rich results in Google. Without the embed enabled nothing reaches the storefront."
            }
            url={jsonLdEmbedUrl}
            details={details?.jsonLd}
            {...detailLabels}
            buttonLabel={ts.themeSetupJsonLdButton ?? "Activate structured data"}
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

          <Divider />

          <EmbedActivateBox
            title={ts.themeSetupSocialMetaTitle ?? "Open Graph / social previews"}
            description={
              ts.themeSetupSocialMetaDescription ??
              "Adds the Open Graph and Twitter Card tags that give shared links an image, title and description on Facebook, X, LinkedIn, WhatsApp and in AI chat previews."
            }
            url={socialMetaEmbedUrl}
            details={details?.socialMeta}
            {...detailLabels}
            buttonLabel={ts.themeSetupSocialMetaButton ?? "Activate social previews"}
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

          <Divider />

          <EmbedActivateBox
            title={ts.themeSetupWebVitalsTitle ?? "Real-user Web Vitals"}
            description={
              ts.themeSetupWebVitalsDescription ??
              "Measures loading speed at your actual visitors instead of in a lab. Without the embed the speed section only has lab data."
            }
            url={webVitalsEmbedUrl}
            details={details?.webVitals}
            {...detailLabels}
            buttonLabel={ts.themeSetupWebVitalsButton ?? "Activate Web Vitals"}
            currentPlan={subscriptionPlan}
            requiresPlanText={ts.themeSetupOptionRequiresPlan}
          />

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

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingLg">
            {t.settings.feedbackTitle}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {t.settings.feedbackDescription}
          </Text>
          <div>
            <Button
              variant="primary"
              url={`mailto:hans.maarhofer@gmail.com?subject=${encodeURIComponent(t.settings.feedbackSubject)}`}
              external
            >
              {t.settings.feedbackButton}
            </Button>
          </div>
        </BlockStack>
      </Card>
    </>
  );
}

/**
 * One activate box in the App-Setup card. Encapsulates the plan-gating: when
 * the current plan doesn't meet the required tier the button is rendered but
 * disabled, with a yellow "Requires the X plan." caption above it. Used for
 * all three embeds (language switcher / variant gallery / direct translations)
 * so the gating logic + visual treatment stay in lockstep.
 */
interface EmbedActivateBoxProps {
  title: string;
  description: string;
  /** Optional second-line description (e.g. selector hint for variant gallery). */
  extraDescription?: string;
  url: string;
  buttonLabel: string;
  /** Minimum plan needed. Omit when the embed works on every plan. */
  requiredPlan?: Plan;
  currentPlan: Plan;
  /** Optional override of the "Requires the {plan} plan." template. */
  requiresPlanText?: string;
  /**
   * The long explanation, folded away behind a toggle. Merchants who already
   * know what they are switching on should not have to scroll past four
   * paragraphs to reach the next button — but the depth has to be SOMEWHERE,
   * which is why the standalone Variant-Gallery setup page (unreachable, English
   * only) could be dropped in favour of this.
   */
  details?: EmbedDetails;
  detailsShowLabel?: string;
  detailsHideLabel?: string;
  whatLabel?: string;
  stepsLabel?: string;
  verifyLabel?: string;
}

export interface EmbedDetails {
  /** What the embed does on the storefront. */
  what: string;
  /** Activation steps, embed-specific where they differ. */
  steps: string[];
  /** How the merchant can tell it is actually working. */
  verify: string;
}

function EmbedActivateBox({
  title,
  description,
  extraDescription,
  url,
  buttonLabel,
  requiredPlan,
  currentPlan,
  requiresPlanText,
  details,
  detailsShowLabel,
  detailsHideLabel,
  whatLabel,
  stepsLabel,
  verifyLabel,
}: EmbedActivateBoxProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `embed-details-${title.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const allowed = !requiredPlan || meetsPlan(currentPlan, requiredPlan);
  const planNote =
    !allowed && requiredPlan
      ? (requiresPlanText ?? "Requires the {plan} plan.").replace("{plan}", getPlanDisplayName(requiredPlan))
      : null;
  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="400">
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{title}</Text>
        <Text as="p" variant="bodySm" tone="subdued">{description}</Text>
        {extraDescription && (
          <Text as="p" variant="bodySm" tone="subdued">{extraDescription}</Text>
        )}
        {planNote && (
          <Text as="p" variant="bodySm" tone="caution">{planNote}</Text>
        )}
        <InlineStack gap="200" blockAlign="center">
          <Button
            url={allowed ? url : undefined}
            external={allowed}
            disabled={!allowed}
            variant="primary"
            size="slim"
          >
            {buttonLabel}
          </Button>
          {details && (
            <Button
              variant="plain"
              size="slim"
              onClick={() => setDetailsOpen((open) => !open)}
              ariaExpanded={detailsOpen}
              ariaControls={detailsId}
              disclosure={detailsOpen ? "up" : "down"}
            >
              {detailsOpen ? (detailsHideLabel ?? "Less") : (detailsShowLabel ?? "How does it work?")}
            </Button>
          )}
        </InlineStack>

        {details && (
          <Collapsible
            id={detailsId}
            open={detailsOpen}
            transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
          >
            <Box paddingBlockStart="300">
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">{whatLabel ?? "What it does"}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{details.what}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">{stepsLabel ?? "How to activate it"}</Text>
                  <BlockStack gap="100">
                    {details.steps.map((step, i) => (
                      <InlineStack key={i} gap="200" blockAlign="start" wrap={false}>
                        <Text as="span" variant="bodySm" fontWeight="semibold">{`${i + 1}.`}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{step}</Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">{verifyLabel ?? "How to tell it works"}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{details.verify}</Text>
                </BlockStack>
              </BlockStack>
            </Box>
          </Collapsible>
        )}
      </BlockStack>
    </Box>
  );
}

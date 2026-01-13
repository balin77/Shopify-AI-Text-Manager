import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { SettingsSetupTab } from "../components/SettingsSetupTab";
import { SettingsAITab } from "../components/SettingsAITab";
import { SettingsLanguageTab } from "../components/SettingsLanguageTab";
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { sanitizeFormatExample } from "../utils/sanitizer";
import { AISettingsSchema, AIInstructionsSchema, parseFormData } from "../utils/validation";
import { toSafeErrorResponse } from "../utils/error-handler";
import {
  DEFAULT_PRODUCT_INSTRUCTIONS,
  DEFAULT_COLLECTION_INSTRUCTIONS,
  DEFAULT_BLOG_INSTRUCTIONS,
  DEFAULT_PAGE_INSTRUCTIONS,
  DEFAULT_POLICY_INSTRUCTIONS
} from "../constants/aiInstructionsDefaults";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Fetch shop's primary locale
  const localesResponse = await admin.graphql(
    `#graphql
      query getShopLocales {
        shopLocales {
          locale
          primary
        }
      }`
  );

  const localesData = await localesResponse.json();
  const primaryShopLocale = localesData.data.shopLocales.find((l: any) => l.primary)?.locale || "de";

  let settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    // Auto-select app language based on shop's primary locale
    const autoSelectedLanguage = primaryShopLocale.startsWith("en") ? "en" : "de";

    settings = await db.aISettings.create({
      data: {
        shop: session.shop,
        preferredProvider: "huggingface",
        appLanguage: autoSelectedLanguage,
      },
    });
  }

  // Fetch AI instructions
  let instructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  if (!instructions) {
    instructions = await db.aIInstructions.create({
      data: {
        shop: session.shop,
      },
    });
  }

  // Get counts for App Setup section
  const productCount = await db.product.count({
    where: { shop: session.shop },
  });

  const translationCount = await db.translation.count({
    where: {
      product: {
        shop: session.shop,
      },
    },
  });

  const webhookCount = await db.webhookLog.count({
    where: { shop: session.shop },
  });

  const collectionCount = await db.collection.count({
    where: { shop: session.shop },
  });

  const articleCount = await db.article.count({
    where: { shop: session.shop },
  });

  // Get subscription plan
  const subscriptionPlan = settings.subscriptionPlan || "basic";

  return json({
    shop: session.shop,
    productCount,
    translationCount,
    webhookCount,
    collectionCount,
    articleCount,
    subscriptionPlan,
    settings: {
      huggingfaceApiKey: settings.huggingfaceApiKey || "",
      geminiApiKey: settings.geminiApiKey || "",
      claudeApiKey: settings.claudeApiKey || "",
      openaiApiKey: settings.openaiApiKey || "",
      grokApiKey: settings.grokApiKey || "",
      deepseekApiKey: settings.deepseekApiKey || "",
      preferredProvider: settings.preferredProvider,
      appLanguage: settings.appLanguage || "de",

      // Rate limits
      hfMaxTokensPerMinute: settings.hfMaxTokensPerMinute || 1000000,
      hfMaxRequestsPerMinute: settings.hfMaxRequestsPerMinute || 100,
      geminiMaxTokensPerMinute: settings.geminiMaxTokensPerMinute || 1000000,
      geminiMaxRequestsPerMinute: settings.geminiMaxRequestsPerMinute || 15,
      claudeMaxTokensPerMinute: settings.claudeMaxTokensPerMinute || 40000,
      claudeMaxRequestsPerMinute: settings.claudeMaxRequestsPerMinute || 5,
      openaiMaxTokensPerMinute: settings.openaiMaxTokensPerMinute || 200000,
      openaiMaxRequestsPerMinute: settings.openaiMaxRequestsPerMinute || 500,
      grokMaxTokensPerMinute: settings.grokMaxTokensPerMinute || 100000,
      grokMaxRequestsPerMinute: settings.grokMaxRequestsPerMinute || 60,
      deepseekMaxTokensPerMinute: settings.deepseekMaxTokensPerMinute || 100000,
      deepseekMaxRequestsPerMinute: settings.deepseekMaxRequestsPerMinute || 60,
    },
    instructions: {
      // Products
      productTitleFormat: instructions.productTitleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
      productTitleInstructions: instructions.productTitleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
      productDescriptionFormat: instructions.productDescriptionFormat || DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
      productDescriptionInstructions: instructions.productDescriptionInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
      productHandleFormat: instructions.productHandleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
      productHandleInstructions: instructions.productHandleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
      productSeoTitleFormat: instructions.productSeoTitleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
      productSeoTitleInstructions: instructions.productSeoTitleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
      productMetaDescFormat: instructions.productMetaDescFormat || DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
      productMetaDescInstructions: instructions.productMetaDescInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
      productAltTextFormat: instructions.productAltTextFormat || DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat || "",
      productAltTextInstructions: instructions.productAltTextInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions || "",

      // Collections
      collectionTitleFormat: instructions.collectionTitleFormat || DEFAULT_COLLECTION_INSTRUCTIONS.titleFormat,
      collectionTitleInstructions: instructions.collectionTitleInstructions || DEFAULT_COLLECTION_INSTRUCTIONS.titleInstructions,
      collectionDescriptionFormat: instructions.collectionDescriptionFormat || DEFAULT_COLLECTION_INSTRUCTIONS.descriptionFormat,
      collectionDescriptionInstructions: instructions.collectionDescriptionInstructions || DEFAULT_COLLECTION_INSTRUCTIONS.descriptionInstructions,
      collectionHandleFormat: instructions.collectionHandleFormat || DEFAULT_COLLECTION_INSTRUCTIONS.handleFormat,
      collectionHandleInstructions: instructions.collectionHandleInstructions || DEFAULT_COLLECTION_INSTRUCTIONS.handleInstructions,
      collectionSeoTitleFormat: instructions.collectionSeoTitleFormat || DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleFormat,
      collectionSeoTitleInstructions: instructions.collectionSeoTitleInstructions || DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleInstructions,
      collectionMetaDescFormat: instructions.collectionMetaDescFormat || DEFAULT_COLLECTION_INSTRUCTIONS.metaDescFormat,
      collectionMetaDescInstructions: instructions.collectionMetaDescInstructions || DEFAULT_COLLECTION_INSTRUCTIONS.metaDescInstructions,

      // Blogs
      blogTitleFormat: instructions.blogTitleFormat || DEFAULT_BLOG_INSTRUCTIONS.titleFormat,
      blogTitleInstructions: instructions.blogTitleInstructions || DEFAULT_BLOG_INSTRUCTIONS.titleInstructions,
      blogDescriptionFormat: instructions.blogDescriptionFormat || DEFAULT_BLOG_INSTRUCTIONS.descriptionFormat,
      blogDescriptionInstructions: instructions.blogDescriptionInstructions || DEFAULT_BLOG_INSTRUCTIONS.descriptionInstructions,
      blogHandleFormat: instructions.blogHandleFormat || DEFAULT_BLOG_INSTRUCTIONS.handleFormat,
      blogHandleInstructions: instructions.blogHandleInstructions || DEFAULT_BLOG_INSTRUCTIONS.handleInstructions,
      blogSeoTitleFormat: instructions.blogSeoTitleFormat || DEFAULT_BLOG_INSTRUCTIONS.seoTitleFormat,
      blogSeoTitleInstructions: instructions.blogSeoTitleInstructions || DEFAULT_BLOG_INSTRUCTIONS.seoTitleInstructions,
      blogMetaDescFormat: instructions.blogMetaDescFormat || DEFAULT_BLOG_INSTRUCTIONS.metaDescFormat,
      blogMetaDescInstructions: instructions.blogMetaDescInstructions || DEFAULT_BLOG_INSTRUCTIONS.metaDescInstructions,

      // Pages
      pageTitleFormat: instructions.pageTitleFormat || DEFAULT_PAGE_INSTRUCTIONS.titleFormat,
      pageTitleInstructions: instructions.pageTitleInstructions || DEFAULT_PAGE_INSTRUCTIONS.titleInstructions,
      pageDescriptionFormat: instructions.pageDescriptionFormat || DEFAULT_PAGE_INSTRUCTIONS.descriptionFormat,
      pageDescriptionInstructions: instructions.pageDescriptionInstructions || DEFAULT_PAGE_INSTRUCTIONS.descriptionInstructions,
      pageHandleFormat: instructions.pageHandleFormat || DEFAULT_PAGE_INSTRUCTIONS.handleFormat,
      pageHandleInstructions: instructions.pageHandleInstructions || DEFAULT_PAGE_INSTRUCTIONS.handleInstructions,
      pageSeoTitleFormat: instructions.pageSeoTitleFormat || DEFAULT_PAGE_INSTRUCTIONS.seoTitleFormat,
      pageSeoTitleInstructions: instructions.pageSeoTitleInstructions || DEFAULT_PAGE_INSTRUCTIONS.seoTitleInstructions,
      pageMetaDescFormat: instructions.pageMetaDescFormat || DEFAULT_PAGE_INSTRUCTIONS.metaDescFormat,
      pageMetaDescInstructions: instructions.pageMetaDescInstructions || DEFAULT_PAGE_INSTRUCTIONS.metaDescInstructions,

      // Policies (description only)
      policyDescriptionFormat: instructions.policyDescriptionFormat || DEFAULT_POLICY_INSTRUCTIONS.descriptionFormat,
      policyDescriptionInstructions: instructions.policyDescriptionInstructions || DEFAULT_POLICY_INSTRUCTIONS.descriptionInstructions,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  try {
    if (actionType === "saveInstructions") {
      // Validate and sanitize AI instructions
      const validationResult = parseFormData(formData, AIInstructionsSchema);

      if (!validationResult.success) {
        return json({ success: false, error: validationResult.error }, { status: 400 });
      }

      const data = validationResult.data;

      // Sanitize HTML content in format examples (for description fields)
      const sanitizedData = {
        // Products
        productTitleFormat: data.productTitleFormat || null,
        productTitleInstructions: data.productTitleInstructions || null,
        productDescriptionFormat: data.productDescriptionFormat ? sanitizeFormatExample(data.productDescriptionFormat) : null,
        productDescriptionInstructions: data.productDescriptionInstructions || null,
        productHandleFormat: data.productHandleFormat || null,
        productHandleInstructions: data.productHandleInstructions || null,
        productSeoTitleFormat: data.productSeoTitleFormat || null,
        productSeoTitleInstructions: data.productSeoTitleInstructions || null,
        productMetaDescFormat: data.productMetaDescFormat || null,
        productMetaDescInstructions: data.productMetaDescInstructions || null,
        productAltTextFormat: data.productAltTextFormat || null,
        productAltTextInstructions: data.productAltTextInstructions || null,

        // Collections
        collectionTitleFormat: data.collectionTitleFormat || null,
        collectionTitleInstructions: data.collectionTitleInstructions || null,
        collectionDescriptionFormat: data.collectionDescriptionFormat ? sanitizeFormatExample(data.collectionDescriptionFormat) : null,
        collectionDescriptionInstructions: data.collectionDescriptionInstructions || null,
        collectionHandleFormat: data.collectionHandleFormat || null,
        collectionHandleInstructions: data.collectionHandleInstructions || null,
        collectionSeoTitleFormat: data.collectionSeoTitleFormat || null,
        collectionSeoTitleInstructions: data.collectionSeoTitleInstructions || null,
        collectionMetaDescFormat: data.collectionMetaDescFormat || null,
        collectionMetaDescInstructions: data.collectionMetaDescInstructions || null,

        // Blogs
        blogTitleFormat: data.blogTitleFormat || null,
        blogTitleInstructions: data.blogTitleInstructions || null,
        blogDescriptionFormat: data.blogDescriptionFormat ? sanitizeFormatExample(data.blogDescriptionFormat) : null,
        blogDescriptionInstructions: data.blogDescriptionInstructions || null,
        blogHandleFormat: data.blogHandleFormat || null,
        blogHandleInstructions: data.blogHandleInstructions || null,
        blogSeoTitleFormat: data.blogSeoTitleFormat || null,
        blogSeoTitleInstructions: data.blogSeoTitleInstructions || null,
        blogMetaDescFormat: data.blogMetaDescFormat || null,
        blogMetaDescInstructions: data.blogMetaDescInstructions || null,

        // Pages
        pageTitleFormat: data.pageTitleFormat || null,
        pageTitleInstructions: data.pageTitleInstructions || null,
        pageDescriptionFormat: data.pageDescriptionFormat ? sanitizeFormatExample(data.pageDescriptionFormat) : null,
        pageDescriptionInstructions: data.pageDescriptionInstructions || null,
        pageHandleFormat: data.pageHandleFormat || null,
        pageHandleInstructions: data.pageHandleInstructions || null,
        pageSeoTitleFormat: data.pageSeoTitleFormat || null,
        pageSeoTitleInstructions: data.pageSeoTitleInstructions || null,
        pageMetaDescFormat: data.pageMetaDescFormat || null,
        pageMetaDescInstructions: data.pageMetaDescInstructions || null,

        // Policies
        policyDescriptionFormat: data.policyDescriptionFormat ? sanitizeFormatExample(data.policyDescriptionFormat) : null,
        policyDescriptionInstructions: data.policyDescriptionInstructions || null,
      };

      await db.aIInstructions.upsert({
        where: { shop: session.shop },
        update: sanitizedData,
        create: {
          shop: session.shop,
          ...sanitizedData,
        },
      });

      return json({ success: true });
    } else {
      // Validate and save AI settings
      const validationResult = parseFormData(formData, AISettingsSchema);

      if (!validationResult.success) {
        return json({ success: false, error: validationResult.error }, { status: 400 });
      }

      const data = validationResult.data;

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: {
          huggingfaceApiKey: data.huggingfaceApiKey || null,
          geminiApiKey: data.geminiApiKey || null,
          claudeApiKey: data.claudeApiKey || null,
          openaiApiKey: data.openaiApiKey || null,
          grokApiKey: data.grokApiKey || null,
          deepseekApiKey: data.deepseekApiKey || null,
          preferredProvider: data.preferredProvider,
          appLanguage: data.appLanguage,
          hfMaxTokensPerMinute: data.hfMaxTokensPerMinute,
          hfMaxRequestsPerMinute: data.hfMaxRequestsPerMinute,
          geminiMaxTokensPerMinute: data.geminiMaxTokensPerMinute,
          geminiMaxRequestsPerMinute: data.geminiMaxRequestsPerMinute,
          claudeMaxTokensPerMinute: data.claudeMaxTokensPerMinute,
          claudeMaxRequestsPerMinute: data.claudeMaxRequestsPerMinute,
          openaiMaxTokensPerMinute: data.openaiMaxTokensPerMinute,
          openaiMaxRequestsPerMinute: data.openaiMaxRequestsPerMinute,
          grokMaxTokensPerMinute: data.grokMaxTokensPerMinute,
          grokMaxRequestsPerMinute: data.grokMaxRequestsPerMinute,
          deepseekMaxTokensPerMinute: data.deepseekMaxTokensPerMinute,
          deepseekMaxRequestsPerMinute: data.deepseekMaxRequestsPerMinute,
        },
        create: {
          shop: session.shop,
          huggingfaceApiKey: data.huggingfaceApiKey || null,
          geminiApiKey: data.geminiApiKey || null,
          claudeApiKey: data.claudeApiKey || null,
          openaiApiKey: data.openaiApiKey || null,
          grokApiKey: data.grokApiKey || null,
          deepseekApiKey: data.deepseekApiKey || null,
          preferredProvider: data.preferredProvider,
          appLanguage: data.appLanguage,
          hfMaxTokensPerMinute: data.hfMaxTokensPerMinute,
          hfMaxRequestsPerMinute: data.hfMaxRequestsPerMinute,
          geminiMaxTokensPerMinute: data.geminiMaxTokensPerMinute,
          geminiMaxRequestsPerMinute: data.geminiMaxRequestsPerMinute,
          claudeMaxTokensPerMinute: data.claudeMaxTokensPerMinute,
          claudeMaxRequestsPerMinute: data.claudeMaxRequestsPerMinute,
          openaiMaxTokensPerMinute: data.openaiMaxTokensPerMinute,
          openaiMaxRequestsPerMinute: data.openaiMaxRequestsPerMinute,
          grokMaxTokensPerMinute: data.grokMaxTokensPerMinute,
          grokMaxRequestsPerMinute: data.grokMaxRequestsPerMinute,
          deepseekMaxTokensPerMinute: data.deepseekMaxTokensPerMinute,
          deepseekMaxRequestsPerMinute: data.deepseekMaxRequestsPerMinute,
        },
      });

      return json({ success: true });
    }
  } catch (error: unknown) {
    // Use safe error handler to prevent information leakage
    const safeError = toSafeErrorResponse(error, {
      shop: session.shop,
      actionType,
    });
    return json({ success: false, error: safeError.message }, { status: safeError.statusCode });
  }
};

export default function SettingsPage() {
  const { shop, settings, instructions, productCount, translationCount, webhookCount, collectionCount, articleCount, subscriptionPlan } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const isFreePlan = subscriptionPlan === "free";

  const [selectedSection, setSelectedSection] = useState<"setup" | "ai" | "instructions" | "language">("setup");

  // Show global InfoBox when fetcher returns success or error
  useEffect(() => {
    if (fetcher.data?.success) {
      showInfoBox(t.common.settingsSaved, "success", t.common.success);
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.common.error);
    }
  }, [fetcher.data, showInfoBox, t]);

  return (
    <Page fullWidth>
      <MainNavigation />
      <div style={{ padding: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          {/* Left Sidebar */}
          <div style={{ width: "250px", flexShrink: 0 }}>
            <Card padding="0">
              <button
                onClick={() => setSelectedSection("setup")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "setup" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "setup" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "setup" ? "semibold" : "regular"}>
                  {t.settings.appSetup}
                </Text>
              </button>
              <button
                onClick={() => setSelectedSection("ai")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "ai" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "ai" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
                  borderTop: "1px solid #e1e3e5",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "ai" ? "semibold" : "regular"}>
                  {t.settings.aiApiAccess}
                </Text>
              </button>
              <button
                onClick={() => setSelectedSection("instructions")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "instructions" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "instructions" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
                  borderTop: "1px solid #e1e3e5",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "instructions" ? "semibold" : "regular"}>
                  {t.settings.aiInstructions}
                </Text>
              </button>
              <button
                onClick={() => setSelectedSection("language")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "language" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "language" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
                  borderTop: "1px solid #e1e3e5",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "language" ? "semibold" : "regular"}>
                  {t.settings.appLanguage}
                </Text>
              </button>
            </Card>
          </div>

          {/* Main Content */}
          <div style={{ flex: 1 }}>
            <BlockStack gap="400">
              {/* App Setup Section */}
              {selectedSection === "setup" && (
                <SettingsSetupTab
                  shop={shop}
                  productCount={productCount}
                  collectionCount={collectionCount}
                  articleCount={articleCount}
                  translationCount={translationCount}
                  webhookCount={webhookCount}
                  t={t}
                />
              )}

              {/* AI Settings */}
              {selectedSection === "ai" && (
                <SettingsAITab
                  settings={settings}
                  fetcher={fetcher}
                  t={t}
                />
              )}

              {/* AI Instructions */}
              {selectedSection === "instructions" && (
                <>
                  {isFreePlan && (
                    <Banner tone="info">
                      <Text as="p" fontWeight="semibold">
                        {t.settings.aiInstructionsReadOnly}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.settings.aiInstructionsReadOnlyDescription}
                      </Text>
                    </Banner>
                  )}
                  <AIInstructionsTabs
                    instructions={instructions}
                    fetcher={fetcher}
                    readOnly={isFreePlan}
                  />
                </>
              )}

              {/* Language Settings */}
              {selectedSection === "language" && (
                <SettingsLanguageTab
                  settings={settings}
                  fetcher={fetcher}
                  t={t}
                />
              )}
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

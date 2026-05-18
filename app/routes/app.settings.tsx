import { useState, useEffect, useCallback } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { SettingsSetupTab } from "../components/SettingsSetupTab";
import { SettingsAITab } from "../components/SettingsAITab";
import { SettingsLanguageTab } from "../components/SettingsLanguageTab";
import { SettingsTranslationsTab } from "../components/SettingsTranslationsTab";
import { SettingsSkuTab } from "../components/SettingsSkuTab";
import { SettingsSEOTab } from "../components/SettingsSEOTab";
import { SettingsUsageLimitsTab } from "../components/SettingsUsageLimitsTab";
import { SettingsPlanTab } from "../components/SettingsPlanTab";
import { SettingsImageManagerTab } from "../components/SettingsImageManagerTab";
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useNavigationGuard } from "../contexts/NavigationGuardContext";
import { sanitizeHTML } from "../utils/sanitizer";
import { AISettingsSchema, AIInstructionsSchema, parseFormData } from "../utils/validation";
import { getFormString } from "../utils/form-data.utils";
import { toSafeErrorResponse } from "../utils/error-handler";
import { encryptApiKey, decryptApiKeyChecked } from "../utils/encryption.server";
import { getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import {
  DEFAULT_GENERAL_INSTRUCTIONS,
  DEFAULT_PRODUCT_INSTRUCTIONS,
  DEFAULT_COLLECTION_INSTRUCTIONS,
  DEFAULT_BLOG_INSTRUCTIONS,
  DEFAULT_PAGE_INSTRUCTIONS,
  DEFAULT_POLICY_INSTRUCTIONS
} from "../constants/aiInstructionsDefaults";
import { logger } from "~/utils/logger.server";
import { checkAndSyncSubscription, getCurrentSubscription, getTrialInfo } from "~/services/billing.server";
import { resolveDevPlanMode } from "~/services/dev-plan-override.server";
import { getImageOperationUsage } from "~/utils/imageOperations.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {

  try {
    const { admin, session } = await authenticate.admin(request);

    // If returning from billing confirmation, sync subscription with Shopify
    const url = new URL(request.url);
    if (url.searchParams.get('billing') === 'success') {
      logger.info("[SETTINGS] Billing callback detected, syncing subscription", { context: "Settings", shop: session.shop });
      await checkAndSyncSubscription(admin, session.shop);
    }

    // Fetch shop's primary locale and display name
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopInfo {
          shopLocales {
            locale
            primary
          }
          shop {
            name
          }
        }`
    );

    const localesData = await localesResponse.json();
    const primaryShopLocale = localesData.data.shopLocales.find((l: any) => l.primary)?.locale || "en";
    const shopDisplayName: string = localesData.data.shop?.name || "";

    let settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });

    if (!settings) {
      // Auto-select app language based on shop's primary locale
      const autoSelectedLanguage = primaryShopLocale.startsWith("en") ? "en" : "de";

      settings = await db.aISettings.create({
        data: {
          shop: session.shop,
          preferredProvider: "claude",
          appLanguage: autoSelectedLanguage,
        },
      });
    }

  // Fetch AI instructions
  let instructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  if (!instructions) {
    // Create new entry with all defaults
    instructions = await db.aIInstructions.create({
      data: {
        shop: session.shop,
        // General (Writing Style Instructions)
        writingStyleInstructions: DEFAULT_GENERAL_INSTRUCTIONS.writingStyleInstructions,
        // General (Format Instructions)
        formatPreserveInstructions: DEFAULT_GENERAL_INSTRUCTIONS.formatPreserveInstructions,
        // General (Translate Instructions)
        translateInstructions: DEFAULT_GENERAL_INSTRUCTIONS.translateInstructions,
        // Products
        productTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
        productTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
        productDescriptionFormat: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
        productDescriptionInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
        productHandleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
        productHandleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
        productSeoTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
        productSeoTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
        productMetaDescFormat: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
        productMetaDescInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
        productAltTextFormat: DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
        productAltTextInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
        // Collections
        collectionTitleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.titleFormat,
        collectionTitleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.titleInstructions,
        collectionDescriptionFormat: DEFAULT_COLLECTION_INSTRUCTIONS.descriptionFormat,
        collectionDescriptionInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.descriptionInstructions,
        collectionHandleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.handleFormat,
        collectionHandleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.handleInstructions,
        collectionSeoTitleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleFormat,
        collectionSeoTitleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleInstructions,
        collectionMetaDescFormat: DEFAULT_COLLECTION_INSTRUCTIONS.metaDescFormat,
        collectionMetaDescInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.metaDescInstructions,
        // Blogs
        blogTitleFormat: DEFAULT_BLOG_INSTRUCTIONS.titleFormat,
        blogTitleInstructions: DEFAULT_BLOG_INSTRUCTIONS.titleInstructions,
        blogDescriptionFormat: DEFAULT_BLOG_INSTRUCTIONS.descriptionFormat,
        blogDescriptionInstructions: DEFAULT_BLOG_INSTRUCTIONS.descriptionInstructions,
        blogHandleFormat: DEFAULT_BLOG_INSTRUCTIONS.handleFormat,
        blogHandleInstructions: DEFAULT_BLOG_INSTRUCTIONS.handleInstructions,
        blogSeoTitleFormat: DEFAULT_BLOG_INSTRUCTIONS.seoTitleFormat,
        blogSeoTitleInstructions: DEFAULT_BLOG_INSTRUCTIONS.seoTitleInstructions,
        blogMetaDescFormat: DEFAULT_BLOG_INSTRUCTIONS.metaDescFormat,
        blogMetaDescInstructions: DEFAULT_BLOG_INSTRUCTIONS.metaDescInstructions,
        // Pages
        pageTitleFormat: DEFAULT_PAGE_INSTRUCTIONS.titleFormat,
        pageTitleInstructions: DEFAULT_PAGE_INSTRUCTIONS.titleInstructions,
        pageDescriptionFormat: DEFAULT_PAGE_INSTRUCTIONS.descriptionFormat,
        pageDescriptionInstructions: DEFAULT_PAGE_INSTRUCTIONS.descriptionInstructions,
        pageHandleFormat: DEFAULT_PAGE_INSTRUCTIONS.handleFormat,
        pageHandleInstructions: DEFAULT_PAGE_INSTRUCTIONS.handleInstructions,
        pageSeoTitleFormat: DEFAULT_PAGE_INSTRUCTIONS.seoTitleFormat,
        pageSeoTitleInstructions: DEFAULT_PAGE_INSTRUCTIONS.seoTitleInstructions,
        pageMetaDescFormat: DEFAULT_PAGE_INSTRUCTIONS.metaDescFormat,
        pageMetaDescInstructions: DEFAULT_PAGE_INSTRUCTIONS.metaDescInstructions,
        // Policies
        policyDescriptionFormat: DEFAULT_POLICY_INSTRUCTIONS.descriptionFormat,
        policyDescriptionInstructions: DEFAULT_POLICY_INSTRUCTIONS.descriptionInstructions,
      },
    });
  } else if (!instructions.productSeoTitleInstructions || !instructions.productTitleInstructions || !instructions.formatPreserveInstructions || !instructions.translateInstructions || !instructions.writingStyleInstructions) {
    // Entry exists but some fields are empty - populate with defaults (only once)
    instructions = await db.aIInstructions.update({
      where: { shop: session.shop },
      data: {
        // General (Writing Style Instructions)
        writingStyleInstructions: instructions.writingStyleInstructions || DEFAULT_GENERAL_INSTRUCTIONS.writingStyleInstructions,
        // General (Format Instructions)
        formatPreserveInstructions: instructions.formatPreserveInstructions || DEFAULT_GENERAL_INSTRUCTIONS.formatPreserveInstructions,
        // General (Translate Instructions)
        translateInstructions: instructions.translateInstructions || DEFAULT_GENERAL_INSTRUCTIONS.translateInstructions,
        // Products - only update NULL fields
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
        productAltTextFormat: instructions.productAltTextFormat || DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
        productAltTextInstructions: instructions.productAltTextInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
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
        // Policies
        policyDescriptionFormat: instructions.policyDescriptionFormat || DEFAULT_POLICY_INSTRUCTIONS.descriptionFormat,
        policyDescriptionInstructions: instructions.policyDescriptionInstructions || DEFAULT_POLICY_INSTRUCTIONS.descriptionInstructions,
      },
    });
  }

    // Get counts for App Setup section
    const productCount = await db.product.count({
      where: { shop: session.shop },
    });

    // Get all resource IDs for this shop to count translations
    const products = await db.product.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const collections = await db.collection.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const articles = await db.article.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const pages = await db.page.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });

    // Count translations for all resources belonging to this shop
    const resourceIds = [
      ...products.map(p => p.id),
      ...collections.map(c => c.id),
      ...articles.map(a => a.id),
      ...pages.map(p => p.id),
    ];

    const translationCount = resourceIds.length > 0
      ? await db.contentTranslation.count({
          where: {
            shop: session.shop,
            resourceId: { in: resourceIds },
          },
        })
      : 0;

    const webhookCount = await db.webhookLog.count({
      where: { shop: session.shop },
    });

    const collectionCount = await db.collection.count({
      where: { shop: session.shop },
    });

    const articleCount = await db.article.count({
      where: { shop: session.shop },
    });

    const pageCount = await db.page.count({
      where: { shop: session.shop },
    });

    const themeTranslationCount = await db.themeTranslation.count({
      where: { shop: session.shop },
    });

    // Rolling monthly image-operation usage (Bulk-Upload + WebP). Read-only and
    // fail-safe: a transient error or a code-before-migration deploy window
    // must NOT take down the whole Settings page (other usage counts are
    // defensively wrapped the same way).
    let imageOperationCount = 0;
    try {
      ({ count: imageOperationCount } = await getImageOperationUsage(session.shop));
    } catch (e) {
      logger.warn("[ImageOps] usage read failed, defaulting to 0", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Count active locales from shop locales
    const localeCount = localesData.data.shopLocales?.length || 1;

    // Get subscription plan
    const subscriptionPlan = settings.subscriptionPlan || "free";

    // Live trial detection for the Plan tab banner. One unconditional
    // getCurrentSubscription call (normal settings loads otherwise make no
    // subscription GraphQL call). Fail-safe: on any error, no banner.
    let inTrial = false;
    let trialRemainingDays = 0;
    try {
      const sub = await getCurrentSubscription(admin);
      const info = getTrialInfo({
        subscriptionStatus: sub?.status ?? null,
        trialDays: sub?.trialDays ?? 0,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      });
      inTrial = info.inTrial;
      trialRemainingDays = info.remainingDays;
    } catch (e) {
      logger.warn("[SETTINGS] Could not load subscription for trial banner", { error: e });
    }

    // Check if this is a development/partner test store
    let isTestStore = false;
    try {
      const shopResponse = await admin.graphql(
        `#graphql
          query { shop { plan { partnerDevelopment } } }
        `
      );
      const shopData = await shopResponse.json();
      isTestStore = shopData.data?.shop?.plan?.partnerDevelopment === true;
    } catch (e) {
      logger.warn("[SETTINGS] Could not determine shop plan type", { error: e });
    }

    // Whether Shopify billing is bypassed for this shop (dev/custom-app build,
    // or an allow-listed developer-owned test-billing shop). Drives the
    // "switching plans is free" notice on the Plan tab.
    const devPlanMode = resolveDevPlanMode(session.shop);

    // Decrypt API keys per-key. A single corrupted key (e.g. encrypted with a
    // previous ENCRYPTION_KEY) must not wipe the others — instead we surface
    // exactly which provider keys are broken so the merchant can re-enter them.
    type ApiKeyField =
      | "huggingfaceApiKey"
      | "geminiApiKey"
      | "claudeApiKey"
      | "openaiApiKey"
      | "grokApiKey"
      | "deepseekApiKey";
    const keyFields: { field: ApiKeyField; provider: AIProvider }[] = [
      { field: "huggingfaceApiKey", provider: "huggingface" },
      { field: "geminiApiKey", provider: "gemini" },
      { field: "claudeApiKey", provider: "claude" },
      { field: "openaiApiKey", provider: "openai" },
      { field: "grokApiKey", provider: "grok" },
      { field: "deepseekApiKey", provider: "deepseek" },
    ];
    const decryptedKeys: Record<ApiKeyField, string> = {
      huggingfaceApiKey: "",
      geminiApiKey: "",
      claudeApiKey: "",
      openaiApiKey: "",
      grokApiKey: "",
      deepseekApiKey: "",
    };
    const corruptedApiKeys: string[] = [];
    for (const { field, provider } of keyFields) {
      const { value, corrupted } = decryptApiKeyChecked(settings[field] as string | null | undefined);
      decryptedKeys[field] = value || "";
      if (corrupted) {
        corruptedApiKeys.push(getProviderDisplayName(provider));
        logger.error("[SETTINGS LOADER] Decryption error", { context: "Settings", provider });
      }
    }

    const imageManagerSettings = await db.imageManagerSettings.findUnique({
      where: { shopId: session.shop },
    }) ?? { enabled: true, firstImageBig: false, showAltTags: false, autoAltText: false };
    const { isProductionLocked } = await import("../utils/planUtils");
    const showImageManagerTab = !isProductionLocked() && (subscriptionPlan === "pro" || subscriptionPlan === "max");
    // Future-options Settings tabs (SKU match keys, productType Translations
    // mapping). Develop-only — hidden in production until ready to ship,
    // same prod-gate as showImageManagerTab.
    const showSkuTab = !isProductionLocked();
    const showTranslationsTab = !isProductionLocked();

    const groupedFieldTranslations = await db.groupedFieldTranslation.findMany({
      where: { shop: session.shop },
      orderBy: [{ fieldKey: "asc" }, { sourceValue: "asc" }, { targetLocale: "asc" }],
    });

    const optionValueMemory = await db.optionValueMemory.findMany({
      where: { shop: session.shop },
      orderBy: { optionValue: "asc" },
    });

    return json({
      shop: session.shop,
      shopDisplayName,
      productCount,
      translationCount,
      webhookCount,
      collectionCount,
      articleCount,
      pageCount,
      themeTranslationCount,
      imageOperationCount,
      localeCount,
      isTestStore,
      devPlanMode,
      subscriptionPlan,
      inTrial,
      trialRemainingDays,
      imageManagerSettings,
      showImageManagerTab,
      showSkuTab,
      showTranslationsTab,
      groupedFieldTranslations,
      optionValueMemory,
      primaryShopLocale,
      corruptedApiKeys,
      settings: {
        ...decryptedKeys,
        preferredProvider: settings.preferredProvider,
        selectedModel: settings.selectedModel || '',
        appLanguage: settings.appLanguage || "en",

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

        // SEO title suffix
        seoTitleSuffixEnabled: settings.seoTitleSuffixEnabled ?? false,
        seoTitleSuffix: settings.seoTitleSuffix || '',
      },
      instructions: {
        // General (Writing Style Instructions)
        writingStyleInstructions: instructions.writingStyleInstructions || DEFAULT_GENERAL_INSTRUCTIONS.writingStyleInstructions,
        // General (Format Instructions)
        formatPreserveInstructions: instructions.formatPreserveInstructions || DEFAULT_GENERAL_INSTRUCTIONS.formatPreserveInstructions,
        // General (Translate Instructions)
        translateInstructions: instructions.translateInstructions || DEFAULT_GENERAL_INSTRUCTIONS.translateInstructions,

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
  } catch (error: unknown) {
    // Re-throw Response objects (e.g., auth redirects) to let the framework handle them
    if (error instanceof Response) {
      throw error;
    }

    logger.error("[SETTINGS LOADER] Fatal error", { context: "Settings", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    // Use safe error handler
    const safeError = toSafeErrorResponse(error, {
      route: 'app.settings',
      action: 'loader',
    });
    throw new Response(safeError.message, { status: safeError.statusCode });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = getFormString(formData, "actionType");
  if (!actionType) {
    return json({ success: false, error: "Missing required field: actionType" }, { status: 400 });
  }

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
        // General (Writing Style Instructions)
        writingStyleInstructions: data.writingStyleInstructions || null,
        // General (Format Instructions)
        formatPreserveInstructions: data.formatPreserveInstructions || null,
        // General (Translate Instructions)
        translateInstructions: data.translateInstructions || null,

        // Products
        productTitleFormat: data.productTitleFormat || null,
        productTitleInstructions: data.productTitleInstructions || null,
        productDescriptionFormat: data.productDescriptionFormat ? sanitizeHTML(data.productDescriptionFormat) : null,
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
        collectionDescriptionFormat: data.collectionDescriptionFormat ? sanitizeHTML(data.collectionDescriptionFormat) : null,
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
        blogDescriptionFormat: data.blogDescriptionFormat ? sanitizeHTML(data.blogDescriptionFormat) : null,
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
        pageDescriptionFormat: data.pageDescriptionFormat ? sanitizeHTML(data.pageDescriptionFormat) : null,
        pageDescriptionInstructions: data.pageDescriptionInstructions || null,
        pageHandleFormat: data.pageHandleFormat || null,
        pageHandleInstructions: data.pageHandleInstructions || null,
        pageSeoTitleFormat: data.pageSeoTitleFormat || null,
        pageSeoTitleInstructions: data.pageSeoTitleInstructions || null,
        pageMetaDescFormat: data.pageMetaDescFormat || null,
        pageMetaDescInstructions: data.pageMetaDescInstructions || null,

        // Policies
        policyDescriptionFormat: data.policyDescriptionFormat ? sanitizeHTML(data.policyDescriptionFormat) : null,
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
    } else if (actionType === "saveSeoSettings") {
      const enabled = formData.get("seoTitleSuffixEnabled") === "true";
      const suffix = String(formData.get("seoTitleSuffix") || "").slice(0, 60) || null;

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: { seoTitleSuffixEnabled: enabled, seoTitleSuffix: suffix },
        create: { shop: session.shop, seoTitleSuffixEnabled: enabled, seoTitleSuffix: suffix },
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
          huggingfaceApiKey: encryptApiKey(data.huggingfaceApiKey),
          geminiApiKey: encryptApiKey(data.geminiApiKey),
          claudeApiKey: encryptApiKey(data.claudeApiKey),
          openaiApiKey: encryptApiKey(data.openaiApiKey),
          grokApiKey: encryptApiKey(data.grokApiKey),
          deepseekApiKey: encryptApiKey(data.deepseekApiKey),
          preferredProvider: data.preferredProvider,
          selectedModel: data.selectedModel || null,
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
          seoTitleSuffixEnabled: data.seoTitleSuffixEnabled ?? false,
          seoTitleSuffix: data.seoTitleSuffix || null,
        },
        create: {
          shop: session.shop,
          huggingfaceApiKey: encryptApiKey(data.huggingfaceApiKey),
          geminiApiKey: encryptApiKey(data.geminiApiKey),
          claudeApiKey: encryptApiKey(data.claudeApiKey),
          openaiApiKey: encryptApiKey(data.openaiApiKey),
          grokApiKey: encryptApiKey(data.grokApiKey),
          deepseekApiKey: encryptApiKey(data.deepseekApiKey),
          preferredProvider: data.preferredProvider,
          selectedModel: data.selectedModel || null,
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
          seoTitleSuffixEnabled: data.seoTitleSuffixEnabled ?? false,
          seoTitleSuffix: data.seoTitleSuffix || null,
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
  const { shop, shopDisplayName, settings, instructions, productCount, translationCount, webhookCount, collectionCount, articleCount, pageCount, themeTranslationCount, imageOperationCount, localeCount, subscriptionPlan, inTrial, trialRemainingDays, isTestStore, devPlanMode, imageManagerSettings, showImageManagerTab, showSkuTab, showTranslationsTab, groupedFieldTranslations, optionValueMemory, primaryShopLocale, corruptedApiKeys = [] } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const { registerItems, clearItems } = useItemSelector();
  const { registerGuard, unregisterGuard } = useNavigationGuard();
  const isFreePlan = subscriptionPlan === "free";
  const isBasicPlan = subscriptionPlan === "basic";
  const aiInstructionsReadOnly = isFreePlan || isBasicPlan;

  // Get initial tab from URL parameter (e.g., ?tab=plan).
  // Billing callbacks always land on the plan tab so the merchant sees the result.
  const getInitialSection = (): "setup" | "ai" | "instructions" | "language" | "translations" | "sku" | "seo" | "plan" | "feedback" => {
    if (searchParams.get("billing")) return "plan";
    const tabParam = searchParams.get("tab");
    // Don't honor deep-links to prod-gated future tabs (would render blank).
    if (tabParam === "sku" && !showSkuTab) return "setup";
    if (tabParam === "translations" && !showTranslationsTab) return "setup";
    if (tabParam && ["setup", "ai", "instructions", "language", "translations", "sku", "seo", "plan", "feedback"].includes(tabParam)) {
      return tabParam as "setup" | "ai" | "instructions" | "language" | "translations" | "sku" | "seo" | "plan" | "feedback";
    }
    return "setup";
  };

  const [selectedSection, setSelectedSection] = useState<"setup" | "ai" | "instructions" | "language" | "translations" | "sku" | "seo" | "plan" | "feedback" | "imagemanager">(getInitialSection);
  const [hasAIChanges, setHasAIChanges] = useState(false);
  const [hasLanguageChanges, setHasLanguageChanges] = useState(false);
  const [hasInstructionsChanges, setHasInstructionsChanges] = useState(false);
  const [hasImageManagerChanges, setHasImageManagerChanges] = useState(false);
  const [highlightSaveButton, setHighlightSaveButton] = useState(false);
  // Check if there are any unsaved changes across tabs
  const hasUnsavedChanges = hasAIChanges || hasLanguageChanges || hasInstructionsChanges || hasImageManagerChanges;

  const triggerSaveButtonHighlight = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setHighlightSaveButton(true);
    showInfoBox(
      t.settings?.unsavedChangesMessage || "You have unsaved changes. Please save before navigating away.",
      "warning",
      t.common?.unsavedChanges || "Unsaved Changes"
    );
    setTimeout(() => setHighlightSaveButton(false), 3000);
  }, [showInfoBox, t]);

  // Register navigation guard while there are unsaved changes
  useEffect(() => {
    if (hasUnsavedChanges) {
      registerGuard(() => {
        triggerSaveButtonHighlight();
        return false;
      });
    } else {
      unregisterGuard();
    }
    return () => unregisterGuard();
  }, [hasUnsavedChanges, registerGuard, unregisterGuard, triggerSaveButtonHighlight]);

  // Handle section navigation with unsaved changes warning
  const handleSectionChange = (newSection: "setup" | "ai" | "instructions" | "language" | "translations" | "sku" | "seo" | "plan" | "feedback" | "imagemanager") => {
    if (hasUnsavedChanges) {
      triggerSaveButtonHighlight();
      return;
    }
    setSelectedSection(newSection);
  };

  // Reset changes state after successful save
  useEffect(() => {
    if (fetcher.data?.success) {
      setHasAIChanges(false);
      setHasLanguageChanges(false);
      setHasInstructionsChanges(false);
      setHighlightSaveButton(false);
    }
  }, [fetcher.data]);

  // Show global InfoBox when fetcher returns success or error
  // Also revalidate root loader so SeoSettingsContext picks up new suffix immediately
  useEffect(() => {
    if (fetcher.data?.success) {
      showInfoBox(t.common.settingsSaved, "success", t.common.success);
      revalidator.revalidate();
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.common.error);
    }
  }, [fetcher.data, showInfoBox, t]);

  // Surface which stored API key(s) could not be decrypted (e.g. after an
  // ENCRYPTION_KEY change). The key was reset to empty — the merchant must
  // re-enter and save it. Show once when the page loads.
  useEffect(() => {
    if (corruptedApiKeys.length === 0) return;
    const providers = corruptedApiKeys.join(", ");
    const template =
      t.settings?.corruptedApiKeyWarning ||
      "The stored API key for {provider} could not be decrypted and was cleared. Please re-enter it and save.";
    showInfoBox(
      template.replace("{provider}", providers),
      "critical",
      t.settings?.corruptedApiKeyTitle || "API key error"
    );
  }, [corruptedApiKeys, showInfoBox, t]);

  // Register settings sections in item selector context (for mobile header dropdown)
  useEffect(() => {
    const sections = [
      { id: "setup", title: t.settings.appSetup },
      { id: "ai", title: t.settings.aiApiAccess },
      { id: "instructions", title: t.settings.aiInstructions },
      { id: "language", title: t.settings.appLanguage },
      ...(showTranslationsTab ? [{ id: "translations", title: t.settings.translations }] : []),
      ...(showSkuTab ? [{ id: "sku", title: t.settings.sku }] : []),
      { id: "seo", title: t.settings.seoSettings || "SEO" },
      { id: "plan", title: t.settings.plan },
      { id: "feedback", title: t.settings.feedback },
    ];

    registerItems({
      items: sections,
      selectedItemId: selectedSection,
      onItemSelect: (itemId: string) => handleSectionChange(itemId as any),
      resourceName: {
        singular: "Section",
        plural: "Settings",
      },
      t: {
        searchPlaceholder: "Search settings...",
        noResults: "No sections found",
        selectItem: "Select section",
      },
    });

    // Cleanup: clear items when component unmounts
    return () => {
      clearItems();
    };
  }, [selectedSection, t, registerItems, clearItems]);

  return (
    <Page fullWidth>
      <MainNavigation />
      <div style={{ padding: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          {/* Left Sidebar - Hidden on mobile */}
          <div className="settings-desktop-nav" style={{ width: "250px", flexShrink: 0 }}>
            <Card padding="0">
              <button
                onClick={() => handleSectionChange("setup")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "setup" ? "#f1f8f5" : "white",
                  borderTop: "none",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "setup" ? "3px solid #008060" : "3px solid transparent",
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
                onClick={() => handleSectionChange("ai")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "ai" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "ai" ? "3px solid #008060" : "3px solid transparent",
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
                onClick={() => handleSectionChange("instructions")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "instructions" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "instructions" ? "3px solid #008060" : "3px solid transparent",
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
                onClick={() => handleSectionChange("language")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "language" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "language" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "language" ? "semibold" : "regular"}>
                  {t.settings.appLanguage}
                </Text>
              </button>
              {showTranslationsTab && (
              <button
                onClick={() => handleSectionChange("translations")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "translations" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "translations" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "translations" ? "semibold" : "regular"}>
                  {t.settings.translations}
                </Text>
              </button>
              )}
              {showSkuTab && (
              <button
                onClick={() => handleSectionChange("sku")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "sku" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "sku" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "sku" ? "semibold" : "regular"}>
                  {t.settings.sku}
                </Text>
              </button>
              )}
              <button
                onClick={() => handleSectionChange("seo")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "seo" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "seo" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "seo" ? "semibold" : "regular"}>
                  {t.settings.seoSettings || "SEO"}
                </Text>
              </button>
              <button
                onClick={() => handleSectionChange("plan")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "plan" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "plan" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "plan" ? "semibold" : "regular"}>
                  {t.settings.plan}
                </Text>
              </button>
              {showImageManagerTab && (
                <button
                  onClick={() => handleSectionChange("imagemanager")}
                  style={{
                    width: "100%",
                    padding: "1rem",
                    background: selectedSection === "imagemanager" ? "#f1f8f5" : "white",
                    borderTop: "1px solid #e1e3e5",
                    borderRight: "none",
                    borderBottom: "none",
                    borderLeft: selectedSection === "imagemanager" ? "3px solid #008060" : "3px solid transparent",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                >
                  <Text as="p" variant="bodyMd" fontWeight={selectedSection === "imagemanager" ? "semibold" : "regular"}>
                    Image Manager
                  </Text>
                </button>
              )}
              <button
                onClick={() => handleSectionChange("feedback")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "feedback" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "feedback" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "feedback" ? "semibold" : "regular"}>
                  {t.settings.feedback}
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
                  onHasChangesChange={setHasAIChanges}
                  highlightSaveButton={highlightSaveButton}
                />
              )}

              {/* AI Instructions */}
              {selectedSection === "instructions" && (
                <>
                  {aiInstructionsReadOnly && (
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
                    readOnly={aiInstructionsReadOnly}
                    onHasChangesChange={setHasInstructionsChanges}
                    highlightSaveButton={highlightSaveButton}
                  />
                </>
              )}

              {/* Language Settings */}
              {selectedSection === "language" && (
                <SettingsLanguageTab
                  settings={settings}
                  fetcher={fetcher}
                  t={t}
                  onHasChangesChange={setHasLanguageChanges}
                  highlightSaveButton={highlightSaveButton}
                />
              )}

              {/* Translations Mapping (productType) */}
              {selectedSection === "translations" && showTranslationsTab && (
                <SettingsTranslationsTab
                  groupedFieldTranslations={groupedFieldTranslations}
                  primaryShopLocale={primaryShopLocale}
                  t={t}
                />
              )}

              {/* SKU / variant match keys */}
              {selectedSection === "sku" && showSkuTab && (
                <SettingsSkuTab
                  optionValueMemory={optionValueMemory}
                  t={t}
                />
              )}

              {/* SEO Settings */}
              {selectedSection === "seo" && (
                <SettingsSEOTab
                  settings={settings}
                  fetcher={fetcher}
                  t={t}
                  shopDisplayName={shopDisplayName}
                  onHasChangesChange={setHasAIChanges}
                  highlightSaveButton={highlightSaveButton}
                />
              )}

              {/* Plan Settings */}
              {selectedSection === "plan" && (
                <>
                  {searchParams.get("billing") === "success" && (
                    <Banner
                      tone="success"
                      title={t.settings?.billingSuccessTitle || "Plan activated"}
                      onDismiss={() => setSearchParams(prev => { prev.delete("billing"); prev.delete("plan"); return prev; }, { replace: true })}
                    >
                      <p>{t.settings?.billingSuccessMessage || `Your subscription to the ${searchParams.get("plan") || ""} plan is now active.`}</p>
                    </Banner>
                  )}
                  {searchParams.get("billing") === "declined" && (
                    <Banner
                      tone="warning"
                      title={t.settings?.billingDeclinedTitle || "Payment not completed"}
                      onDismiss={() => setSearchParams(prev => { prev.delete("billing"); prev.delete("plan"); return prev; }, { replace: true })}
                    >
                      <p>{t.settings?.billingDeclinedMessage || "The subscription was not activated. You can try again below."}</p>
                    </Banner>
                  )}
                  {searchParams.get("billing") === "error" && (
                    <Banner
                      tone="critical"
                      title={t.settings?.billingErrorTitle || "Billing error"}
                      onDismiss={() => setSearchParams(prev => { prev.delete("billing"); prev.delete("plan"); return prev; }, { replace: true })}
                    >
                      <p>{t.settings?.billingErrorMessage || "Something went wrong while processing your subscription. Please try again or contact support."}</p>
                    </Banner>
                  )}
                  <SettingsPlanTab
                    subscriptionPlan={subscriptionPlan}
                    inTrial={inTrial}
                    trialRemainingDays={trialRemainingDays}
                    isTestStore={isTestStore}
                    devPlanMode={devPlanMode}
                    productCount={productCount}
                    localeCount={localeCount}
                    collectionCount={collectionCount}
                    articleCount={articleCount}
                    pageCount={pageCount}
                    themeTranslationCount={themeTranslationCount}
                    imageOperationCount={imageOperationCount}
                    t={t}
                  />
                </>
              )}

              {/* Image Manager Settings */}
              {selectedSection === "imagemanager" && showImageManagerTab && (
                <SettingsImageManagerTab
                  settings={{ enabled: imageManagerSettings?.enabled ?? true, autoAltText: imageManagerSettings?.autoAltText ?? false }}
                  shop={shop}
                  onHasChangesChange={setHasImageManagerChanges}
                  highlightSaveButton={highlightSaveButton}
                />
              )}

              {/* Feedback */}
              {selectedSection === "feedback" && (
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
              )}
            </BlockStack>
          </div>
        </div>
      </div>

      {/* Responsive Styles */}
      <style>{`
        /* Hide desktop navigation when dropdown is visible (below 900px) */
        @media (max-width: 899px) {
          .settings-desktop-nav {
            display: none !important;
          }
        }
      `}</style>
    </Page>
  );
}

import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
  Button,
  Badge,
  InlineStack,
  Divider,
} from "@shopify/polaris";
import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan } from "../config/plans";
import { BILLING_PLANS, getAvailablePlans, type BillingPlan } from "../config/billing";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { SettingsSetupTab } from "../components/SettingsSetupTab";
import { SettingsAITab } from "../components/SettingsAITab";
import { SettingsLanguageTab } from "../components/SettingsLanguageTab";
import { SettingsUsageLimitsTab } from "../components/SettingsUsageLimitsTab";
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { sanitizeFormatExample } from "../utils/sanitizer";
import { AISettingsSchema, AIInstructionsSchema, parseFormData } from "../utils/validation";
import { toSafeErrorResponse } from "../utils/error-handler";
import { encryptApiKey, decryptApiKey } from "../utils/encryption.server";
import {
  DEFAULT_PRODUCT_INSTRUCTIONS,
  DEFAULT_COLLECTION_INSTRUCTIONS,
  DEFAULT_BLOG_INSTRUCTIONS,
  DEFAULT_PAGE_INSTRUCTIONS,
  DEFAULT_POLICY_INSTRUCTIONS
} from "../constants/aiInstructionsDefaults";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log('[SETTINGS] Loading settings page for shop');

  try {
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
    // Create new entry with all defaults
    instructions = await db.aIInstructions.create({
      data: {
        shop: session.shop,
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
    console.log('[SETTINGS] Created AI Instructions with defaults for shop:', session.shop);
  } else if (!instructions.productSeoTitleInstructions || !instructions.productTitleInstructions) {
    // Entry exists but some fields are empty - populate with defaults (only once)
    console.log('[SETTINGS] Detected empty AI Instructions, populating defaults...');
    instructions = await db.aIInstructions.update({
      where: { shop: session.shop },
      data: {
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
    console.log('[SETTINGS] Updated AI Instructions with defaults for shop:', session.shop);
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

    // Count active locales from shop locales
    const localeCount = localesData.data.shopLocales?.length || 1;

    // Get subscription plan
    const subscriptionPlan = settings.subscriptionPlan || "basic";

    // Decrypt API keys with error handling
    let decryptedKeys;
    try {
      decryptedKeys = {
        huggingfaceApiKey: decryptApiKey(settings.huggingfaceApiKey) || "",
        geminiApiKey: decryptApiKey(settings.geminiApiKey) || "",
        claudeApiKey: decryptApiKey(settings.claudeApiKey) || "",
        openaiApiKey: decryptApiKey(settings.openaiApiKey) || "",
        grokApiKey: decryptApiKey(settings.grokApiKey) || "",
        deepseekApiKey: decryptApiKey(settings.deepseekApiKey) || "",
      };
    } catch (error) {
      console.error('[SETTINGS LOADER] Decryption error:', error);
      // If decryption fails, return empty keys
      decryptedKeys = {
        huggingfaceApiKey: "",
        geminiApiKey: "",
        claudeApiKey: "",
        openaiApiKey: "",
        grokApiKey: "",
        deepseekApiKey: "",
      };
    }

    return json({
      shop: session.shop,
      productCount,
      translationCount,
      webhookCount,
      collectionCount,
      articleCount,
      pageCount,
      themeTranslationCount,
      localeCount,
      subscriptionPlan,
      settings: {
        ...decryptedKeys,
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
  } catch (error: unknown) {
    console.error('[SETTINGS LOADER] Fatal error:', error);
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
          huggingfaceApiKey: encryptApiKey(data.huggingfaceApiKey),
          geminiApiKey: encryptApiKey(data.geminiApiKey),
          claudeApiKey: encryptApiKey(data.claudeApiKey),
          openaiApiKey: encryptApiKey(data.openaiApiKey),
          grokApiKey: encryptApiKey(data.grokApiKey),
          deepseekApiKey: encryptApiKey(data.deepseekApiKey),
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
          huggingfaceApiKey: encryptApiKey(data.huggingfaceApiKey),
          geminiApiKey: encryptApiKey(data.geminiApiKey),
          claudeApiKey: encryptApiKey(data.claudeApiKey),
          openaiApiKey: encryptApiKey(data.openaiApiKey),
          grokApiKey: encryptApiKey(data.grokApiKey),
          deepseekApiKey: encryptApiKey(data.deepseekApiKey),
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
  const { shop, settings, instructions, productCount, translationCount, webhookCount, collectionCount, articleCount, pageCount, themeTranslationCount, localeCount, subscriptionPlan } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const isFreePlan = subscriptionPlan === "free";
  const isBasicPlan = subscriptionPlan === "basic";
  const aiInstructionsReadOnly = isFreePlan || isBasicPlan;

  const [selectedSection, setSelectedSection] = useState<"setup" | "ai" | "instructions" | "language" | "plan">("setup");
  const [hasAIChanges, setHasAIChanges] = useState(false);
  const [hasLanguageChanges, setHasLanguageChanges] = useState(false);
  const [hasInstructionsChanges, setHasInstructionsChanges] = useState(false);
  const [planLoading, setPlanLoading] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  // Check if there are any unsaved changes across tabs
  const hasUnsavedChanges = hasAIChanges || hasLanguageChanges || hasInstructionsChanges;

  // Get available plans for billing
  const availablePlans = getAvailablePlans();

  // Handle plan selection
  const handleSelectPlan = async (plan: BillingPlan) => {
    if (plan === 'free') {
      if (window.confirm(t.settings.confirmDowngrade)) {
        setPlanLoading('free');
        setPlanError(null);

        try {
          const response = await fetch('/api/billing/cancel-subscription', {
            method: 'POST',
          });

          if (!response.ok) {
            throw new Error('Failed to cancel subscription');
          }

          window.location.reload();
        } catch (err) {
          setPlanError(err instanceof Error ? err.message : t.settings.errorOccurred);
          setPlanLoading(null);
        }
      }
      return;
    }

    setPlanLoading(plan);
    setPlanError(null);

    try {
      const response = await fetch('/api/billing/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create subscription');
      }

      if (data.confirmationUrl) {
        window.location.href = data.confirmationUrl;
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : t.settings.errorOccurred);
      setPlanLoading(null);
    }
  };

  // Handle section navigation with unsaved changes warning
  const handleSectionChange = (newSection: "setup" | "ai" | "instructions" | "language" | "plan") => {
    if (hasUnsavedChanges) {
      const message = t.settings?.unsavedChangesMessage ||
        "Sie haben ungespeicherte Änderungen. Möchten Sie wirklich fortfahren? Ihre Änderungen gehen verloren.";
      const confirmed = window.confirm(message);
      if (!confirmed) {
        return;
      }
      // Reset changes state when user confirms navigation
      setHasAIChanges(false);
      setHasLanguageChanges(false);
      setHasInstructionsChanges(false);
    }
    setSelectedSection(newSection);
  };

  // Reset changes state after successful save
  useEffect(() => {
    if (fetcher.data?.success) {
      setHasAIChanges(false);
      setHasLanguageChanges(false);
      setHasInstructionsChanges(false);
    }
  }, [fetcher.data]);

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
                onClick={() => handleSectionChange("setup")}
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
                onClick={() => handleSectionChange("ai")}
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
                onClick={() => handleSectionChange("instructions")}
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
                onClick={() => handleSectionChange("language")}
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
              <button
                onClick={() => handleSectionChange("plan")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "plan" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "plan" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
                  borderTop: "1px solid #e1e3e5",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "plan" ? "semibold" : "regular"}>
                  {t.settings.plan}
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
                />
              )}

              {/* Plan Settings */}
              {selectedSection === "plan" && (
                <BlockStack gap="400">
                  {planError && (
                    <Banner tone="critical" title={t.common.error} onDismiss={() => setPlanError(null)}>
                      <p>{planError}</p>
                    </Banner>
                  )}

                  <Text as="h2" variant="headingLg">
                    {t.settings.availablePlans}
                  </Text>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', alignItems: 'stretch' }}>
                    {availablePlans.map(({ id, config }) => {
                      const planDetails = PLAN_CONFIG[id];
                      const isCurrentPlan = id === subscriptionPlan;
                      const price = config ? `€${config.price.toFixed(2)}${t.settings.perMonth}` : t.settings.free;

                      return (
                        <div key={id} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                          <Card>
                            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '400px' }}>
                              <BlockStack gap="300">
                                <InlineStack align="space-between" blockAlign="start">
                                  <Text as="h3" variant="headingMd">
                                    {PLAN_DISPLAY_NAMES[id]}
                                  </Text>
                                  {isCurrentPlan && <Badge tone="success">{t.settings.active}</Badge>}
                                </InlineStack>

                                <Text as="p" variant="headingLg" fontWeight="bold">
                                  {price}
                                </Text>

                                <Divider />

                                <BlockStack gap="200">
                                  <Text as="p" variant="bodyMd">
                                    <strong>{t.settings.products}:</strong>{' '}
                                    {planDetails.maxProducts === Infinity
                                      ? t.settings.unlimited
                                      : planDetails.maxProducts}
                                  </Text>
                                  <Text as="p" variant="bodyMd">
                                    <strong>{t.settings.images}:</strong>{' '}
                                    {planDetails.productImages === 'all' ? t.settings.allImages : t.settings.featuredImageOnly}
                                  </Text>
                                  <Text as="p" variant="bodyMd">
                                    <strong>{t.settings.contentTypes}:</strong>
                                  </Text>
                                  <BlockStack gap="100">
                                    {planDetails.contentTypes.map((type) => {
                                      let displayName = type;
                                      let note = "";

                                      if (type === "menus") {
                                        note = ` (${t.settings.readOnly || "read-only"})`;
                                      } else if (type === "metaobjects" || type === "metadata") {
                                        note = ` (${t.settings.comingSoon || "coming soon"})`;
                                      }

                                      return (
                                        <Text key={type} as="p" variant="bodySm" tone="success">
                                          ✓ {displayName}{note}
                                        </Text>
                                      );
                                    })}
                                  </BlockStack>
                                </BlockStack>
                              </BlockStack>

                              <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
                                <Button
                                  variant={isCurrentPlan ? 'secondary' : 'primary'}
                                  disabled={isCurrentPlan || planLoading !== null}
                                  loading={planLoading === id}
                                  onClick={() => handleSelectPlan(id)}
                                  fullWidth
                                >
                                  {isCurrentPlan ? t.settings.currentPlanButton : id === 'free' ? t.settings.downgrade : t.settings.select}
                                </Button>
                              </div>
                            </div>
                          </Card>
                        </div>
                      );
                    })}
                  </div>

                  {/* Usage & Limits */}
                  <SettingsUsageLimitsTab
                    productCount={productCount}
                    localeCount={localeCount}
                    collectionCount={collectionCount}
                    articleCount={articleCount}
                    pageCount={pageCount}
                    themeTranslationCount={themeTranslationCount}
                    t={t}
                    hideUpgradeCard
                  />

                  <Card>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingMd">
                        {t.settings.planNotes}
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        • {t.settings.planNote1}
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        • {t.settings.planNote2}
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        • {t.settings.planNote3}
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        • {t.settings.planNote4}
                      </Text>
                    </BlockStack>
                  </Card>
                </BlockStack>
              )}
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

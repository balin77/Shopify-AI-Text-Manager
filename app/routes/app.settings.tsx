import { useState, useEffect, useCallback } from "react";
import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "react-router";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveMerchantLocale } from "../utils/locale.server";
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { SettingsSetupTab } from "../components/SettingsSetupTab";
import { SettingsAITab } from "../components/SettingsAITab";
import { SettingsSEOTab } from "../components/SettingsSEOTab";
import { SettingsUsageLimitsTab } from "../components/SettingsUsageLimitsTab";
import { SettingsPlanTab } from "../components/SettingsPlanTab";
import { SettingsOtherTab, type OtherSubTab } from "../components/SettingsOtherTab";
import { SettingsProbesTab } from "../components/SettingsProbesTab";
import type { ProbeSubTab } from "../components/SettingsProbesTab";
import type { Plan } from "../utils/planUtils";
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { confirmNavigation } from "../hooks/useSaveBar";
import { sanitizeHTML } from "../utils/sanitizer";
import { AISettingsSchema, AIInstructionsSchema, parseFormData, isValidLocale } from "../utils/validation";
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
import { clampImagesPerRequest } from "~/services/ai/vision-policy.shared";

/**
 * Shallow value-equality for the sparse `seoLimits` JSON blob. Used by the
 * saveSeoSettings action to decide whether a payload would actually change
 * the DB row — so a no-op submission (e.g. a stale reset from a downgraded
 * shop) skips the Pro plan gate instead of spuriously 403-ing.
 */
function shallowEqualLimits(
  a: Record<string, number> | null,
  b: Record<string, number> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {

  try {
    const { admin, session } = await authenticate.admin(request);

    // If returning from billing confirmation, sync subscription with Shopify
    const url = new URL(request.url);
    if (url.searchParams.get('billing') === 'success') {
      logger.info("[SETTINGS] Billing callback detected, syncing subscription", { context: "Settings", shop: session.shop });
      await checkAndSyncSubscription(admin, session.shop);
    }

    // Fetch shop's locales (incl. name for the glossary locale bar) and display name
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopInfo {
          shopLocales {
            locale
            name
            primary
            published
          }
          shop {
            name
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales: Array<{ locale: string; name?: string; primary: boolean; published: boolean }> =
      localesData.data.shopLocales || [];
    const primaryShopLocale = shopLocales.find((l) => l.primary)?.locale || "en";
    const shopDisplayName: string = localesData.data.shop?.name || "";

    let settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });

    if (!settings) {
      // R4-UX1: was a crude binary (en vs. de) on the shop's *storefront*
      // primary locale — a Spanish merchant wrongly got German. Use the
      // shared resolver: merchant admin locale (?locale / Accept-Language)
      // first, shop primary locale only as a weak last resort.
      const autoSelectedLanguage = resolveMerchantLocale(request, primaryShopLocale);

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

    // Theme-translation usage gauge — theme domain only (the System /
    // Online-Store-Extras / Selling-Plans domains share this table but are not
    // governed by the maxThemeTranslations cap shown here).
    const themeTranslationCount = await db.themeTranslation.count({
      where: { shop: session.shop, domain: "theme" },
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
      const sub = await getCurrentSubscription(admin, session.shop);
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
    // Provider IDs (not display names) — the UI needs the id to build the
     // InfoBox `dedupeKey` so it can clear a specific provider's warning
     // when the merchant re-enters that key. Display name is derived at
     // render time.
    const corruptedApiKeys: AIProvider[] = [];
    for (const { field, provider } of keyFields) {
      const { value, corrupted } = decryptApiKeyChecked(settings[field] as string | null | undefined);
      decryptedKeys[field] = value || "";
      if (corrupted) {
        corruptedApiKeys.push(provider);
        logger.error("[SETTINGS LOADER] Decryption error", { context: "Settings", provider });
      }
    }

    const imageManagerSettings = await db.imageManagerSettings.findUnique({
      where: { shopId: session.shop },
    }) ?? { enabled: true, firstImageBig: false, showAltTags: false, autoAltText: false };
    // Image-Manager + SKU tabs configure features that only Pro/Max can use
    // (variantImageManager flag + SKU/key generator listed under Pro+ features).
    // Showing the tabs on Free/Basic let merchants flip toggles that had no
    // effect on their plan — misleading. Gate them on the same flag as the
    // VariantImageManager itself so UI and capability stay in lockstep.
    // The Translations tab (merchant-curated productType mappings) stays open
    // to every plan because it works without the image-manager surface.
    const { canAccessVariantImageManagerInEnv, isProductionLocked } = await import("../utils/planUtils");
    const newFeaturesEnabled = !isProductionLocked();
    const showImageManagerTab = canAccessVariantImageManagerInEnv(
      subscriptionPlan as Plan,
      newFeaturesEnabled,
    );
    const showSkuTab = canAccessVariantImageManagerInEnv(
      subscriptionPlan as Plan,
      newFeaturesEnabled,
    );
    // Dev-only diagnostic surface: only visible when APP_ENV === "development".
    const showTranslationProbeTab = process.env.APP_ENV === "development";
    // PROBE (accessibility plan §3.3): PageSpeed raw-response probe — same
    // dev-only gate as the Translation Probe tab (APP_ENV === "development").
    // Temporary.
    const showPageSpeedProbeTab = showTranslationProbeTab;
    // PLAN_CONTENT_CREATION Phase 0 §5: collection-model probe — same dev-only
    // gate. The route additionally refuses its WRITE test outside
    // APP_ENV=development; a hidden tab is not a permission check.
    const showCollectionProbeTab = showTranslationProbeTab;
    // PLAN_METAOBJECTS_EDITOR Phase 0: metaobject probe (V1-V5, M2) — same
    // dev-only gate, and the route refuses itself outside development too
    // because two of its four steps WRITE to the merchant's live shop.
    const showMetaobjectProbeTab = showTranslationProbeTab;
    // Unit price (Grundpreis): same dev-only gate. It WRITES a measurement to
    // a live variant and restores it, so it is a diagnostic, not a feature.
    const showUnitPriceProbeTab = showTranslationProbeTab;
    const showPublicationProbeTab = showTranslationProbeTab;
    // Product taxonomy: same dev-only gate. READ-only — it asks Shopify's
    // taxonomy what a category picker can be built on — but a diagnostic that
    // fans out introspection queries is not a feature, and the route refuses
    // itself outside development because it takes a direct GET.
    const showTaxonomyProbeTab = showTranslationProbeTab;

    const groupedFieldTranslations = await db.groupedFieldTranslation.findMany({
      where: { shop: session.shop },
      orderBy: [{ fieldKey: "asc" }, { sourceValue: "asc" }, { targetLocale: "asc" }],
    });

    const optionValueMemory = await db.optionValueMemory.findMany({
      where: { shop: session.shop },
      orderBy: { optionValue: "asc" },
    });

    // Metafields tab: run the one-time lazy backfill (so existing shops keep
    // their already-translatable metafields visible), then load the enabled set
    // and last-scan timestamp.
    const { backfillEnabledMetafieldDefinitionsIfNeeded } = await import("../services/metafield-enablement.server");
    await backfillEnabledMetafieldDefinitionsIfNeeded(admin, db, session.shop);
    const enabledMetafieldDefs = await db.enabledMetafieldDefinition.findMany({
      where: { shop: session.shop, ownerType: "PRODUCT" },
      orderBy: [{ namespace: "asc" }, { key: "asc" }],
    });
    const metafieldScanState = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { metafieldsLastScanAt: true },
    });

    // Glossary tab: entries incl. per-locale fixed translations.
    const { listGlossaryEntries } = await import("../../src/services/glossary.service");
    const glossaryEntries = (await listGlossaryEntries(session.shop)).map((e) => ({
      id: e.id,
      sourceTerm: e.sourceTerm,
      doNotTranslate: e.doNotTranslate,
      caseSensitive: e.caseSensitive,
      translations: Object.fromEntries(e.translations.map((tr) => [tr.locale, tr.value])),
    }));

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
      showTranslationProbeTab,
      showCollectionProbeTab,
      showMetaobjectProbeTab,
      showUnitPriceProbeTab,
      showPublicationProbeTab,
      showTaxonomyProbeTab,
      showPageSpeedProbeTab,
      shopifyApiKey: (process.env.SHOPIFY_API_KEY || "").trim(),
      groupedFieldTranslations,
      optionValueMemory,
      primaryShopLocale,
      shopLocales,
      glossaryEntries,
      corruptedApiKeys,
      enabledMetafieldDefinitions: enabledMetafieldDefs.map((d) => ({
        definitionId: d.definitionId,
        namespace: d.namespace,
        key: d.key,
        patchedTranslatable: d.patchedTranslatable,
      })),
      metafieldsLastScanAt: metafieldScanState?.metafieldsLastScanAt
        ? metafieldScanState.metafieldsLastScanAt.toISOString()
        : null,
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

        // Keyword-aware translation (Übersetzungen card).
        keywordAwareTranslation: settings.keywordAwareTranslation ?? true,

        // "Bei Änderung der Hauptsprache" (Übersetzungen card): whether a
        // changed/cleared primary value deletes its foreign translations, and
        // (Max) whether a change made OUTSIDE the app is re-translated instead
        // of only deleted. The Max gate is applied in the tab and again in the
        // action — the stored value is shown as-is so a downgraded shop sees
        // what would happen if it upgraded again.
        translationPurgeOnPrimaryChange: settings.translationPurgeOnPrimaryChange ?? true,
        autoTranslateExternalChanges: settings.autoTranslateExternalChanges ?? false,

        // Nightly SEO audit (Max) — merchant switch, see
        // services/seo/audit-auto-run.service.ts. Shown on every plan but only
        // editable where the plan grants scheduledAudit.
        seoAutoAuditEnabled: settings.seoAutoAuditEnabled ?? true,
        seoAutoCrawlEnabled: settings.seoAutoCrawlEnabled ?? true,

        // SEO title suffix
        seoTitleSuffixEnabled: settings.seoTitleSuffixEnabled ?? false,
        seoTitleSuffix: settings.seoTitleSuffix || '',

        // PLAN §Phase 3.3 — redirect the old URL when a handle changes.
        seoAutoHandleRedirect: settings.seoAutoHandleRedirect ?? true,

        // Merchant-editable SEO character limits (Pro+). null = defaults
        // from character-limits.ts — no need to widen the client bundle with
        // the full default set, the SettingsSEOTab reads them from there.
        seoLimits: (settings.seoLimits ?? null) as Record<string, number> | null,

        // Translation policy: "exact" (default) or "seo_optimized". Piped
        // into AIInstructionsTabs so the radio pre-selects the stored value.
        translationMode: (settings.translationMode === 'seo_optimized' ? 'seo_optimized' : 'exact') as 'exact' | 'seo_optimized',

        // Theme-settings richtext handling: "autofix" | "normalize" | "error"
        themeRichtextMode: settings.themeRichtextMode || 'autofix',

        // May the AI look at the shop's images, and at how many per request?
        // ONE answer for the whole app, edited in AI instructions → General.
        sendImagesToAI: settings.sendImagesToAI ?? false,
        aiImagesPerRequest: clampImagesPerRequest(settings.aiImagesPerRequest),
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
  const { admin, session } = await authenticate.admin(request);
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
        return json({ success: false, error: validationResult.error, fieldErrors: validationResult.fieldErrors, actionType }, { status: 400 });
      }

      const data = validationResult.data;

      // PLAN GATE FIRST — before anything is written. The Translations
      // sub-section saves its switches together with the instruction texts, so
      // a 403 decided after the AIInstructions upsert would leave a
      // half-applied save that keeps failing on every retry.
      // Same "would it change anything" rule as the SEO limits: a payload that
      // matches the stored value is a no-op and must not 403 (a downgraded
      // shop re-submits its stored `true` on every save of this tab).
      const rawAutoTranslate = formData.get("autoTranslateExternalChanges");
      let autoTranslateUpdate: { autoTranslateExternalChanges: boolean } | Record<string, never> = {};
      if (rawAutoTranslate !== null) {
        const requested = rawAutoTranslate === "true";
        const row = await db.aISettings.findUnique({
          where: { shop: session.shop },
          select: { subscriptionPlan: true, autoTranslateExternalChanges: true },
        });
        if ((row?.autoTranslateExternalChanges ?? false) !== requested) {
          const { meetsPlan } = await import("../utils/planUtils");
          const { AUTO_TRANSLATE_MIN_PLAN } = await import(
            "../services/translations/translation-change-policy.shared"
          );
          const plan = (row?.subscriptionPlan || "free") as Plan;
          if (!meetsPlan(plan, AUTO_TRANSLATE_MIN_PLAN)) {
            return json(
              {
                success: false,
                error: "Automatic re-translation of external changes is available on the Max plan.",
                actionType,
              },
              { status: 403 },
            );
          }
          autoTranslateUpdate = { autoTranslateExternalChanges: requested };
        }
      }

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

      // Translation mode ("exact" | "seo_optimized") is stored on AISettings
      // and piggybacks on the same submit so the Translations sub-section has
      // a single Save button covering the radio + custom instructions.
      // Keyword-aware translation rides along on the same submit, for the same
      // reason: it is a knob of the Translations sub-section, and that section
      // has one Save button. Absent (a submit from another sub-section) leaves
      // the stored value alone rather than defaulting it back on.
      const rawMode = String(formData.get("translationMode") || "");
      const rawKeywordAware = formData.get("keywordAwareTranslation");
      const keywordAwareUpdate =
        rawKeywordAware === null ? {} : { keywordAwareTranslation: rawKeywordAware === "true" };
      const modeUpdate =
        rawMode === "exact" || rawMode === "seo_optimized" ? { translationMode: rawMode } : {};

      // "Bei Änderung der Hauptsprache" — same absent-means-unchanged rule.
      const rawPurge = formData.get("translationPurgeOnPrimaryChange");
      const purgeUpdate =
        rawPurge === null ? {} : { translationPurgeOnPrimaryChange: rawPurge === "true" };


      // (The Max gate for autoTranslateExternalChanges already ran above, so
      // `autoTranslateUpdate` is either the entitled change or empty.)
      const translationSettingsUpdate = {
        ...modeUpdate,
        ...keywordAwareUpdate,
        ...purgeUpdate,
        ...autoTranslateUpdate,
      };
      if (Object.keys(translationSettingsUpdate).length > 0) {
        await db.aISettings.upsert({
          where: { shop: session.shop },
          update: translationSettingsUpdate,
          create: {
            shop: session.shop,
            ...translationSettingsUpdate,
            preferredProvider: "claude",
          },
        });
      }

      return json({ success: true, actionType });
    } else if (actionType === "saveAiVision") {
      /**
       * May the AI look at the shop's images, and at how many per request.
       *
       * Its OWN action rather than a rider on `saveInstructions`, for two
       * reasons. Free and Basic see the instructions card read-only — it holds
       * the default instructions on those plans — and this switch has to stay
       * reachable there, because it was a checkbox in the content editor's
       * toolbar on every plan before it moved here. And `saveInstructions`
       * writes `data.<field> || null` for every instruction it knows: a save
       * that carried only these two fields would blank the lot.
       *
       * Present-or-absent per field, and the count goes through the same clamp
       * the Select is built from — this action takes a direct POST, so a
       * stored 500 would be 500 images on every generation.
       */
      const rawSendImages = formData.get("sendImagesToAI");
      const rawImagesPerRequest = formData.get("aiImagesPerRequest");
      const visionUpdate = {
        ...(rawSendImages === null ? {} : { sendImagesToAI: rawSendImages === "true" }),
        ...(rawImagesPerRequest === null
          ? {}
          : { aiImagesPerRequest: clampImagesPerRequest(Number(rawImagesPerRequest)) }),
      };
      if (Object.keys(visionUpdate).length === 0) {
        return json({ success: true, actionType });
      }

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: visionUpdate,
        create: { shop: session.shop, ...visionUpdate, preferredProvider: "claude" },
      });

      return json({ success: true, actionType });
    } else if (actionType === "saveAppLanguage") {
      // Narrow update: only touch `appLanguage`. The legacy LanguageTab used to
      // resend every other AI setting from the (decrypted) loader payload,
      // which had two failure modes:
      //   - fields not in the payload (selectedModel, SEO suffix) got wiped.
      //   - any out-of-format stored key would re-fail the full-form Zod check
      //     and block changing the language.
      const appLanguage = String(formData.get("appLanguage") || "");
      if (!["de", "en", "es"].includes(appLanguage)) {
        return json({ success: false, error: "Invalid language", fieldErrors: { appLanguage: "Invalid language" }, actionType }, { status: 400 });
      }

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: { appLanguage },
        create: { shop: session.shop, appLanguage, preferredProvider: "claude" },
      });

      return json({ success: true, actionType });
    } else if (actionType === "saveSeoSettings") {
      const enabled = formData.get("seoTitleSuffixEnabled") === "true";
      // Nightly audit switch. Only written when the field is present, so a
      // client that does not know the field cannot reset it. Gated below,
      // next to the seoLimits gate, on the same "would it change anything"
      // rule — a no-op payload from an unentitled shop must not 403.
      const rawAutoAudit = formData.get("seoAutoAuditEnabled");
      const autoAuditRequested = rawAutoAudit === null ? undefined : rawAutoAudit === "true";
      // Weekly crawl switch — same present-or-absent rule as the audit one.
      const rawAutoCrawl = formData.get("seoAutoCrawlEnabled");
      const autoCrawlRequested = rawAutoCrawl === null ? undefined : rawAutoCrawl === "true";
      const suffix = String(formData.get("seoTitleSuffix") || "").slice(0, 60) || null;

      // PLAN §Phase 3.3 — auto-redirect on handle change. Read as
      // present-or-absent, NOT as `=== "true"` on a possibly-missing field:
      // this setting defaults to ON, so a payload that simply does not carry
      // it (an older client, another caller of this action) would otherwise
      // switch it off without anyone asking.
      const rawAutoRedirect = formData.get("seoAutoHandleRedirect");
      const autoRedirectUpdate =
        rawAutoRedirect === null ? undefined : String(rawAutoRedirect) === "true";

      // Merchant-editable SEO character limits (Pro+). Parse first, then
      // decide whether the plan gate needs to fire — a payload that would
      // NOT change the stored value (e.g. a stale "{}" reset from a
      // downgraded shop whose DB row is already null) is a no-op regardless
      // of plan, so it must not 403. The gate stays authoritative for any
      // payload that would actually write to the seoLimits column.
      const rawLimits = String(formData.get("seoLimits") || "");
      let seoLimitsUpdate: Record<string, number> | null | undefined = undefined;
      if (rawLimits) {
        let cleaned: Record<string, number> = {};
        try {
          const parsed = JSON.parse(rawLimits);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const allowedKeys = new Set([
              "titleMin", "titleMax", "seoTitleMin", "seoTitleMax",
              "metaDescMin", "metaDescMax", "descriptionMin",
              "handleMin", "handleMax", "altTextMin", "altTextMax",
            ]);
            for (const [k, v] of Object.entries(parsed)) {
              if (!allowedKeys.has(k)) continue;
              const n = typeof v === "number" ? v : parseInt(String(v), 10);
              if (Number.isFinite(n) && n > 0 && n <= 9999) {
                cleaned[k] = Math.floor(n);
              }
            }
          }
        } catch {
          return json({ success: false, error: "Invalid seoLimits payload", actionType }, { status: 400 });
        }
        // Empty object → intentional reset to defaults (write null).
        const proposed: Record<string, number> | null =
          Object.keys(cleaned).length > 0 ? cleaned : null;

        // Compare to the current DB row — if the write would be a no-op,
        // skip both the plan gate AND the update. Prevents a spurious 403
        // when a downgraded shop's client re-submits stale limits.
        const currentRow = await db.aISettings.findUnique({
          where: { shop: session.shop },
          select: { subscriptionPlan: true, seoLimits: true },
        });
        const currentLimits = (currentRow?.seoLimits ?? null) as Record<string, number> | null;
        const wouldChange = !shallowEqualLimits(currentLimits, proposed);

        if (wouldChange) {
          const { meetsPlan } = await import("../utils/planUtils");
          const plan = (currentRow?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
          if (!meetsPlan(plan, "pro")) {
            return json(
              { success: false, error: "SEO limits are editable from the Pro plan onwards.", actionType },
              { status: 403 },
            );
          }
          seoLimitsUpdate = proposed;
        }
      }

      let autoAuditUpdate: boolean | undefined = undefined;
      if (autoAuditRequested !== undefined) {
        const row = await db.aISettings.findUnique({
          where: { shop: session.shop },
          select: { subscriptionPlan: true, seoAutoAuditEnabled: true },
        });
        const current = row?.seoAutoAuditEnabled ?? true;
        if (current !== autoAuditRequested) {
          const { canAccessSeoFeature } = await import("../utils/planUtils");
          const plan = (row?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
          if (!canAccessSeoFeature(plan, "scheduledAudit")) {
            return json(
              {
                success: false,
                error: "The nightly SEO audit is available on the Max plan.",
                actionType,
              },
              { status: 403 },
            );
          }
          autoAuditUpdate = autoAuditRequested;
        }
      }

      let autoCrawlUpdate: boolean | undefined = undefined;
      if (autoCrawlRequested !== undefined) {
        const row = await db.aISettings.findUnique({
          where: { shop: session.shop },
          select: { subscriptionPlan: true, seoAutoCrawlEnabled: true },
        });
        const current = row?.seoAutoCrawlEnabled ?? true;
        if (current !== autoCrawlRequested) {
          const { canAccessSeoFeature } = await import("../utils/planUtils");
          const plan = (row?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
          if (!canAccessSeoFeature(plan, "scheduledCrawl")) {
            return json(
              {
                success: false,
                error: "The weekly storefront crawl is available on the Max plan.",
                actionType,
              },
              { status: 403 },
            );
          }
          autoCrawlUpdate = autoCrawlRequested;
        }
      }

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: {
          seoTitleSuffixEnabled: enabled,
          seoTitleSuffix: suffix,
          ...(autoRedirectUpdate !== undefined ? { seoAutoHandleRedirect: autoRedirectUpdate } : {}),
          ...(seoLimitsUpdate !== undefined ? { seoLimits: seoLimitsUpdate as any } : {}),
          ...(autoAuditUpdate !== undefined ? { seoAutoAuditEnabled: autoAuditUpdate } : {}),
          ...(autoCrawlUpdate !== undefined ? { seoAutoCrawlEnabled: autoCrawlUpdate } : {}),
        },
        create: {
          shop: session.shop,
          seoTitleSuffixEnabled: enabled,
          seoTitleSuffix: suffix,
          ...(autoRedirectUpdate !== undefined ? { seoAutoHandleRedirect: autoRedirectUpdate } : {}),
          ...(seoLimitsUpdate !== undefined ? { seoLimits: seoLimitsUpdate as any } : {}),
          ...(autoAuditUpdate !== undefined ? { seoAutoAuditEnabled: autoAuditUpdate } : {}),
          ...(autoCrawlUpdate !== undefined ? { seoAutoCrawlEnabled: autoCrawlUpdate } : {}),
        },
      });

      return json({ success: true, actionType });
    } else if (actionType === "saveRichtextMode") {
      const mode = String(formData.get("themeRichtextMode") || "");
      if (!["autofix", "normalize", "error"].includes(mode)) {
        return json({ success: false, error: "Invalid richtext mode", actionType }, { status: 400 });
      }

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: { themeRichtextMode: mode },
        create: { shop: session.shop, themeRichtextMode: mode, preferredProvider: "claude" },
      });

      return json({ success: true, actionType });
    } else if (actionType === "saveGlossary") {
      // Glossary is NOT plan-gated (translation itself is ungated — keep
      // consistent). Full entry set as JSON; server diff-upserts transactional.
      const payload = getFormString(formData, "entries");
      const sourceLocale = getFormString(formData, "sourceLocale") || "en";
      if (!isValidLocale(sourceLocale)) {
        return json({ success: false, error: "Invalid source locale", actionType }, { status: 400 });
      }
      let incoming: Array<{
        id?: string;
        sourceTerm: string;
        doNotTranslate?: boolean;
        caseSensitive?: boolean;
        translations?: Record<string, string>;
      }> = [];
      try {
        incoming = payload ? JSON.parse(payload) : [];
        if (!Array.isArray(incoming)) throw new Error("not an array");
      } catch {
        return json({ success: false, error: "Invalid glossary payload", actionType }, { status: 400 });
      }

      const { saveGlossaryEntries } = await import("../../src/services/glossary.service");
      try {
        const result = await saveGlossaryEntries(
          session.shop,
          sourceLocale,
          incoming.map((e) => ({
            id: e.id || undefined,
            sourceTerm: String(e.sourceTerm ?? ""),
            doNotTranslate: !!e.doNotTranslate,
            caseSensitive: !!e.caseSensitive,
            translations: e.translations && typeof e.translations === "object" ? e.translations : {},
          })),
        );
        return json({ success: true, actionType, ...result });
      } catch (err) {
        // saveGlossaryEntries throws with a merchant-readable message on
        // validation errors (forbidden chars, duplicates, entry limit).
        const message = err instanceof Error ? err.message : "Could not save glossary";
        return json({ success: false, error: message, actionType }, { status: 400 });
      }
    } else if (actionType === "importGlossary") {
      const csv = getFormString(formData, "csv") || "";
      const sourceLocale = getFormString(formData, "sourceLocale") || "en";
      if (!isValidLocale(sourceLocale)) {
        return json({ success: false, error: "Invalid source locale", actionType }, { status: 400 });
      }
      const { parseGlossaryCsv, importGlossaryEntries } = await import("../../src/services/glossary.service");
      const parsed = parseGlossaryCsv(csv);
      if (parsed.entries.length === 0) {
        return json(
          {
            success: false,
            actionType,
            error: parsed.errors.length > 0 ? parsed.errors.slice(0, 5).join(" ") : "No valid rows found in CSV.",
          },
          { status: 400 },
        );
      }
      try {
        const imported = await importGlossaryEntries(session.shop, sourceLocale, parsed.entries);
        return json({ success: true, actionType, imported, skipped: parsed.errors.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not import glossary";
        return json({ success: false, error: message, actionType }, { status: 400 });
      }
    } else if (actionType === "scanProductMetafieldDefinitions") {
      // Data-driven scan: sources from the actual product metafields (incl.
      // third-party / definition-less ones like Google & Judge.me), enriched
      // with definitions and per-key translatability probes. Records timestamp.
      const { scanProductMetafields } = await import("../services/metafield-enablement.server");
      const definitions = await scanProductMetafields(admin, db, session.shop);
      const scannedAt = new Date();
      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: { metafieldsLastScanAt: scannedAt },
        create: { shop: session.shop, metafieldsLastScanAt: scannedAt, preferredProvider: "claude" },
      });
      return json({ success: true, actionType, definitions, metafieldsLastScanAt: scannedAt.toISOString() });
    } else if (actionType === "saveEnabledMetafieldDefinitions") {
      // Persist the merchant's selection. Per item, the server picks the right
      // action: already translatable → just persist; shop-owned with a
      // definition → set storefront access PUBLIC_READ; shop-owned WITHOUT a
      // definition → create a public definition; third-party + not translatable
      // → reject (the UI also blocks these). Successful selections fully replace
      // the prior set for the shop.
      //
      // Note: the Shopify-side change (access patch / definition create) is a
      // non-transactional side effect applied BEFORE the DB transaction. This is
      // deliberate and tolerable — it is idempotent (a re-save of an
      // already-translatable field does nothing) and we never revert it
      // (reverting would break the storefront/other tools), so a crash mid-loop
      // is self-healing.
      const payload = getFormString(formData, "definitions");
      let incoming: Array<{
        id: string;
        namespace: string;
        key: string;
        type?: string;
        name?: string;
        translatable?: boolean;
        hasDefinition?: boolean;
        ownerCategory?: string;
      }> = [];
      try {
        incoming = payload ? JSON.parse(payload) : [];
      } catch {
        return json({ success: false, error: "Invalid definitions payload", actionType }, { status: 400 });
      }

      const { ContentService } = await import("../services/content.service");
      const service = new ContentService(admin);

      // Preserve the patchedTranslatable history across the destructive
      // delete+reinsert below: once we have made a field translatable, a later
      // scan reports translatable:true — we must not regress the flag to false.
      const priorRows = await db.enabledMetafieldDefinition.findMany({
        where: { shop: session.shop, ownerType: "PRODUCT" },
        select: { definitionId: true, patchedTranslatable: true },
      });
      const priorPatched = new Map(priorRows.map((r) => [r.definitionId, r.patchedTranslatable]));

      const toInsert: Array<{ shop: string; definitionId: string; namespace: string; key: string; ownerType: string; patchedTranslatable: boolean }> = [];
      const failed: Array<{ namespace: string; key: string; error?: string }> = [];

      for (const def of incoming) {
        if (!def?.id || !def.namespace || !def.key) continue;
        const isThirdParty = def.ownerCategory === "third-party";
        let patched = false;

        if (def.translatable) {
          // Already translatable (incl. app-owned like Judge.me) — nothing to
          // change on Shopify, just record it so the editor shows it.
        } else if (isThirdParty) {
          // Not translatable AND app-owned — we cannot patch/create here.
          failed.push({ namespace: def.namespace, key: def.key, error: "App-owned metafield cannot be made translatable" });
          continue;
        } else if (def.hasDefinition) {
          const res = await service.updateMetafieldDefinitionTranslatable(def.namespace, def.key);
          if (!res.ok) {
            failed.push({ namespace: def.namespace, key: def.key, error: res.error });
            continue;
          }
          patched = true;
        } else {
          // Shop-owned but definition-less → create a public definition.
          const res = await service.createTranslatableMetafieldDefinition(
            def.namespace,
            def.key,
            def.type || "single_line_text_field",
            def.name || def.key,
          );
          if (!res.ok) {
            failed.push({ namespace: def.namespace, key: def.key, error: res.error });
            continue;
          }
          patched = true;
        }

        toInsert.push({
          shop: session.shop,
          definitionId: def.id,
          namespace: def.namespace,
          key: def.key,
          ownerType: "PRODUCT",
          patchedTranslatable: patched || (priorPatched.get(def.id) ?? false),
        });
      }

      await db.$transaction(async (tx) => {
        await tx.enabledMetafieldDefinition.deleteMany({ where: { shop: session.shop, ownerType: "PRODUCT" } });
        if (toInsert.length > 0) {
          await tx.enabledMetafieldDefinition.createMany({ data: toInsert });
        }
      });

      return json({ success: true, actionType, enabledCount: toInsert.length, failed });
    } else {
      // Validate and save AI settings
      const validationResult = parseFormData(formData, AISettingsSchema);

      if (!validationResult.success) {
        return json({ success: false, error: validationResult.error, fieldErrors: validationResult.fieldErrors, actionType }, { status: 400 });
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

      return json({ success: true, actionType });
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
  const { shop, shopDisplayName, settings, instructions, productCount, translationCount, webhookCount, collectionCount, articleCount, pageCount, themeTranslationCount, imageOperationCount, localeCount, subscriptionPlan, inTrial, trialRemainingDays, isTestStore, devPlanMode, imageManagerSettings, showImageManagerTab, showSkuTab, showTranslationProbeTab, showPageSpeedProbeTab, showCollectionProbeTab, showMetaobjectProbeTab, showUnitPriceProbeTab, showPublicationProbeTab, showTaxonomyProbeTab, shopifyApiKey, groupedFieldTranslations, optionValueMemory, primaryShopLocale, shopLocales = [], glossaryEntries = [], corruptedApiKeys = [], enabledMetafieldDefinitions = [], metafieldsLastScanAt = null } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const { registerItems, clearItems } = useItemSelector();
  const isFreePlan = subscriptionPlan === "free";
  const isBasicPlan = subscriptionPlan === "basic";
  const aiInstructionsReadOnly = isFreePlan || isBasicPlan;

  // Get initial tab from URL parameter (e.g., ?tab=plan).
  // Billing callbacks always land on the plan tab so the merchant sees the result.
  type Section = "setup" | "ai" | "instructions" | "other" | "seo" | "plan" | "probes";

  // The three dev-only probes share ONE tab with a sub-tab strip. Their gates
  // stay per probe (unchanged), so the tab itself exists iff any of them is on.
  const showProbesTab =
    showTranslationProbeTab ||
    showPageSpeedProbeTab ||
    showCollectionProbeTab ||
    showMetaobjectProbeTab ||
    showUnitPriceProbeTab ||
    showPublicationProbeTab ||
    showTaxonomyProbeTab;

  const getInitialSection = (): Section => {
    if (searchParams.get("billing")) return "plan";
    const tabParam = searchParams.get("tab");
    // Legacy deep-links keep working: language/glossary/feedback landed inside
    // the Setup / AI-Instructions tabs; translations/sku/metafields/richtext/
    // recurring/imagemanager all now live inside the "Weiteres" (other) tab.
    if (tabParam === "language" || tabParam === "feedback") return "setup";
    if (tabParam === "glossary") return "instructions";
    if (
      tabParam === "translations" ||
      tabParam === "sku" ||
      tabParam === "recurring" ||
      tabParam === "metafields" ||
      tabParam === "richtext" ||
      tabParam === "imagemanager"
    ) return "other";
    // Legacy probe deep-links keep working: each one now opens the shared
    // "Probes" tab on its own sub-tab. A probe whose own gate is closed still
    // falls back to setup — the group gate must not re-open an individual one.
    if (tabParam === "translationprobe") return showTranslationProbeTab ? "probes" : "setup";
    if (tabParam === "pagespeedprobe") return showPageSpeedProbeTab ? "probes" : "setup";
    if (tabParam === "collectionprobe") return showCollectionProbeTab ? "probes" : "setup";
    if (tabParam === "metaobjectprobe") return showMetaobjectProbeTab ? "probes" : "setup";
    if (tabParam === "unitpriceprobe") return showUnitPriceProbeTab ? "probes" : "setup";
    if (tabParam === "publicationprobe") return showPublicationProbeTab ? "probes" : "setup";
    if (tabParam === "taxonomyprobe") return showTaxonomyProbeTab ? "probes" : "setup";
    if (tabParam === "probes") return showProbesTab ? "probes" : "setup";
    if (tabParam && ["setup", "ai", "instructions", "other", "seo", "plan"].includes(tabParam)) {
      return tabParam as Section;
    }
    return "setup";
  };

  // Deep-link target inside the "Probes" tab (undefined ⇒ the tab picks its
  // own first available sub-tab).
  const getInitialProbeSubTab = (): ProbeSubTab | undefined => {
    const tabParam = searchParams.get("tab");
    if (tabParam === "translationprobe" && showTranslationProbeTab) return "translationprobe";
    if (tabParam === "pagespeedprobe" && showPageSpeedProbeTab) return "pagespeedprobe";
    if (tabParam === "collectionprobe" && showCollectionProbeTab) return "collectionprobe";
    if (tabParam === "metaobjectprobe" && showMetaobjectProbeTab) return "metaobjectprobe";
    if (tabParam === "unitpriceprobe" && showUnitPriceProbeTab) return "unitpriceprobe";
    if (tabParam === "publicationprobe" && showPublicationProbeTab) return "publicationprobe";
    if (tabParam === "taxonomyprobe" && showTaxonomyProbeTab) return "taxonomyprobe";
    return undefined;
  };

  // Deep-link target inside the "Weiteres" tab. imagemanager only makes sense
  // when the merchant's plan actually shows the sub-tab; fall back to
  // metafields otherwise so the tab does not open on a blank panel.
  const getInitialOtherSubTab = (): OtherSubTab | undefined => {
    const tabParam = searchParams.get("tab");
    if (tabParam === "metafields") return "metafields";
    if (tabParam === "richtext") return "richtext";
    if (tabParam === "recurring" || tabParam === "translations" || tabParam === "sku") return "recurring";
    if (tabParam === "imagemanager") return showImageManagerTab ? "imagemanager" : "metafields";
    return undefined;
  };

  const [selectedSection, setSelectedSection] = useState<Section>(getInitialSection);
  const [initialOtherSubTab] = useState<OtherSubTab | undefined>(getInitialOtherSubTab);
  const [initialProbeSubTab] = useState<ProbeSubTab | undefined>(getInitialProbeSubTab);
  const [hasAIChanges, setHasAIChanges] = useState(false);
  const [hasLanguageChanges, setHasLanguageChanges] = useState(false);
  const [hasInstructionsChanges, setHasInstructionsChanges] = useState(false);
  const [hasImageManagerChanges, setHasImageManagerChanges] = useState(false);
  const [hasMetafieldChanges, setHasMetafieldChanges] = useState(false);
  const [hasGlossaryChanges, setHasGlossaryChanges] = useState(false);
  // Check if there are any unsaved changes across tabs
  const hasUnsavedChanges = hasAIChanges || hasLanguageChanges || hasInstructionsChanges || hasImageManagerChanges || hasMetafieldChanges || hasGlossaryChanges;

  // Handle section navigation — native save bar shows a confirm dialog when
  // there are unsaved changes. Resolves only if the merchant confirms leaving.
  const handleSectionChange = async (newSection: Section) => {
    await confirmNavigation();
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
  // re-enter and save it. One warning per provider, each tagged with a
  // dedupeKey so SettingsAITab can dismiss only the provider the merchant
  // is currently retyping (instead of all of them at once).
  useEffect(() => {
    if (corruptedApiKeys.length === 0) return;
    const template =
      t.settings?.corruptedApiKeyWarning ||
      "The stored API key for {provider} could not be decrypted and was cleared. Please re-enter it and save.";
    const title = t.settings?.corruptedApiKeyTitle || "API key error";
    for (const provider of corruptedApiKeys) {
      showInfoBox(
        template.replace("{provider}", getProviderDisplayName(provider as AIProvider)),
        "critical",
        title,
        undefined,
        `corrupted-api-key:${provider}`,
      );
    }
  }, [corruptedApiKeys, showInfoBox, t]);

  // Register settings sections in item selector context (for mobile header dropdown)
  useEffect(() => {
    const sections = [
      { id: "setup", title: t.settings.appSetup },
      { id: "ai", title: t.settings.aiApiAccess },
      { id: "instructions", title: t.settings.aiInstructions },
      { id: "seo", title: t.settings.seoSettings || "SEO" },
      { id: "other", title: t.settings.otherSettings || "Weiteres" },
      { id: "plan", title: t.settings.plan },
      ...(showProbesTab ? [{ id: "probes", title: "Probes" }] : []),
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
      {/* Page padding is owned globally by .Polaris-Page (responsive.css,
          --app-page-padding); .app-page-content zeroes Polaris' own
          Page__Content inset so the gutter is even on all sides (incl. top
          and bottom), matching the content page.

          .app-page-width-full is explicit, not the absence of a cap: this is a
          sidebar+content layout, not reading-width content, so it keeps the
          full width the SEO sections and Tasks give up. */}
      <div className="app-page-content app-page-width-full">
        <div style={{ display: "flex", gap: "1rem" }}>
          {/* Left Sidebar - Hidden on mobile. Width from
              --app-list-column-width: the tab nav is a "pick an item" column
              like the content pages' item list, and now matches it. */}
          <div className="settings-desktop-nav" style={{ width: "var(--app-list-column-width)", flexShrink: 0 }}>
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
                onClick={() => handleSectionChange("other")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "other" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "other" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "other" ? "semibold" : "regular"}>
                  {t.settings.otherSettings || "Weiteres"}
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
              {showProbesTab && (
              <button
                onClick={() => handleSectionChange("probes")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "probes" ? "#f1f8f5" : "white",
                  borderTop: "1px solid #e1e3e5",
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: selectedSection === "probes" ? "3px solid #008060" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight={selectedSection === "probes" ? "semibold" : "regular"}>
                  Probes
                </Text>
              </button>
              )}
            </Card>
          </div>

          {/* Main Content */}
          <div style={{ flex: 1 }}>
            <BlockStack gap="400">
              {/* App Setup Section */}
              {selectedSection === "setup" && (
                <SettingsSetupTab
                  shop={shop}
                  shopifyApiKey={shopifyApiKey}
                  subscriptionPlan={subscriptionPlan as Plan}
                  productCount={productCount}
                  collectionCount={collectionCount}
                  articleCount={articleCount}
                  translationCount={translationCount}
                  webhookCount={webhookCount}
                  t={t}
                  languageSettings={settings}
                  languageFetcher={fetcher}
                  onLanguageHasChangesChange={setHasLanguageChanges}
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
                    glossaryEntries={glossaryEntries}
                    shopLocales={shopLocales}
                    primaryShopLocale={primaryShopLocale}
                    onGlossaryHasChangesChange={setHasGlossaryChanges}
                    translationMode={settings.translationMode}
                    keywordAwareTranslation={settings.keywordAwareTranslation}
                    translationPurgeOnPrimaryChange={settings.translationPurgeOnPrimaryChange}
                    autoTranslateExternalChanges={settings.autoTranslateExternalChanges}
                    subscriptionPlan={subscriptionPlan as Plan}
                    sendImagesToAI={settings.sendImagesToAI}
                    aiImagesPerRequest={settings.aiImagesPerRequest}
                  />
                </>
              )}

              {/* SEO Settings */}
              {selectedSection === "seo" && (
                <SettingsSEOTab
                  settings={settings}
                  fetcher={fetcher}
                  t={t}
                  shopDisplayName={shopDisplayName}
                  subscriptionPlan={subscriptionPlan as Plan}
                  onHasChangesChange={setHasAIChanges}
                />
              )}

              {/* Weiteres — horizontal sub-nav bundling Metafields,
                  Rich-text formatting, Wiederkehrende Werte + (Pro) Image Manager */}
              {selectedSection === "other" && (
                <SettingsOtherTab
                  t={t}
                  fetcher={fetcher}
                  initialSubTab={initialOtherSubTab}
                  enabledMetafieldDefinitions={enabledMetafieldDefinitions}
                  metafieldsLastScanAt={metafieldsLastScanAt}
                  onMetafieldHasChangesChange={setHasMetafieldChanges}
                  richtextSettings={settings}
                  onRichtextHasChangesChange={setHasAIChanges}
                  groupedFieldTranslations={groupedFieldTranslations}
                  optionValueMemory={optionValueMemory}
                  primaryShopLocale={primaryShopLocale}
                  showSkuTab={showSkuTab}
                  showImageManagerTab={showImageManagerTab}
                  imageManagerSettings={imageManagerSettings ?? { enabled: true, autoAltText: false }}
                  shop={shop}
                  onImageManagerHasChangesChange={setHasImageManagerChanges}
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

              {/* Dev-only diagnostic probes — one tab, one sub-tab per probe,
                  each still behind its own gate (see SettingsProbesTab). */}
              {selectedSection === "probes" && showProbesTab && (
                <SettingsProbesTab
                  showTranslationProbe={showTranslationProbeTab}
                  showPageSpeedProbe={showPageSpeedProbeTab}
                  showCollectionProbe={showCollectionProbeTab}
                  showMetaobjectProbe={showMetaobjectProbeTab}
                  showUnitPriceProbe={showUnitPriceProbeTab}
                  showPublicationProbe={showPublicationProbeTab}
                  showTaxonomyProbe={showTaxonomyProbeTab}
                  initialSubTab={initialProbeSubTab}
                />
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

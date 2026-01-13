import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  Banner,
  Select,
  InlineStack,
  ButtonGroup,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";
import { sanitizeFormatExample } from "../utils/sanitizer";
import { AISettingsSchema, AIInstructionsSchema, parseFormData } from "../utils/validation";
import { toSafeErrorResponse } from "../utils/error-handler";
import { getDefaultInstructions, type EntityType } from "../constants/aiInstructionsDefaults";

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

  return json({
    shop: session.shop,
    productCount,
    translationCount,
    webhookCount,
    collectionCount,
    articleCount,
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
      productTitleFormat: instructions.productTitleFormat || "",
      productTitleInstructions: instructions.productTitleInstructions || "",
      productDescriptionFormat: instructions.productDescriptionFormat || "",
      productDescriptionInstructions: instructions.productDescriptionInstructions || "",
      productHandleFormat: instructions.productHandleFormat || "",
      productHandleInstructions: instructions.productHandleInstructions || "",
      productSeoTitleFormat: instructions.productSeoTitleFormat || "",
      productSeoTitleInstructions: instructions.productSeoTitleInstructions || "",
      productMetaDescFormat: instructions.productMetaDescFormat || "",
      productMetaDescInstructions: instructions.productMetaDescInstructions || "",
      productAltTextFormat: instructions.productAltTextFormat || "",
      productAltTextInstructions: instructions.productAltTextInstructions || "",

      // Collections
      collectionTitleFormat: instructions.collectionTitleFormat || "",
      collectionTitleInstructions: instructions.collectionTitleInstructions || "",
      collectionDescriptionFormat: instructions.collectionDescriptionFormat || "",
      collectionDescriptionInstructions: instructions.collectionDescriptionInstructions || "",
      collectionHandleFormat: instructions.collectionHandleFormat || "",
      collectionHandleInstructions: instructions.collectionHandleInstructions || "",
      collectionSeoTitleFormat: instructions.collectionSeoTitleFormat || "",
      collectionSeoTitleInstructions: instructions.collectionSeoTitleInstructions || "",
      collectionMetaDescFormat: instructions.collectionMetaDescFormat || "",
      collectionMetaDescInstructions: instructions.collectionMetaDescInstructions || "",

      // Blogs
      blogTitleFormat: instructions.blogTitleFormat || "",
      blogTitleInstructions: instructions.blogTitleInstructions || "",
      blogDescriptionFormat: instructions.blogDescriptionFormat || "",
      blogDescriptionInstructions: instructions.blogDescriptionInstructions || "",
      blogHandleFormat: instructions.blogHandleFormat || "",
      blogHandleInstructions: instructions.blogHandleInstructions || "",
      blogSeoTitleFormat: instructions.blogSeoTitleFormat || "",
      blogSeoTitleInstructions: instructions.blogSeoTitleInstructions || "",
      blogMetaDescFormat: instructions.blogMetaDescFormat || "",
      blogMetaDescInstructions: instructions.blogMetaDescInstructions || "",

      // Pages
      pageTitleFormat: instructions.pageTitleFormat || "",
      pageTitleInstructions: instructions.pageTitleInstructions || "",
      pageDescriptionFormat: instructions.pageDescriptionFormat || "",
      pageDescriptionInstructions: instructions.pageDescriptionInstructions || "",
      pageHandleFormat: instructions.pageHandleFormat || "",
      pageHandleInstructions: instructions.pageHandleInstructions || "",
      pageSeoTitleFormat: instructions.pageSeoTitleFormat || "",
      pageSeoTitleInstructions: instructions.pageSeoTitleInstructions || "",
      pageMetaDescFormat: instructions.pageMetaDescFormat || "",
      pageMetaDescInstructions: instructions.pageMetaDescInstructions || "",

      // Policies (description only)
      policyDescriptionFormat: instructions.policyDescriptionFormat || "",
      policyDescriptionInstructions: instructions.policyDescriptionInstructions || "",
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
  const { shop, settings, instructions, productCount, translationCount, webhookCount, collectionCount, articleCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const navigate = useNavigate();

  const AI_PROVIDERS = [
    { label: t.settings.providers.huggingface, value: "huggingface" },
    { label: t.settings.providers.gemini, value: "gemini" },
    { label: t.settings.providers.claude, value: "claude" },
    { label: t.settings.providers.openai, value: "openai" },
    { label: t.settings.providers.grok, value: "grok" },
    { label: t.settings.providers.deepseek, value: "deepseek" },
  ];

  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
  ];

  const [selectedSection, setSelectedSection] = useState<"setup" | "ai" | "instructions" | "language">("setup");
  const [huggingfaceKey, setHuggingfaceKey] = useState(settings.huggingfaceApiKey);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [claudeKey, setClaudeKey] = useState(settings.claudeApiKey);
  const [openaiKey, setOpenaiKey] = useState(settings.openaiApiKey);
  const [provider, setProvider] = useState(settings.preferredProvider);
  const [appLanguage, setAppLanguage] = useState(settings.appLanguage);

  // Rate limit states
  const [hfMaxTokensPerMinute, setHfMaxTokensPerMinute] = useState(String(settings.hfMaxTokensPerMinute));
  const [hfMaxRequestsPerMinute, setHfMaxRequestsPerMinute] = useState(String(settings.hfMaxRequestsPerMinute));
  const [geminiMaxTokensPerMinute, setGeminiMaxTokensPerMinute] = useState(String(settings.geminiMaxTokensPerMinute));
  const [geminiMaxRequestsPerMinute, setGeminiMaxRequestsPerMinute] = useState(String(settings.geminiMaxRequestsPerMinute));
  const [claudeMaxTokensPerMinute, setClaudeMaxTokensPerMinute] = useState(String(settings.claudeMaxTokensPerMinute));
  const [claudeMaxRequestsPerMinute, setClaudeMaxRequestsPerMinute] = useState(String(settings.claudeMaxRequestsPerMinute));
  const [openaiMaxTokensPerMinute, setOpenaiMaxTokensPerMinute] = useState(String(settings.openaiMaxTokensPerMinute));
  const [openaiMaxRequestsPerMinute, setOpenaiMaxRequestsPerMinute] = useState(String(settings.openaiMaxRequestsPerMinute));
  const [grokMaxTokensPerMinute, setGrokMaxTokensPerMinute] = useState(String(settings.grokMaxTokensPerMinute));
  const [grokMaxRequestsPerMinute, setGrokMaxRequestsPerMinute] = useState(String(settings.grokMaxRequestsPerMinute));
  const [deepseekMaxTokensPerMinute, setDeepseekMaxTokensPerMinute] = useState(String(settings.deepseekMaxTokensPerMinute));
  const [deepseekMaxRequestsPerMinute, setDeepseekMaxRequestsPerMinute] = useState(String(settings.deepseekMaxRequestsPerMinute));

  const [grokKey, setGrokKey] = useState(settings.grokApiKey);
  const [deepseekKey, setDeepseekKey] = useState(settings.deepseekApiKey);

  // Password visibility states
  const [showHuggingfaceKey, setShowHuggingfaceKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showGrokKey, setShowGrokKey] = useState(false);
  const [showDeepseekKey, setShowDeepseekKey] = useState(false);

  const [hasChanges, setHasChanges] = useState(false);

  // App Setup state
  const [webhookStatus, setWebhookStatus] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [webhookData, setWebhookData] = useState<any>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [languageChanged, setLanguageChanged] = useState(false);

  // Track if language was changed
  useEffect(() => {
    if (appLanguage !== settings.appLanguage) {
      setLanguageChanged(true);
    } else {
      setLanguageChanged(false);
    }
  }, [appLanguage, settings.appLanguage]);

  // Reload page after language change is saved
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && languageChanged && selectedSection === "language") {
      // Language was saved successfully, navigate to the settings page with a forced reload
      // This ensures the new language is loaded from the server
      const currentUrl = new URL(window.location.href);
      const settingsUrl = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.search}`;
      window.location.href = settingsUrl;
    }
  }, [fetcher.state, fetcher.data, languageChanged, selectedSection]);

  useEffect(() => {
    if (selectedSection === "setup" || selectedSection === "instructions") {
      setHasChanges(false);
    } else {
      const changed =
        huggingfaceKey !== settings.huggingfaceApiKey ||
        geminiKey !== settings.geminiApiKey ||
        claudeKey !== settings.claudeApiKey ||
        openaiKey !== settings.openaiApiKey ||
        grokKey !== settings.grokApiKey ||
        deepseekKey !== settings.deepseekApiKey ||
        provider !== settings.preferredProvider ||
        appLanguage !== settings.appLanguage ||
        hfMaxTokensPerMinute !== String(settings.hfMaxTokensPerMinute) ||
        hfMaxRequestsPerMinute !== String(settings.hfMaxRequestsPerMinute) ||
        geminiMaxTokensPerMinute !== String(settings.geminiMaxTokensPerMinute) ||
        geminiMaxRequestsPerMinute !== String(settings.geminiMaxRequestsPerMinute) ||
        claudeMaxTokensPerMinute !== String(settings.claudeMaxTokensPerMinute) ||
        claudeMaxRequestsPerMinute !== String(settings.claudeMaxRequestsPerMinute) ||
        openaiMaxTokensPerMinute !== String(settings.openaiMaxTokensPerMinute) ||
        openaiMaxRequestsPerMinute !== String(settings.openaiMaxRequestsPerMinute) ||
        grokMaxTokensPerMinute !== String(settings.grokMaxTokensPerMinute) ||
        grokMaxRequestsPerMinute !== String(settings.grokMaxRequestsPerMinute) ||
        deepseekMaxTokensPerMinute !== String(settings.deepseekMaxTokensPerMinute) ||
        deepseekMaxRequestsPerMinute !== String(settings.deepseekMaxRequestsPerMinute);
      setHasChanges(changed);
    }
  }, [
    huggingfaceKey, geminiKey, claudeKey, openaiKey, grokKey, deepseekKey, provider, appLanguage,
    hfMaxTokensPerMinute, hfMaxRequestsPerMinute,
    geminiMaxTokensPerMinute, geminiMaxRequestsPerMinute,
    claudeMaxTokensPerMinute, claudeMaxRequestsPerMinute,
    openaiMaxTokensPerMinute, openaiMaxRequestsPerMinute,
    grokMaxTokensPerMinute, grokMaxRequestsPerMinute,
    deepseekMaxTokensPerMinute, deepseekMaxRequestsPerMinute,
    settings, selectedSection
  ]);

  const handleSave = () => {
    if (!hasChanges) return;

    fetcher.submit(
      {
        actionType: "saveSettings",
        huggingfaceApiKey: huggingfaceKey,
        geminiApiKey: geminiKey,
        claudeApiKey: claudeKey,
        openaiApiKey: openaiKey,
        grokApiKey: grokKey,
        deepseekApiKey: deepseekKey,
        preferredProvider: provider,
        appLanguage: appLanguage,
        hfMaxTokensPerMinute,
        hfMaxRequestsPerMinute,
        geminiMaxTokensPerMinute,
        geminiMaxRequestsPerMinute,
        claudeMaxTokensPerMinute,
        claudeMaxRequestsPerMinute,
        openaiMaxTokensPerMinute,
        openaiMaxRequestsPerMinute,
        grokMaxTokensPerMinute,
        grokMaxRequestsPerMinute,
        deepseekMaxTokensPerMinute,
        deepseekMaxRequestsPerMinute,
      },
      { method: "POST" }
    );
  };

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
    setSyncStatus("Syncing products and content...");
    setSyncLoading(true);
    setSyncErrors([]);

    try {
      // Sync products first
      const productsUrl = force ? "/api/sync-products?force=true" : "/api/sync-products";
      const productsResponse = await fetch(productsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const productsData = await productsResponse.json();

      // Sync content (collections, articles, pages)
      const contentResponse = await fetch("/api/sync-content", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const contentData = await contentResponse.json();

      // Combine results
      const productsSynced = productsData.success ? productsData.synced || 0 : 0;
      const contentSynced = contentData.success ? contentData.stats?.total || 0 : 0;

      if (productsData.success && contentData.success) {
        setSyncStatus(
          `✓ Synced ${productsSynced} products, ${contentData.stats?.collections || 0} collections, ${contentData.stats?.articles || 0} articles`
        );
        if (productsData.errors) {
          setSyncErrors(productsData.errors);
        }
        // Refresh counts
        if (productsSynced > 0 || contentSynced > 0) {
          // Reload page to get fresh counts
          window.location.reload();
        }
      } else {
        const errors = [];
        if (!productsData.success) errors.push(`Products: ${productsData.error}`);
        if (!contentData.success) errors.push(`Content: ${contentData.error}`);
        setSyncStatus(`✗ Error: ${errors.join(", ")}`);
      }
    } catch (error: any) {
      setSyncStatus(`✗ Error: ${error.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

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
              {fetcher.data?.success && (
                <Banner title={t.common.success} tone="success" onDismiss={() => {}}>
                  {t.common.settingsSaved}
                </Banner>
              )}

              {fetcher.data && !fetcher.data.success && 'error' in fetcher.data && (
                <Banner title={t.common.error} tone="critical">
                  {fetcher.data.error as string}
                </Banner>
              )}

              {/* App Setup Section */}
              {selectedSection === "setup" && (
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
                      {syncStatus && (
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
              )}

              {/* AI Settings */}
              {selectedSection === "ai" && (
                <Card>
                  <BlockStack gap="500">
                    <Text as="h2" variant="headingLg">
                      {t.settings.manageAiKeys}
                    </Text>

                    <Text as="p" variant="bodyMd" tone="subdued">
                      {t.settings.aiKeysDescription}
                    </Text>

                    <Select
                      label={t.settings.preferredProvider}
                      options={AI_PROVIDERS}
                      value={provider}
                      onChange={setProvider}
                      helpText={t.settings.providerHelp}
                    />

                  <div style={{ paddingTop: "1rem", borderTop: "1px solid #e1e3e5" }}>
                    <BlockStack gap="400">
                      <Text as="h3" variant="headingMd">
                        {t.settings.apiKeys}
                      </Text>

                      {/* Hugging Face */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">Hugging Face</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={huggingfaceKey}
                                onChange={setHuggingfaceKey}
                                type={showHuggingfaceKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    {t.settings.huggingfaceHelp}{" "}
                                    <a
                                      href="https://huggingface.co/settings/tokens"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      Hugging Face
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowHuggingfaceKey(!showHuggingfaceKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showHuggingfaceKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={hfMaxTokensPerMinute}
                                onChange={setHfMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={hfMaxRequestsPerMinute}
                                onChange={setHfMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>

                      {/* Google Gemini */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">Google Gemini</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={geminiKey}
                                onChange={setGeminiKey}
                                type={showGeminiKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    {t.settings.geminiHelp}{" "}
                                    <a
                                      href="https://aistudio.google.com/app/apikey"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      Google AI Studio
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowGeminiKey(!showGeminiKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showGeminiKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={geminiMaxTokensPerMinute}
                                onChange={setGeminiMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={geminiMaxRequestsPerMinute}
                                onChange={setGeminiMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>

                      {/* Anthropic Claude */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">Anthropic Claude</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={claudeKey}
                                onChange={setClaudeKey}
                                type={showClaudeKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    {t.settings.claudeHelp}{" "}
                                    <a
                                      href="https://console.anthropic.com/settings/keys"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      Anthropic Console
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowClaudeKey(!showClaudeKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showClaudeKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={claudeMaxTokensPerMinute}
                                onChange={setClaudeMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={claudeMaxRequestsPerMinute}
                                onChange={setClaudeMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>

                      {/* OpenAI */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">OpenAI</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={openaiKey}
                                onChange={setOpenaiKey}
                                type={showOpenaiKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    {t.settings.openaiHelp}{" "}
                                    <a
                                      href="https://platform.openai.com/api-keys"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      OpenAI Platform
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowOpenaiKey(!showOpenaiKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showOpenaiKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={openaiMaxTokensPerMinute}
                                onChange={setOpenaiMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={openaiMaxRequestsPerMinute}
                                onChange={setOpenaiMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>

                      {/* Grok */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">Grok (X.AI)</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={grokKey}
                                onChange={setGrokKey}
                                type={showGrokKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    Get your API key from{" "}
                                    <a
                                      href="https://console.x.ai"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      X.AI Console
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowGrokKey(!showGrokKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showGrokKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={grokMaxTokensPerMinute}
                                onChange={setGrokMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={grokMaxRequestsPerMinute}
                                onChange={setGrokMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>

                      {/* DeepSeek */}
                      <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">DeepSeek</Text>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="API Key"
                                value={deepseekKey}
                                onChange={setDeepseekKey}
                                type={showDeepseekKey ? "text" : "password"}
                                autoComplete="off"
                                helpText={
                                  <span>
                                    Get your API key from{" "}
                                    <a
                                      href="https://platform.deepseek.com"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: "#008060" }}
                                    >
                                      DeepSeek Platform
                                    </a>
                                  </span>
                                }
                              />
                            </div>
                            <button
                              onClick={() => setShowDeepseekKey(!showDeepseekKey)}
                              style={{
                                marginTop: "1.75rem",
                                padding: "0.5rem",
                                background: "white",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              type="button"
                            >
                              {showDeepseekKey ? "👁️" : "👁️‍🗨️"}
                            </button>
                          </div>
                          <InlineStack gap="400">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Tokens / Minute"
                                value={deepseekMaxTokensPerMinute}
                                onChange={setDeepseekMaxTokensPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Max Requests / Minute"
                                value={deepseekMaxRequestsPerMinute}
                                onChange={setDeepseekMaxRequestsPerMinute}
                                type="number"
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </div>
                    </BlockStack>
                  </div>

                    <InlineStack align="end">
                      <Button
                        variant={hasChanges ? "primary" : undefined}
                        onClick={handleSave}
                        disabled={!hasChanges}
                        loading={fetcher.state !== "idle"}
                      >
                        {t.products.saveChanges}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}

              {/* AI Instructions */}
              {selectedSection === "instructions" && (
                <AIInstructionsTabs
                  instructions={instructions}
                  fetcher={fetcher}
                />
              )}

              {/* Language Settings */}
              {selectedSection === "language" && (
                <Card>
                  <BlockStack gap="500">
                    <Text as="h2" variant="headingLg">
                      {t.settings.appLanguage}
                    </Text>

                    <Text as="p" variant="bodyMd" tone="subdued">
                      {t.settings.appLanguageDescription}
                    </Text>

                    <Select
                      label=""
                      options={APP_LANGUAGES}
                      value={appLanguage}
                      onChange={setAppLanguage}
                    />

                    <InlineStack align="end">
                      <Button
                        variant={hasChanges ? "primary" : undefined}
                        onClick={handleSave}
                        disabled={!hasChanges}
                        loading={fetcher.state !== "idle"}
                      >
                        {t.products.saveChanges}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

import { useState, useEffect, useRef } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
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
import { db } from "../db.server";
import { useI18n } from "../contexts/I18nContext";

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

  return json({
    shop: session.shop,
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
      titleFormat: instructions.titleFormat || "",
      titleInstructions: instructions.titleInstructions || "",
      descriptionFormat: instructions.descriptionFormat || "",
      descriptionInstructions: instructions.descriptionInstructions || "",
      handleFormat: instructions.handleFormat || "",
      handleInstructions: instructions.handleInstructions || "",
      seoTitleFormat: instructions.seoTitleFormat || "",
      seoTitleInstructions: instructions.seoTitleInstructions || "",
      metaDescFormat: instructions.metaDescFormat || "",
      metaDescInstructions: instructions.metaDescInstructions || "",
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  try {
    if (actionType === "saveInstructions") {
      // Save AI instructions
      await db.aIInstructions.upsert({
        where: { shop: session.shop },
        update: {
          titleFormat: (formData.get("titleFormat") as string) || null,
          titleInstructions: (formData.get("titleInstructions") as string) || null,
          descriptionFormat: (formData.get("descriptionFormat") as string) || null,
          descriptionInstructions: (formData.get("descriptionInstructions") as string) || null,
          handleFormat: (formData.get("handleFormat") as string) || null,
          handleInstructions: (formData.get("handleInstructions") as string) || null,
          seoTitleFormat: (formData.get("seoTitleFormat") as string) || null,
          seoTitleInstructions: (formData.get("seoTitleInstructions") as string) || null,
          metaDescFormat: (formData.get("metaDescFormat") as string) || null,
          metaDescInstructions: (formData.get("metaDescInstructions") as string) || null,
        },
        create: {
          shop: session.shop,
          titleFormat: (formData.get("titleFormat") as string) || null,
          titleInstructions: (formData.get("titleInstructions") as string) || null,
          descriptionFormat: (formData.get("descriptionFormat") as string) || null,
          descriptionInstructions: (formData.get("descriptionInstructions") as string) || null,
          handleFormat: (formData.get("handleFormat") as string) || null,
          handleInstructions: (formData.get("handleInstructions") as string) || null,
          seoTitleFormat: (formData.get("seoTitleFormat") as string) || null,
          seoTitleInstructions: (formData.get("seoTitleInstructions") as string) || null,
          metaDescFormat: (formData.get("metaDescFormat") as string) || null,
          metaDescInstructions: (formData.get("metaDescInstructions") as string) || null,
        },
      });

      return json({ success: true });
    } else {
      // Save AI settings
      const huggingfaceApiKey = formData.get("huggingfaceApiKey") as string;
      const geminiApiKey = formData.get("geminiApiKey") as string;
      const claudeApiKey = formData.get("claudeApiKey") as string;
      const openaiApiKey = formData.get("openaiApiKey") as string;
      const grokApiKey = formData.get("grokApiKey") as string;
      const deepseekApiKey = formData.get("deepseekApiKey") as string;
      const preferredProvider = formData.get("preferredProvider") as string;
      const appLanguage = formData.get("appLanguage") as string;

      // Rate limits
      const hfMaxTokensPerMinute = parseInt(formData.get("hfMaxTokensPerMinute") as string) || null;
      const hfMaxRequestsPerMinute = parseInt(formData.get("hfMaxRequestsPerMinute") as string) || null;
      const geminiMaxTokensPerMinute = parseInt(formData.get("geminiMaxTokensPerMinute") as string) || null;
      const geminiMaxRequestsPerMinute = parseInt(formData.get("geminiMaxRequestsPerMinute") as string) || null;
      const claudeMaxTokensPerMinute = parseInt(formData.get("claudeMaxTokensPerMinute") as string) || null;
      const claudeMaxRequestsPerMinute = parseInt(formData.get("claudeMaxRequestsPerMinute") as string) || null;
      const openaiMaxTokensPerMinute = parseInt(formData.get("openaiMaxTokensPerMinute") as string) || null;
      const openaiMaxRequestsPerMinute = parseInt(formData.get("openaiMaxRequestsPerMinute") as string) || null;
      const grokMaxTokensPerMinute = parseInt(formData.get("grokMaxTokensPerMinute") as string) || null;
      const grokMaxRequestsPerMinute = parseInt(formData.get("grokMaxRequestsPerMinute") as string) || null;
      const deepseekMaxTokensPerMinute = parseInt(formData.get("deepseekMaxTokensPerMinute") as string) || null;
      const deepseekMaxRequestsPerMinute = parseInt(formData.get("deepseekMaxRequestsPerMinute") as string) || null;

      await db.aISettings.upsert({
        where: { shop: session.shop },
        update: {
          huggingfaceApiKey: huggingfaceApiKey || null,
          geminiApiKey: geminiApiKey || null,
          claudeApiKey: claudeApiKey || null,
          openaiApiKey: openaiApiKey || null,
          grokApiKey: grokApiKey || null,
          deepseekApiKey: deepseekApiKey || null,
          preferredProvider,
          appLanguage,
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
        create: {
          shop: session.shop,
          huggingfaceApiKey: huggingfaceApiKey || null,
          geminiApiKey: geminiApiKey || null,
          claudeApiKey: claudeApiKey || null,
          openaiApiKey: openaiApiKey || null,
          grokApiKey: grokApiKey || null,
          deepseekApiKey: deepseekApiKey || null,
          preferredProvider,
          appLanguage,
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
      });

      return json({ success: true });
    }
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
};

export default function SettingsPage() {
  const { shop, settings, instructions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();

  const AI_PROVIDERS = [
    { label: t.settings.providers.huggingface, value: "huggingface" },
    { label: t.settings.providers.gemini, value: "gemini" },
    { label: t.settings.providers.claude, value: "claude" },
    { label: t.settings.providers.openai, value: "openai" },
  ];

  const APP_LANGUAGES = [
    { label: t.settings.languages.de, value: "de" },
    { label: t.settings.languages.en, value: "en" },
  ];

  const [selectedSection, setSelectedSection] = useState<"language" | "ai" | "instructions">("language");
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

  const [hasChanges, setHasChanges] = useState(false);

  // AI Instructions state
  const [titleFormat, setTitleFormat] = useState(instructions.titleFormat);
  const [titleInstructions, setTitleInstructions] = useState(instructions.titleInstructions);
  const [descriptionFormat, setDescriptionFormat] = useState(instructions.descriptionFormat);
  const [descriptionInstructions, setDescriptionInstructions] = useState(instructions.descriptionInstructions);
  const [handleFormat, setHandleFormat] = useState(instructions.handleFormat);
  const [handleInstructions, setHandleInstructions] = useState(instructions.handleInstructions);
  const [seoTitleFormat, setSeoTitleFormat] = useState(instructions.seoTitleFormat);
  const [seoTitleInstructions, setSeoTitleInstructions] = useState(instructions.seoTitleInstructions);
  const [metaDescFormat, setMetaDescFormat] = useState(instructions.metaDescFormat);
  const [metaDescInstructions, setMetaDescInstructions] = useState(instructions.metaDescInstructions);
  const [descriptionFormatMode, setDescriptionFormatMode] = useState<"html" | "rendered">("rendered");
  const descriptionFormatEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedSection === "instructions") {
      const changed =
        titleFormat !== instructions.titleFormat ||
        titleInstructions !== instructions.titleInstructions ||
        descriptionFormat !== instructions.descriptionFormat ||
        descriptionInstructions !== instructions.descriptionInstructions ||
        handleFormat !== instructions.handleFormat ||
        handleInstructions !== instructions.handleInstructions ||
        seoTitleFormat !== instructions.seoTitleFormat ||
        seoTitleInstructions !== instructions.seoTitleInstructions ||
        metaDescFormat !== instructions.metaDescFormat ||
        metaDescInstructions !== instructions.metaDescInstructions;
      setHasChanges(changed);
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
    huggingfaceKey, geminiKey, claudeKey, openaiKey, provider, appLanguage, settings,
    titleFormat, titleInstructions, descriptionFormat, descriptionInstructions,
    handleFormat, handleInstructions, seoTitleFormat, seoTitleInstructions,
    metaDescFormat, metaDescInstructions, instructions, selectedSection
  ]);

  const handleFormatText = (command: string) => {
    if (descriptionFormatMode !== "rendered" || !descriptionFormatEditorRef.current) return;

    descriptionFormatEditorRef.current.focus();

    switch (command) {
      case "bold":
        document.execCommand("bold", false);
        break;
      case "italic":
        document.execCommand("italic", false);
        break;
      case "underline":
        document.execCommand("underline", false);
        break;
      case "h1":
        document.execCommand("formatBlock", false, "<h1>");
        break;
      case "h2":
        document.execCommand("formatBlock", false, "<h2>");
        break;
      case "h3":
        document.execCommand("formatBlock", false, "<h3>");
        break;
      case "p":
        document.execCommand("formatBlock", false, "<p>");
        break;
      case "ul":
        document.execCommand("insertUnorderedList", false);
        break;
      case "ol":
        document.execCommand("insertOrderedList", false);
        break;
      case "br":
        document.execCommand("insertHTML", false, "<br>");
        break;
    }

    setDescriptionFormat(descriptionFormatEditorRef.current.innerHTML);
  };

  const toggleDescriptionFormatMode = () => {
    setDescriptionFormatMode(descriptionFormatMode === "html" ? "rendered" : "html");
  };

  const handleSave = () => {
    if (!hasChanges) return;

    if (selectedSection === "instructions") {
      fetcher.submit(
        {
          actionType: "saveInstructions",
          titleFormat,
          titleInstructions,
          descriptionFormat,
          descriptionInstructions,
          handleFormat,
          handleInstructions,
          seoTitleFormat,
          seoTitleInstructions,
          metaDescFormat,
          metaDescInstructions,
        },
        { method: "POST" }
      );
    } else {
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
    }
  };

  return (
    <Page fullWidth>
      <style>{`
        .description-editor h1 {
          font-size: 2em;
          font-weight: bold;
          margin: 0.67em 0;
        }
        .description-editor h2 {
          font-size: 1.5em;
          font-weight: bold;
          margin: 0.75em 0;
        }
        .description-editor h3 {
          font-size: 1.17em;
          font-weight: bold;
          margin: 0.83em 0;
        }
        .description-editor p {
          margin: 1em 0;
        }
        .description-editor ul, .description-editor ol {
          margin: 1em 0;
          padding-left: 40px;
        }
      `}</style>
      <MainNavigation />
      <div style={{ padding: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          {/* Left Sidebar */}
          <div style={{ width: "250px", flexShrink: 0 }}>
            <Card padding="0">
              <button
                onClick={() => setSelectedSection("language")}
                style={{
                  width: "100%",
                  padding: "1rem",
                  background: selectedSection === "language" ? "#f1f8f5" : "white",
                  borderLeft: selectedSection === "language" ? "3px solid #008060" : "3px solid transparent",
                  border: "none",
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
                  KI-Anweisungen
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
                          <TextField
                            label="API Key"
                            value={huggingfaceKey}
                            onChange={setHuggingfaceKey}
                            type="password"
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
                          <TextField
                            label="API Key"
                            value={geminiKey}
                            onChange={setGeminiKey}
                            type="password"
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
                          <TextField
                            label="API Key"
                            value={claudeKey}
                            onChange={setClaudeKey}
                            type="password"
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
                          <TextField
                            label="API Key"
                            value={openaiKey}
                            onChange={setOpenaiKey}
                            type="password"
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
                          <TextField
                            label="API Key"
                            value={grokKey}
                            onChange={setGrokKey}
                            type="password"
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
                          <TextField
                            label="API Key"
                            value={deepseekKey}
                            onChange={setDeepseekKey}
                            type="password"
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
                <Card>
                  <BlockStack gap="500">
                    <Text as="h2" variant="headingLg">
                      KI-Anweisungen für Produktfelder
                    </Text>

                    <Text as="p" variant="bodyMd" tone="subdued">
                      Geben Sie für jedes Feld ein Formatbeispiel und spezifische Anweisungen an, an denen sich die KI orientieren soll.
                    </Text>

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

                    {/* Title */}
                    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingMd">Titel</Text>
                        <TextField
                          label="Formatbeispiel"
                          value={titleFormat}
                          onChange={setTitleFormat}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. Premium Leder Geldbörse - Elegant & Stilvoll"
                          helpText={`${titleFormat.length} Zeichen - Kopieren Sie ein Beispiel eines idealen Titels hier hinein`}
                        />
                        <TextField
                          label="Anweisungen"
                          value={titleInstructions}
                          onChange={setTitleInstructions}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. Nicht länger als 60 Zeichen, gehobene Ausdrucksweise, Material und Hauptmerkmal nennen"
                          helpText={`${titleInstructions.length} Zeichen - Spezifische Anweisungen für die KI`}
                        />
                      </BlockStack>
                    </div>

                    {/* Description */}
                    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                      <BlockStack gap="400">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingMd">Beschreibung</Text>
                          <Button size="slim" onClick={toggleDescriptionFormatMode}>
                            {descriptionFormatMode === "html" ? "Vorschau" : "HTML"}
                          </Button>
                        </InlineStack>

                        <div>
                          <Text as="p" variant="bodyMd" fontWeight="medium">Formatbeispiel</Text>
                          {descriptionFormatMode === "rendered" && (
                            <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.25rem", flexWrap: "wrap", padding: "0.5rem", background: "white", border: "1px solid #c9cccf", borderRadius: "8px 8px 0 0" }}>
                              <ButtonGroup variant="segmented">
                                <Button size="slim" onClick={() => handleFormatText("bold")}>B</Button>
                                <Button size="slim" onClick={() => handleFormatText("italic")}>I</Button>
                                <Button size="slim" onClick={() => handleFormatText("underline")}>U</Button>
                              </ButtonGroup>
                              <ButtonGroup variant="segmented">
                                <Button size="slim" onClick={() => handleFormatText("h1")}>H1</Button>
                                <Button size="slim" onClick={() => handleFormatText("h2")}>H2</Button>
                                <Button size="slim" onClick={() => handleFormatText("h3")}>H3</Button>
                              </ButtonGroup>
                              <ButtonGroup variant="segmented">
                                <Button size="slim" onClick={() => handleFormatText("ul")}>Liste</Button>
                                <Button size="slim" onClick={() => handleFormatText("ol")}>Num.</Button>
                              </ButtonGroup>
                              <ButtonGroup variant="segmented">
                                <Button size="slim" onClick={() => handleFormatText("p")}>Absatz</Button>
                                <Button size="slim" onClick={() => handleFormatText("br")}>Umbruch</Button>
                              </ButtonGroup>
                            </div>
                          )}

                          {descriptionFormatMode === "html" ? (
                            <textarea
                              value={descriptionFormat}
                              onChange={(e) => setDescriptionFormat(e.target.value)}
                              placeholder="z.B. <h2>Entdecken Sie unsere handgefertigte Ledertasche</h2><p>Premium Qualität...</p>"
                              style={{
                                width: "100%",
                                minHeight: "150px",
                                padding: "12px",
                                border: "1px solid #c9cccf",
                                borderRadius: "8px",
                                fontFamily: "monospace",
                                fontSize: "14px",
                                marginTop: "0.5rem",
                              }}
                            />
                          ) : (
                            <div
                              ref={descriptionFormatEditorRef}
                              contentEditable
                              onInput={(e) => setDescriptionFormat(e.currentTarget.innerHTML)}
                              dangerouslySetInnerHTML={{ __html: descriptionFormat || '<p>z.B. Entdecken Sie unsere handgefertigte Ledertasche...</p>' }}
                              style={{
                                width: "100%",
                                minHeight: "150px",
                                padding: "12px",
                                border: "1px solid #c9cccf",
                                borderTop: "none",
                                borderRadius: "0 0 8px 8px",
                                lineHeight: "1.6",
                                background: "white",
                              }}
                              className="description-editor"
                            />
                          )}
                          <Text as="p" variant="bodySm" tone="subdued">
                            {descriptionFormat.replace(/<[^>]*>/g, "").length} Zeichen - Kopieren Sie ein Beispiel einer idealen Beschreibung hier hinein
                          </Text>
                        </div>

                        <TextField
                          label="Anweisungen"
                          value={descriptionInstructions}
                          onChange={setDescriptionInstructions}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. 150-200 Wörter, gehobene Ausdrucksweise, Vorteile hervorheben, Storytelling verwenden"
                          helpText={`${descriptionInstructions.length} Zeichen - Spezifische Anweisungen für die KI`}
                        />
                      </BlockStack>
                    </div>

                    {/* Handle */}
                    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingMd">URL-Slug (Handle)</Text>
                        <TextField
                          label="Formatbeispiel"
                          value={handleFormat}
                          onChange={setHandleFormat}
                          multiline={2}
                          autoComplete="off"
                          placeholder="z.B. premium-leder-geldboerse-elegant"
                          helpText={`${handleFormat.length} Zeichen - Kopieren Sie ein Beispiel eines idealen URL-Slugs hier hinein`}
                        />
                        <TextField
                          label="Anweisungen"
                          value={handleInstructions}
                          onChange={setHandleInstructions}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. Nur Kleinbuchstaben und Bindestriche, keine Umlaute, max. 50 Zeichen, SEO-optimiert"
                          helpText={`${handleInstructions.length} Zeichen - Spezifische Anweisungen für die KI`}
                        />
                      </BlockStack>
                    </div>

                    {/* SEO Title */}
                    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingMd">SEO-Titel</Text>
                        <TextField
                          label="Formatbeispiel"
                          value={seoTitleFormat}
                          onChange={setSeoTitleFormat}
                          multiline={2}
                          autoComplete="off"
                          placeholder="z.B. Premium Leder Geldbörse kaufen | Handgefertigt & Elegant"
                          helpText={`${seoTitleFormat.length} Zeichen - Kopieren Sie ein Beispiel eines idealen SEO-Titels hier hinein`}
                        />
                        <TextField
                          label="Anweisungen"
                          value={seoTitleInstructions}
                          onChange={setSeoTitleInstructions}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. 50-60 Zeichen, Keywords am Anfang, Call-to-Action verwenden"
                          helpText={`${seoTitleInstructions.length} Zeichen - Spezifische Anweisungen für die KI`}
                        />
                      </BlockStack>
                    </div>

                    {/* Meta Description */}
                    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingMd">Meta-Beschreibung</Text>
                        <TextField
                          label="Formatbeispiel"
                          value={metaDescFormat}
                          onChange={setMetaDescFormat}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. Entdecken Sie unsere handgefertigten Premium Leder Geldbörsen. Elegant, langlebig und zeitlos. Jetzt kaufen!"
                          helpText={`${metaDescFormat.length} Zeichen - Kopieren Sie ein Beispiel einer idealen Meta-Beschreibung hier hinein`}
                        />
                        <TextField
                          label="Anweisungen"
                          value={metaDescInstructions}
                          onChange={setMetaDescInstructions}
                          multiline={3}
                          autoComplete="off"
                          placeholder="z.B. 150-160 Zeichen, Keywords verwenden, zum Klicken anregen, USP hervorheben"
                          helpText={`${metaDescInstructions.length} Zeichen - Spezifische Anweisungen für die KI`}
                        />
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
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

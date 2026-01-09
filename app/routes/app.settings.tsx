import { useState, useEffect } from "react";
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

  return json({
    shop: session.shop,
    settings: {
      huggingfaceApiKey: settings.huggingfaceApiKey || "",
      geminiApiKey: settings.geminiApiKey || "",
      claudeApiKey: settings.claudeApiKey || "",
      openaiApiKey: settings.openaiApiKey || "",
      preferredProvider: settings.preferredProvider,
      appLanguage: settings.appLanguage || "de",
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const huggingfaceApiKey = formData.get("huggingfaceApiKey") as string;
  const geminiApiKey = formData.get("geminiApiKey") as string;
  const claudeApiKey = formData.get("claudeApiKey") as string;
  const openaiApiKey = formData.get("openaiApiKey") as string;
  const preferredProvider = formData.get("preferredProvider") as string;
  const appLanguage = formData.get("appLanguage") as string;

  try {
    await db.aISettings.upsert({
      where: { shop: session.shop },
      update: {
        huggingfaceApiKey: huggingfaceApiKey || null,
        geminiApiKey: geminiApiKey || null,
        claudeApiKey: claudeApiKey || null,
        openaiApiKey: openaiApiKey || null,
        preferredProvider,
        appLanguage,
      },
      create: {
        shop: session.shop,
        huggingfaceApiKey: huggingfaceApiKey || null,
        geminiApiKey: geminiApiKey || null,
        claudeApiKey: claudeApiKey || null,
        openaiApiKey: openaiApiKey || null,
        preferredProvider,
        appLanguage,
      },
    });

    return json({ success: true });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
};

export default function SettingsPage() {
  const { shop, settings } = useLoaderData<typeof loader>();
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

  const [selectedSection, setSelectedSection] = useState<"language" | "ai">("language");
  const [huggingfaceKey, setHuggingfaceKey] = useState(settings.huggingfaceApiKey);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [claudeKey, setClaudeKey] = useState(settings.claudeApiKey);
  const [openaiKey, setOpenaiKey] = useState(settings.openaiApiKey);
  const [provider, setProvider] = useState(settings.preferredProvider);
  const [appLanguage, setAppLanguage] = useState(settings.appLanguage);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed =
      huggingfaceKey !== settings.huggingfaceApiKey ||
      geminiKey !== settings.geminiApiKey ||
      claudeKey !== settings.claudeApiKey ||
      openaiKey !== settings.openaiApiKey ||
      provider !== settings.preferredProvider ||
      appLanguage !== settings.appLanguage;
    setHasChanges(changed);
  }, [huggingfaceKey, geminiKey, claudeKey, openaiKey, provider, appLanguage, settings]);

  const handleSave = () => {
    fetcher.submit(
      {
        huggingfaceApiKey: huggingfaceKey,
        geminiApiKey: geminiKey,
        claudeApiKey: claudeKey,
        openaiApiKey: openaiKey,
        preferredProvider: provider,
        appLanguage: appLanguage,
      },
      { method: "POST" }
    );
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
                      <div>
                        <TextField
                          label={t.settings.huggingface}
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
                      </div>

                      {/* Google Gemini */}
                      <div>
                        <TextField
                          label={t.settings.gemini}
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
                      </div>

                      {/* Anthropic Claude */}
                      <div>
                        <TextField
                          label={t.settings.claude}
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
                      </div>

                      {/* OpenAI */}
                      <div>
                        <TextField
                          label={t.settings.openai}
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
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

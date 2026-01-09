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

const AI_PROVIDERS = [
  { label: "Hugging Face (Kostenlos)", value: "huggingface" },
  { label: "Google Gemini (Kostenlos)", value: "gemini" },
  { label: "Anthropic Claude", value: "claude" },
  { label: "OpenAI GPT", value: "openai" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = await db.aISettings.create({
      data: {
        shop: session.shop,
        preferredProvider: "huggingface",
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

  try {
    await db.aISettings.upsert({
      where: { shop: session.shop },
      update: {
        huggingfaceApiKey: huggingfaceApiKey || null,
        geminiApiKey: geminiApiKey || null,
        claudeApiKey: claudeApiKey || null,
        openaiApiKey: openaiApiKey || null,
        preferredProvider,
      },
      create: {
        shop: session.shop,
        huggingfaceApiKey: huggingfaceApiKey || null,
        geminiApiKey: geminiApiKey || null,
        claudeApiKey: claudeApiKey || null,
        openaiApiKey: openaiApiKey || null,
        preferredProvider,
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

  const [huggingfaceKey, setHuggingfaceKey] = useState(settings.huggingfaceApiKey);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [claudeKey, setClaudeKey] = useState(settings.claudeApiKey);
  const [openaiKey, setOpenaiKey] = useState(settings.openaiApiKey);
  const [provider, setProvider] = useState(settings.preferredProvider);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed =
      huggingfaceKey !== settings.huggingfaceApiKey ||
      geminiKey !== settings.geminiApiKey ||
      claudeKey !== settings.claudeApiKey ||
      openaiKey !== settings.openaiApiKey ||
      provider !== settings.preferredProvider;
    setHasChanges(changed);
  }, [huggingfaceKey, geminiKey, claudeKey, openaiKey, provider, settings]);

  const handleSave = () => {
    fetcher.submit(
      {
        huggingfaceApiKey: huggingfaceKey,
        geminiApiKey: geminiKey,
        claudeApiKey: claudeKey,
        openaiApiKey: openaiKey,
        preferredProvider: provider,
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
              <div
                style={{
                  padding: "1rem",
                  background: "#f1f8f5",
                  borderLeft: "3px solid #008060",
                }}
              >
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  AI API-Zugangscodes
                </Text>
              </div>
            </Card>
          </div>

          {/* Main Content */}
          <div style={{ flex: 1 }}>
            <BlockStack gap="400">
              {fetcher.data?.success && (
                <Banner title="Erfolgreich gespeichert!" tone="success" onDismiss={() => {}}>
                  Ihre AI-Einstellungen wurden aktualisiert.
                </Banner>
              )}

              {fetcher.data && !fetcher.data.success && 'error' in fetcher.data && (
                <Banner title="Fehler" tone="critical">
                  {fetcher.data.error as string}
                </Banner>
              )}

              <Card>
                <BlockStack gap="500">
                  <Text as="h2" variant="headingLg">
                    AI API-Zugangscodes verwalten
                  </Text>

                  <Text as="p" variant="bodyMd" tone="subdued">
                    Konfigurieren Sie Ihre bevorzugten KI-Anbieter. Die API-Schlüssel werden sicher
                    verschlüsselt gespeichert und nur für Ihre Shop-Übersetzungen verwendet.
                  </Text>

                  <Select
                    label="Bevorzugter AI-Anbieter"
                    options={AI_PROVIDERS}
                    value={provider}
                    onChange={setProvider}
                    helpText="Wählen Sie den Standard-Anbieter für KI-Generierung und Übersetzungen"
                  />

                  <div style={{ paddingTop: "1rem", borderTop: "1px solid #e1e3e5" }}>
                    <BlockStack gap="400">
                      <Text as="h3" variant="headingMd">
                        API-Schlüssel
                      </Text>

                      {/* Hugging Face */}
                      <div>
                        <TextField
                          label="Hugging Face API-Schlüssel"
                          value={huggingfaceKey}
                          onChange={setHuggingfaceKey}
                          type="password"
                          autoComplete="off"
                          helpText={
                            <span>
                              Kostenlos erhältlich bei{" "}
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
                          label="Google Gemini API-Schlüssel"
                          value={geminiKey}
                          onChange={setGeminiKey}
                          type="password"
                          autoComplete="off"
                          helpText={
                            <span>
                              Kostenlos erhältlich bei{" "}
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
                          label="Anthropic Claude API-Schlüssel"
                          value={claudeKey}
                          onChange={setClaudeKey}
                          type="password"
                          autoComplete="off"
                          helpText={
                            <span>
                              Erhältlich bei{" "}
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
                          label="OpenAI API-Schlüssel"
                          value={openaiKey}
                          onChange={setOpenaiKey}
                          type="password"
                          autoComplete="off"
                          helpText={
                            <span>
                              Erhältlich bei{" "}
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
                      Änderungen speichern
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </div>
        </div>
      </div>
    </Page>
  );
}

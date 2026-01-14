import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  Select,
  InlineStack,
} from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";

interface Settings {
  huggingfaceApiKey: string;
  geminiApiKey: string;
  claudeApiKey: string;
  openaiApiKey: string;
  grokApiKey: string;
  deepseekApiKey: string;
  preferredProvider: string;
  appLanguage: string;
  hfMaxTokensPerMinute: number;
  hfMaxRequestsPerMinute: number;
  geminiMaxTokensPerMinute: number;
  geminiMaxRequestsPerMinute: number;
  claudeMaxTokensPerMinute: number;
  claudeMaxRequestsPerMinute: number;
  openaiMaxTokensPerMinute: number;
  openaiMaxRequestsPerMinute: number;
  grokMaxTokensPerMinute: number;
  grokMaxRequestsPerMinute: number;
  deepseekMaxTokensPerMinute: number;
  deepseekMaxRequestsPerMinute: number;
}

interface SettingsAITabProps {
  settings: Settings;
  fetcher: FetcherWithComponents<any>;
  t: any; // i18n translations
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsAITab({ settings, fetcher, t, onHasChangesChange }: SettingsAITabProps) {
  const AI_PROVIDERS = [
    { label: t.settings.providers.huggingface, value: "huggingface" },
    { label: t.settings.providers.gemini, value: "gemini" },
    { label: t.settings.providers.claude, value: "claude" },
    { label: t.settings.providers.openai, value: "openai" },
    { label: t.settings.providers.grok, value: "grok" },
    { label: t.settings.providers.deepseek, value: "deepseek" },
  ];

  const [huggingfaceKey, setHuggingfaceKey] = useState(settings.huggingfaceApiKey);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [claudeKey, setClaudeKey] = useState(settings.claudeApiKey);
  const [openaiKey, setOpenaiKey] = useState(settings.openaiApiKey);
  const [grokKey, setGrokKey] = useState(settings.grokApiKey);
  const [deepseekKey, setDeepseekKey] = useState(settings.deepseekApiKey);
  const [provider, setProvider] = useState(settings.preferredProvider);

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

  // Password visibility states
  const [showHuggingfaceKey, setShowHuggingfaceKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showGrokKey, setShowGrokKey] = useState(false);
  const [showDeepseekKey, setShowDeepseekKey] = useState(false);

  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed =
      huggingfaceKey !== settings.huggingfaceApiKey ||
      geminiKey !== settings.geminiApiKey ||
      claudeKey !== settings.claudeApiKey ||
      openaiKey !== settings.openaiApiKey ||
      grokKey !== settings.grokApiKey ||
      deepseekKey !== settings.deepseekApiKey ||
      provider !== settings.preferredProvider ||
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
    if (onHasChangesChange) {
      onHasChangesChange(changed);
    }
  }, [
    huggingfaceKey, geminiKey, claudeKey, openaiKey, grokKey, deepseekKey, provider,
    hfMaxTokensPerMinute, hfMaxRequestsPerMinute,
    geminiMaxTokensPerMinute, geminiMaxRequestsPerMinute,
    claudeMaxTokensPerMinute, claudeMaxRequestsPerMinute,
    openaiMaxTokensPerMinute, openaiMaxRequestsPerMinute,
    grokMaxTokensPerMinute, grokMaxRequestsPerMinute,
    deepseekMaxTokensPerMinute, deepseekMaxRequestsPerMinute,
    settings,
    onHasChangesChange
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
        appLanguage: settings.appLanguage,
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

  const handleDiscard = () => {
    setHuggingfaceKey(settings.huggingfaceApiKey);
    setGeminiKey(settings.geminiApiKey);
    setClaudeKey(settings.claudeApiKey);
    setOpenaiKey(settings.openaiApiKey);
    setGrokKey(settings.grokApiKey);
    setDeepseekKey(settings.deepseekApiKey);
    setProvider(settings.preferredProvider);
    setHfMaxTokensPerMinute(String(settings.hfMaxTokensPerMinute));
    setHfMaxRequestsPerMinute(String(settings.hfMaxRequestsPerMinute));
    setGeminiMaxTokensPerMinute(String(settings.geminiMaxTokensPerMinute));
    setGeminiMaxRequestsPerMinute(String(settings.geminiMaxRequestsPerMinute));
    setClaudeMaxTokensPerMinute(String(settings.claudeMaxTokensPerMinute));
    setClaudeMaxRequestsPerMinute(String(settings.claudeMaxRequestsPerMinute));
    setOpenaiMaxTokensPerMinute(String(settings.openaiMaxTokensPerMinute));
    setOpenaiMaxRequestsPerMinute(String(settings.openaiMaxRequestsPerMinute));
    setGrokMaxTokensPerMinute(String(settings.grokMaxTokensPerMinute));
    setGrokMaxRequestsPerMinute(String(settings.grokMaxRequestsPerMinute));
    setDeepseekMaxTokensPerMinute(String(settings.deepseekMaxTokensPerMinute));
    setDeepseekMaxRequestsPerMinute(String(settings.deepseekMaxRequestsPerMinute));
  };

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingLg">
            {t.settings.manageAiKeys}
          </Text>
          <SaveDiscardButtons
            hasChanges={hasChanges}
            onSave={handleSave}
            onDiscard={handleDiscard}
            saveText={t.products.saveChanges}
            discardText={t.content?.discardChanges || "Verwerfen"}
            action="saveSettings"
            fetcherState={fetcher.state}
            fetcherFormData={fetcher.formData}
          />
        </InlineStack>

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
  );
}

import { useState, useEffect, useCallback } from "react";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  Select,
  InlineStack,
  Icon,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { ViewIcon, HideIcon } from "@shopify/polaris-icons";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { HelpTooltip } from "./HelpTooltip";
import { hasApiKeyForProvider, getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import { CURATED_MODELS, DEFAULT_MODELS } from "../config/ai-models.config";
import "../styles/RateLimitFields.css";

// Responsive label component that shows short version on small screens
function ResponsiveLabel({ fullText, shortText, helpKey }: { fullText: string; shortText: string; helpKey?: string }) {
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <span className="hide-on-small">{fullText}</span>
      <span className="show-on-small">{shortText}</span>
      {helpKey && <HelpTooltip helpKey={helpKey} />}
    </InlineStack>
  );
}

interface Settings {
  huggingfaceApiKey: string;
  geminiApiKey: string;
  claudeApiKey: string;
  openaiApiKey: string;
  grokApiKey: string;
  deepseekApiKey: string;
  preferredProvider: string;
  selectedModel: string;
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
    { label: t.settings.providers.openai, value: "openai" },
    { label: t.settings.providers.gemini, value: "gemini" },
    { label: t.settings.providers.claude, value: "claude" },
    { label: t.settings.providers.huggingface, value: "huggingface" },
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
  const [selectedModel, setSelectedModel] = useState(settings.selectedModel || '');
  const [availableModels, setAvailableModels] = useState<Array<{ label: string; value: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch available models when provider changes
  const fetchModels = useCallback(async (providerToFetch: string) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const response = await fetch(`/api/ai-models?provider=${providerToFetch}`);
      const data = await response.json();
      if (data.success && data.models) {
        const options = data.models.map((m: { id: string; name: string }) => ({
          label: m.name,
          value: m.id,
        }));
        setAvailableModels(options);
        // If current model is not in the new list, reset to default
        const modelIds = data.models.map((m: { id: string }) => m.id);
        if (!modelIds.includes(selectedModel)) {
          setSelectedModel(data.defaultModel || '');
        }
      } else {
        setModelsError(data.error || t.settings.modelFetchError);
        // Use curated fallback
        const fallback = CURATED_MODELS[providerToFetch as AIProvider] || [];
        setAvailableModels(fallback.map(m => ({ label: m.name, value: m.id })));
      }
    } catch {
      setModelsError(t.settings.modelFetchError);
      const fallback = CURATED_MODELS[providerToFetch as AIProvider] || [];
      setAvailableModels(fallback.map(m => ({ label: m.name, value: m.id })));
    } finally {
      setModelsLoading(false);
    }
  }, [selectedModel, t]);

  // Fetch models on mount and when provider changes
  useEffect(() => {
    fetchModels(provider);
  }, [provider]);

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
      selectedModel !== (settings.selectedModel || '') ||
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
    huggingfaceKey, geminiKey, claudeKey, openaiKey, grokKey, deepseekKey, provider, selectedModel,
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
        selectedModel,
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
    setSelectedModel(settings.selectedModel || '');
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

  // Check if the preferred provider has an API key
  const preferredProviderHasKey = hasApiKeyForProvider(
    {
      huggingfaceApiKey: huggingfaceKey,
      geminiApiKey: geminiKey,
      claudeApiKey: claudeKey,
      openaiApiKey: openaiKey,
      grokApiKey: grokKey,
      deepseekApiKey: deepseekKey,
    },
    provider as AIProvider
  );

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {t.settings.manageAiKeys}
          </Text>
          <div style={{ marginLeft: "auto" }}>
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
          </div>
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.aiKeysDescription}
        </Text>

        {!preferredProviderHasKey && (
          <Banner tone="warning">
            <Text as="p" fontWeight="semibold">
              {t.settings.preferredProviderNoKey?.replace("{provider}", getProviderDisplayName(provider as AIProvider))}
            </Text>
            <Text as="p" variant="bodySm">
              {t.settings.preferredProviderNoKeyDescription?.replace("{provider}", getProviderDisplayName(provider as AIProvider))}
            </Text>
          </Banner>
        )}

        <InlineStack gap="400" wrap={false} blockAlign="end">
          <div style={{ flex: 1 }}>
            <Select
              label={
                <InlineStack gap="100" blockAlign="center">
                  <span>{t.settings.preferredProvider}</span>
                  <HelpTooltip helpKey="preferredProvider" position="below" />
                </InlineStack>
              }
              options={AI_PROVIDERS}
              value={provider}
              onChange={setProvider}
              helpText={t.settings.providerHelp}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Select
              label={
                <InlineStack gap="100" blockAlign="center">
                  <span>{t.settings.selectedModel}</span>
                  {modelsLoading && <Spinner size="small" />}
                </InlineStack>
              }
              options={availableModels.length > 0 ? availableModels : [{ label: t.settings.modelDefault, value: '' }]}
              value={selectedModel}
              onChange={setSelectedModel}
              disabled={modelsLoading}
              helpText={modelsLoading ? t.settings.loadingModels : t.settings.modelHelp}
            />
          </div>
        </InlineStack>

        {modelsError && (
          <Banner tone="warning" onDismiss={() => setModelsError(null)}>
            <Text as="p" variant="bodySm">{modelsError}</Text>
          </Banner>
        )}

        <div style={{ paddingTop: "1rem", borderTop: "1px solid #e1e3e5" }}>
          <BlockStack gap="400">
            <InlineStack gap="100" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {t.settings.apiKeys}
              </Text>
              <HelpTooltip helpKey="apiKey" position="below" />
            </InlineStack>

            {/* OpenAI */}
            <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">OpenAI</Text>
                <TextField
                  label="API Key"
                  value={openaiKey}
                  onChange={setOpenaiKey}
                  type={showOpenaiKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowOpenaiKey(!showOpenaiKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showOpenaiKey ? HideIcon : ViewIcon} />
                    </button>
                  }
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={openaiMaxTokensPerMinute}
                      onChange={setOpenaiMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
                      value={openaiMaxRequestsPerMinute}
                      onChange={setOpenaiMaxRequestsPerMinute}
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
                  type={showGeminiKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowGeminiKey(!showGeminiKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showGeminiKey ? HideIcon : ViewIcon} />
                    </button>
                  }
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={geminiMaxTokensPerMinute}
                      onChange={setGeminiMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
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
                  type={showClaudeKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowClaudeKey(!showClaudeKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showClaudeKey ? HideIcon : ViewIcon} />
                    </button>
                  }
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={claudeMaxTokensPerMinute}
                      onChange={setClaudeMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
                      value={claudeMaxRequestsPerMinute}
                      onChange={setClaudeMaxRequestsPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                </InlineStack>
              </BlockStack>
            </div>

            {/* Hugging Face */}
            <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Hugging Face</Text>
                <TextField
                  label="API Key"
                  value={huggingfaceKey}
                  onChange={setHuggingfaceKey}
                  type={showHuggingfaceKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowHuggingfaceKey(!showHuggingfaceKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showHuggingfaceKey ? HideIcon : ViewIcon} />
                    </button>
                  }
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={hfMaxTokensPerMinute}
                      onChange={setHfMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
                      value={hfMaxRequestsPerMinute}
                      onChange={setHfMaxRequestsPerMinute}
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
                  type={showGrokKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowGrokKey(!showGrokKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showGrokKey ? HideIcon : ViewIcon} />
                    </button>
                  }
                  helpText={
                    <span>
                      {t.settings.grokHelp}{" "}
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={grokMaxTokensPerMinute}
                      onChange={setGrokMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
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
                  type={showDeepseekKey ? "text" : "password"}
                  autoComplete="off"
                  suffix={
                    <button
                      onClick={() => setShowDeepseekKey(!showDeepseekKey)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                      }}
                      type="button"
                    >
                      <Icon source={showDeepseekKey ? HideIcon : ViewIcon} />
                    </button>
                  }
                  helpText={
                    <span>
                      {t.settings.deepseekHelp}{" "}
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
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxTokensPerMinute}
                          shortText={t.settings.maxTokensPerMinuteShort}
                          helpKey="maxTokensPerMinute"
                        />
                      }
                      value={deepseekMaxTokensPerMinute}
                      onChange={setDeepseekMaxTokensPerMinute}
                      type="number"
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1 }} className="rate-limit-field">
                    <TextField
                      label={
                        <ResponsiveLabel
                          fullText={t.settings.maxRequestsPerMinute}
                          shortText={t.settings.maxRequestsPerMinuteShort}
                          helpKey="maxRequestsPerMinute"
                        />
                      }
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
      </BlockStack>
    </Card>
  );
}

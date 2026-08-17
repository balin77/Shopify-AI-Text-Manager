import { useState, useEffect, useCallback, useRef } from "react";
import type { Translation as I18nTranslation } from "~/i18n/de";
import type { FetcherWithComponents } from "react-router";
import { useInfoBox } from "../contexts/InfoBoxContext";
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
  Link,
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
  // SEO fields are saved via SettingsSEOTab, but still included in full save payload
  seoTitleSuffixEnabled?: boolean;
  seoTitleSuffix?: string;
}

interface SettingsAITabProps {
  settings: Settings;
  fetcher: FetcherWithComponents<any>;
  t: I18nTranslation;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function SettingsAITab({ settings, fetcher, t, onHasChangesChange }: SettingsAITabProps) {
  const { dismissByKey } = useInfoBox();
  // Build per-provider setters that ALSO clear any active "corrupted API
  // key" warning for that provider. The warning is no longer actionable
  // once the merchant starts typing a new key — keeping it around clutters
  // the message bell. Each entry only dismisses its own provider's warning,
  // so a Claude edit doesn't silence an OpenAI warning that still applies.
  const dismissCorruptedFor = (provider: string) => dismissByKey(`corrupted-api-key:${provider}`);

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
  // null = live list from provider API; otherwise the reason we are showing
  // the curated fallback list. Surfaced as a subtle hint under the model
  // dropdown so the merchant understands why the choices are limited.
  const [modelsFallbackReason, setModelsFallbackReason] = useState<null | 'no_api_key' | 'api_error' | 'invalid_key' | 'network'>(null);

  // The model list arrives asynchronously AFTER the page renders, so anything
  // it writes back into state happens without the merchant touching anything.
  // Read the current model through a ref instead of a dependency so the
  // callback stays stable across model changes (a re-created callback would
  // otherwise be a second reason to re-run the fetch effect).
  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  // Fetch available models when provider changes.
  // `restoreModel` is the model a selection that the fetched list does NOT
  // contain falls back to: the SAVED model while the chosen provider is the
  // saved one (so a plain page load never rewrites the stored pair), and
  // null while the merchant is on a different provider (there the provider's
  // own default is the sensible fallback). See the effect below.
  const fetchModels = useCallback(async (providerToFetch: string, restoreModel: string | null) => {
    setModelsLoading(true);
    // Keep the model in effect selectable even when the provider's list does
    // not contain it — otherwise the dropdown would display some other entry
    // while state still holds the stored value.
    const withModel = (options: Array<{ label: string; value: string }>, model: string) => {
      if (!model || options.some(o => o.value === model)) return options;
      return [...options, { label: model, value: model }];
    };
    try {
      const response = await fetch(`/api/ai-models?provider=${providerToFetch}`);
      const data = await response.json();
      if (data.success && data.models) {
        const options: Array<{ label: string; value: string }> = data.models.map((m: { id: string; name: string }) => ({
          label: m.name,
          value: m.id,
        }));
        // A model the list does not offer is replaced — but never with a value
        // that differs from what is stored while the merchant has not changed
        // provider. Doing that on mount marked the form as dirty and lit up the
        // Save button on a page nobody had edited yet.
        const current = selectedModelRef.current;
        if (current && !options.some(o => o.value === current)) {
          const replacement = restoreModel !== null ? restoreModel : (data.defaultModel || '');
          if (replacement !== current) setSelectedModel(replacement);
          setAvailableModels(withModel(options, replacement));
        } else {
          setAvailableModels(options);
        }
        setModelsFallbackReason(data.fromFallback ? (data.reason || 'api_error') : null);
      } else {
        // Endpoint responded with success=false (bad provider / auth). Use
        // built-in curated list and tell the merchant why.
        const fallback = CURATED_MODELS[providerToFetch as AIProvider] || [];
        setAvailableModels(withModel(fallback.map(m => ({ label: m.name, value: m.id })), selectedModelRef.current));
        setModelsFallbackReason('invalid_key');
      }
    } catch {
      const fallback = CURATED_MODELS[providerToFetch as AIProvider] || [];
      setAvailableModels(withModel(fallback.map(m => ({ label: m.name, value: m.id })), selectedModelRef.current));
      setModelsFallbackReason('network');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  // Fetch models on mount and when provider changes. While the selected
  // provider IS the saved one, the saved model is what an unknown selection
  // falls back to — so opening the page (and switching provider back and
  // forth) leaves the stored pair untouched.
  useEffect(() => {
    const onSavedProvider = provider === settings.preferredProvider;
    fetchModels(provider, onSavedProvider ? (settings.selectedModel || '') : null);
  }, [provider, settings.preferredProvider, settings.selectedModel, fetchModels]);

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

  // Field-level validation errors returned from the action. Surfacing them
  // inline next to the offending input is the load-bearing UX fix — the
  // global toast in the top nav was easy to miss, especially when a warn
  // banner stayed visible inside the card.
  const fieldErrors: Record<string, string> =
    fetcher.data && !fetcher.data.success && fetcher.data.actionType === "saveSettings" && fetcher.data.fieldErrors
      ? (fetcher.data.fieldErrors as Record<string, string>)
      : {};
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  // Translate the Zod messages into something a merchant can act on.
  // The format-error string from Zod is generic ("Invalid X API key format");
  // the merchant needs to know it's the *format* that's off (not e.g. wrong key).
  const translateFieldError = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    return (t.settings as unknown as Record<string, string>)?.apiKeyFormatError || raw;
  };

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
    <>
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
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
          {t.settings.aiKeysDescription}{" "}
          <Link url="/privacy" target="_blank">
            {t.settings.privacyPolicyLink}
          </Link>
        </Text>

        {hasFieldErrors && (
          <Banner tone="critical" title={t.products?.saveFailed || "Save failed"}>
            <Text as="p" variant="bodySm">
              {(t.settings as unknown as Record<string, string>)?.apiKeySaveErrorIntro || "Some entries are not in the expected format. The fields with problems are highlighted below — fix them and click Save again."}
            </Text>
          </Banner>
        )}

        {!preferredProviderHasKey && !hasFieldErrors && (
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
              helpText={
                modelsLoading
                  ? t.settings.loadingModels
                  : modelsFallbackReason
                  ? (t.settings as unknown as Record<string, string>)?.[`modelsFallback_${modelsFallbackReason}`] || t.settings.modelHelp
                  : t.settings.modelHelp
              }
            />
          </div>
        </InlineStack>


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
                  onChange={(v) => { setOpenaiKey(v); dismissCorruptedFor("openai"); }}
                  type={showOpenaiKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.openaiApiKey)}
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
                  onChange={(v) => { setGeminiKey(v); dismissCorruptedFor("gemini"); }}
                  type={showGeminiKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.geminiApiKey)}
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
                  onChange={(v) => { setClaudeKey(v); dismissCorruptedFor("claude"); }}
                  type={showClaudeKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.claudeApiKey)}
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
                  onChange={(v) => { setHuggingfaceKey(v); dismissCorruptedFor("huggingface"); }}
                  type={showHuggingfaceKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.huggingfaceApiKey)}
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
                  onChange={(v) => { setGrokKey(v); dismissCorruptedFor("grok"); }}
                  type={showGrokKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.grokApiKey)}
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
                  onChange={(v) => { setDeepseekKey(v); dismissCorruptedFor("deepseek"); }}
                  type={showDeepseekKey ? "text" : "password"}
                  autoComplete="off"
                  error={translateFieldError(fieldErrors.deepseekApiKey)}
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
  </>
  );
}

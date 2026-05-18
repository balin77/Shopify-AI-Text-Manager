import { Banner } from "@shopify/polaris";
import { Link } from "@remix-run/react";
import { hasPreferredProviderKey, hasAnyApiKey, getProviderDisplayName, type AIProvider, type AISettings } from "../utils/api-key-validation";
import { tryDecryptApiKey } from "../utils/encryption.server";
import type { Translation as I18nTranslation } from "~/i18n/de";

interface ApiKeyWarningBannerProps {
  aiSettings: {
    huggingfaceApiKey?: string | null;
    geminiApiKey?: string | null;
    claudeApiKey?: string | null;
    openaiApiKey?: string | null;
    grokApiKey?: string | null;
    deepseekApiKey?: string | null;
    preferredProvider?: string | null;
  } | null;
  t: I18nTranslation;
}

/**
 * Displays a warning banner if the preferred AI provider has no API key configured.
 * Used across product and content pages to inform users about missing API keys.
 */
export function ApiKeyWarningBanner({ aiSettings, t }: ApiKeyWarningBannerProps) {
  if (!aiSettings) {
    return null;
  }

  // Decrypt settings for validation
  const decryptedSettings: AISettings = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings.huggingfaceApiKey, "huggingface"),
    geminiApiKey: tryDecryptApiKey(aiSettings.geminiApiKey, "gemini"),
    claudeApiKey: tryDecryptApiKey(aiSettings.claudeApiKey, "claude"),
    openaiApiKey: tryDecryptApiKey(aiSettings.openaiApiKey, "openai"),
    grokApiKey: tryDecryptApiKey(aiSettings.grokApiKey, "grok"),
    deepseekApiKey: tryDecryptApiKey(aiSettings.deepseekApiKey, "deepseek"),
    preferredProvider: aiSettings.preferredProvider,
  };

  const hasApiKey = hasPreferredProviderKey(decryptedSettings);

  if (hasApiKey) {
    return null;
  }

  const providerName = getProviderDisplayName(
    aiSettings.preferredProvider as AIProvider
  );

  // No key at all anywhere → the merchant first needs to set one up.
  // Otherwise: keys exist, but not for the preferred provider.
  const noKeyAtAll = !hasAnyApiKey(decryptedSettings);

  const title = noKeyAtAll
    ? t.settings?.noApiKeyAtAll || "No AI API key set up yet"
    : t.settings?.preferredProviderNoKey?.replace("{provider}", providerName) ||
      `No API key configured for ${providerName}`;

  const description = noKeyAtAll
    ? t.settings?.noApiKeyAtAllDescription ||
      "To use AI features, you first need to add an API key for an AI provider."
    : t.settings?.configureApiKeyInSettings ||
      "Please configure an API key in Settings to use AI features.";

  return (
    <div style={{ padding: "1rem 1rem 0 1rem" }}>
      <Banner tone="warning">
        <p>
          <strong>{title}</strong>
        </p>
        <p>
          {description}{" "}
          <Link to="/app/settings?tab=ai" style={{ color: "#008060", textDecoration: "underline" }}>
            {t.settings?.manageAiKeys || "Go to Settings"}
          </Link>
        </p>
      </Banner>
    </div>
  );
}

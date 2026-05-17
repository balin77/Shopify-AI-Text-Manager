import { Banner } from "@shopify/polaris";
import { Link } from "@remix-run/react";
import { hasPreferredProviderKey, getProviderDisplayName, type AIProvider, type AISettings } from "../utils/api-key-validation";
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

  return (
    <div style={{ padding: "1rem 1rem 0 1rem" }}>
      <Banner tone="warning">
        <p>
          <strong>
            {t.settings?.preferredProviderNoKey?.replace("{provider}", providerName) ||
              `No API key configured for ${providerName}`}
          </strong>
        </p>
        <p>
          {t.settings?.configureApiKeyInSettings ||
            "Please configure an API key in Settings to use AI features."}{" "}
          <Link to="/app/settings" style={{ color: "#008060", textDecoration: "underline" }}>
            {t.settings?.goToSettings || "Go to Settings"}
          </Link>
        </p>
      </Banner>
    </div>
  );
}

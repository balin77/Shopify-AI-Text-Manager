/**
 * API Key Validation Utilities
 *
 * This module provides utilities to check if AI provider API keys are configured
 * and available for use. Used throughout the app to show warnings when keys are missing.
 */

export interface AISettings {
  huggingfaceApiKey?: string | null;
  geminiApiKey?: string | null;
  claudeApiKey?: string | null;
  openaiApiKey?: string | null;
  grokApiKey?: string | null;
  deepseekApiKey?: string | null;
  preferredProvider?: string | null;
}

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai' | 'grok' | 'deepseek';

/**
 * Check if an API key is configured and not empty
 */
function isKeyConfigured(key: string | null | undefined): boolean {
  return Boolean(key && key.trim().length > 0);
}

/**
 * Check if a specific AI provider has an API key configured
 */
export function hasApiKeyForProvider(settings: AISettings, provider: AIProvider): boolean {
  switch (provider) {
    case 'huggingface':
      return isKeyConfigured(settings.huggingfaceApiKey);
    case 'gemini':
      return isKeyConfigured(settings.geminiApiKey);
    case 'claude':
      return isKeyConfigured(settings.claudeApiKey);
    case 'openai':
      return isKeyConfigured(settings.openaiApiKey);
    case 'grok':
      return isKeyConfigured(settings.grokApiKey);
    case 'deepseek':
      return isKeyConfigured(settings.deepseekApiKey);
    default:
      return false;
  }
}

/**
 * Check if the preferred provider has an API key configured
 */
export function hasPreferredProviderKey(settings: AISettings): boolean {
  const provider = settings.preferredProvider as AIProvider;
  if (!provider) {
    return false;
  }
  return hasApiKeyForProvider(settings, provider);
}

/**
 * Get a list of all providers that have API keys configured
 */
export function getConfiguredProviders(settings: AISettings): AIProvider[] {
  const providers: AIProvider[] = ['huggingface', 'gemini', 'claude', 'openai', 'grok', 'deepseek'];
  return providers.filter(provider => hasApiKeyForProvider(settings, provider));
}

/**
 * Check if at least one AI provider has an API key configured
 */
export function hasAnyApiKey(settings: AISettings): boolean {
  return getConfiguredProviders(settings).length > 0;
}

/**
 * Get the provider name in a human-readable format
 */
export function getProviderDisplayName(provider: AIProvider): string {
  const names: Record<AIProvider, string> = {
    huggingface: 'Hugging Face',
    gemini: 'Google Gemini',
    claude: 'Anthropic Claude',
    openai: 'OpenAI GPT',
    grok: 'Grok (X.AI)',
    deepseek: 'DeepSeek',
  };
  return names[provider] || provider;
}

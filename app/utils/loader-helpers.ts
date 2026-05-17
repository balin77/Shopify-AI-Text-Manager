/**
 * Loader Helper Functions
 *
 * Common utility functions used across multiple route loaders.
 */

import type { PrismaClient } from "@prisma/client";
import { tryDecryptApiKey } from "./encryption.server";

/**
 * Load AI settings for API key validation in loaders.
 * Returns only the necessary fields for checking if API keys are configured.
 * Keys are decrypted server-side and returned as boolean flags for security.
 */
export async function loadAISettingsForValidation(db: PrismaClient, shop: string) {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: {
      huggingfaceApiKey: true,
      geminiApiKey: true,
      claudeApiKey: true,
      openaiApiKey: true,
      grokApiKey: true,
      deepseekApiKey: true,
      preferredProvider: true,
    },
  });

  // Decrypt keys server-side and return only boolean flags. Done per-key so a
  // single undecryptable key (e.g. stale AISettings from a previous install,
  // or an ENCRYPTION_KEY change) only clears that one flag instead of hiding
  // every key — and never throws, so the app keeps working.
  return {
    hasHuggingfaceApiKey: !!tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface"),
    hasGeminiApiKey: !!tryDecryptApiKey(settings?.geminiApiKey, "gemini"),
    hasClaudeApiKey: !!tryDecryptApiKey(settings?.claudeApiKey, "claude"),
    hasOpenaiApiKey: !!tryDecryptApiKey(settings?.openaiApiKey, "openai"),
    hasGrokApiKey: !!tryDecryptApiKey(settings?.grokApiKey, "grok"),
    hasDeepseekApiKey: !!tryDecryptApiKey(settings?.deepseekApiKey, "deepseek"),
    preferredProvider: settings?.preferredProvider || null,
  };
}

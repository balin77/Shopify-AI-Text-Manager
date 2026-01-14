/**
 * Loader Helper Functions
 *
 * Common utility functions used across multiple route loaders.
 */

import type { PrismaClient } from "@prisma/client";
import { decryptApiKey } from "./encryption.server";

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

  // Decrypt keys server-side and return only boolean flags
  // This prevents exposing encrypted keys to the client
  return {
    hasHuggingfaceApiKey: !!decryptApiKey(settings?.huggingfaceApiKey),
    hasGeminiApiKey: !!decryptApiKey(settings?.geminiApiKey),
    hasClaudeApiKey: !!decryptApiKey(settings?.claudeApiKey),
    hasOpenaiApiKey: !!decryptApiKey(settings?.openaiApiKey),
    hasGrokApiKey: !!decryptApiKey(settings?.grokApiKey),
    hasDeepseekApiKey: !!decryptApiKey(settings?.deepseekApiKey),
    preferredProvider: settings?.preferredProvider || null,
  };
}

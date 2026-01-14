/**
 * Loader Helper Functions
 *
 * Common utility functions used across multiple route loaders.
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Load AI settings for API key validation in loaders.
 * Returns only the necessary fields for checking if API keys are configured.
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

  return {
    huggingfaceApiKey: settings?.huggingfaceApiKey || null,
    geminiApiKey: settings?.geminiApiKey || null,
    claudeApiKey: settings?.claudeApiKey || null,
    openaiApiKey: settings?.openaiApiKey || null,
    grokApiKey: settings?.grokApiKey || null,
    deepseekApiKey: settings?.deepseekApiKey || null,
    preferredProvider: settings?.preferredProvider || null,
  };
}

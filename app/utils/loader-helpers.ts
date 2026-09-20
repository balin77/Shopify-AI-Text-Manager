/**
 * Loader Helper Functions
 *
 * Common utility functions used across multiple route loaders.
 */

import type { PrismaClient } from "@prisma/client";
import { tryDecryptApiKey } from "./encryption.server";
import {
  hasCurrentAiProcessingConsent,
  wantsManagedAi,
} from "../services/ai/managed-ai.shared";

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
      // The three that answer "has a working AI source" for a managed shop.
      aiKeySource: true,
      managedAiActive: true,
      aiProcessingConsentAt: true,
      aiProcessingConsentVersion: true,
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
    // §8a rule 6 — "has a working AI source", which for a managed shop is true
    // with no key of its own. Every reader of the six booleans above must ask
    // this first, or a merchant who paid for AI included is told the feature
    // needs a key they do not have to give us.
    managedAiWorking:
      wantsManagedAi(settings ?? null) && hasCurrentAiProcessingConsent(settings ?? null),
    preferredProvider: settings?.preferredProvider || null,
  };
}

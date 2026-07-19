/**
 * Shared types and helpers used by all api.ai action handlers.
 */

import { json } from "@remix-run/node";
import { AIService, toValidProvider, isAuthError } from "../../../src/services/ai.service";
import type { AIProvider } from "../../../src/services/ai.service";
import { getProviderDisplayName } from "../../utils/api-key-validation";
import { getTranslation, type Locale } from "../../i18n";
import { tryDecryptApiKey } from "../../utils/encryption.server";
import {
  PRODUCTS_CONFIG, COLLECTIONS_CONFIG, BLOGS_CONFIG, PAGES_CONFIG, POLICIES_CONFIG,
} from "../../config/content-fields.config";
import type { ContentEditorConfig } from "../../types/content-editor.types";
import type { AISettings, AIInstructions } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import type { SeoLimits } from "../../utils/character-limits";
import { resolveSeoLimits } from "../../utils/character-limits";

// ─── Content type config map ──────────────────────────────────────────────────

export const CONTENT_CONFIGS: Record<string, ContentEditorConfig> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  blogs: BLOGS_CONFIG,
  pages: PAGES_CONFIG,
  policies: POLICIES_CONFIG,
};

export const VALID_CONTENT_TYPES = new Set([
  ...Object.keys(CONTENT_CONFIGS),
  'templates',
  'metaobjects',
]);

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Shape of a single item from Shopify's translatableContent array. */
export interface TranslatableContentItem {
  key: string;
  digest: string;
  value?: string;
}

/** Shape of a Shopify GraphQL response with potential data/errors. */
export interface ShopifyGraphQLResponse {
  data?: {
    translatableResource?: {
      resourceId: string;
      translatableContent: TranslatableContentItem[];
    };
    translationsRegister?: {
      userErrors: Array<{ field?: string; message: string }>;
      translations: Array<{ locale: string; key: string; value: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export type TranslationMode = "exact" | "seo_optimized";

/** Context passed to every action handler. */
export interface AIActionContext {
  session: Session;
  admin: AdminApiContext;
  db: PrismaClient;
  formData: FormData;
  settings: AISettings | null;
  seoTitleMaxChars: number;
  /** Fully-resolved merchant SEO limits (defaults filled in) — same value used
   * across generation, translation, and bulk-fix prompts. */
  seoLimits: SeoLimits;
  /** Merchant translation policy (AISettings.translationMode). "exact" is the
   * default and preserves source length; "seo_optimized" appends per-field
   * character caps to the translate prompt. */
  translationMode: TranslationMode;
  contentType: string;
  itemId: string;
}

/**
 * Read the two SEO knobs off `AISettings` in the same place, so every ctx
 * builder (api.ai.tsx + unified-content.actions.ts) stays consistent.
 */
export function resolveSeoContext(settings: AISettings | null): {
  seoTitleMaxChars: number;
  seoLimits: SeoLimits;
  translationMode: TranslationMode;
} {
  const seoLimits = resolveSeoLimits(
    (settings?.seoLimits ?? null) as Partial<SeoLimits> | null,
  );
  const seoTitleMaxChars =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix
      ? Math.max(1, seoLimits.seoTitleMax - settings.seoTitleSuffix.length)
      : seoLimits.seoTitleMax;
  const translationMode: TranslationMode =
    settings?.translationMode === "seo_optimized" ? "seo_optimized" : "exact";
  return { seoTitleMaxChars, seoLimits, translationMode };
}

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Safely extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Safely extract an error stack from an unknown thrown value. */
export function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/**
 * Re-export so api.ai handlers can detect provider auth failures (invalid key)
 * without each importing from the deep src/ path.
 */
export { isAuthError };

/**
 * Standard 401 response when the merchant's API key was rejected by the
 * provider at call time (key present but invalid/expired). Mirrors
 * {@link noAiKeyResponse} but for the invalid- rather than missing-key case, so
 * the client toast can point the merchant to Settings → AI API Access Codes.
 */
export function aiAuthErrorResponse(error: unknown): Response {
  return json(
    {
      success: false,
      code: "INVALID_AI_KEY",
      error:
        "Your AI API key was rejected by the provider (invalid or expired). " +
        "Please check your API key in Settings → AI API Access Codes.",
      detail: errorMessage(error),
    },
    { status: 401 }
  );
}

/** Check if an unknown error is a Prisma error with a specific code. */
export function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === code
  );
}

// ─── Merchant-key compliance gate ─────────────────────────────────────────────

/** Encrypted-column name on AISettings for each provider. */
const PROVIDER_KEY_FIELD: Record<AIProvider, keyof AISettings> = {
  huggingface: "huggingfaceApiKey",
  gemini: "geminiApiKey",
  claude: "claudeApiKey",
  openai: "openaiApiKey",
  grok: "grokApiKey",
  deepseek: "deepseekApiKey",
};

/**
 * Returns the provider that the shop wants to use but has NOT supplied an own
 * API key for, or `null` when a usable merchant key exists.
 *
 * Decrypts the stored key (DB columns are encrypted, so a raw "is non-empty"
 * check would falsely report a key as present). Used to block AI calls early
 * with an actionable message before any task is created — Shopify PPA/API
 * Terms forbid processing merchant content via a shared/operator key.
 */
export function getMissingPreferredKey(
  settings: AISettings | null
): { provider: AIProvider; displayName: string } | null {
  const provider = toValidProvider(settings?.preferredProvider);
  const encrypted = settings?.[PROVIDER_KEY_FIELD[provider]] as string | null | undefined;
  const decrypted = tryDecryptApiKey(encrypted, provider);
  if (decrypted && decrypted.trim().length > 0) {
    return null;
  }
  return { provider, displayName: getProviderDisplayName(provider) };
}

/**
 * Standard 409 response when the shop has no own API key for its preferred
 * provider. The message is localized via the shop's app language so the
 * existing client-side error toast shows an actionable, translated hint that
 * points the merchant to Settings → AI API Access Codes.
 */
export function noAiKeyResponse(
  settings: AISettings | null,
  missing: { provider: AIProvider; displayName: string }
): Response {
  const t = getTranslation((settings?.appLanguage ?? "en") as Locale);
  const template =
    t.settings.aiKeyMissingBody ??
    "No {provider} API key configured. Add your own AI API key in Settings → AI API Access Codes to use AI features.";
  return json(
    {
      success: false,
      code: "NO_AI_KEY",
      provider: missing.displayName,
      error: template.replace("{provider}", missing.displayName),
    },
    { status: 409 }
  );
}

// ─── AI Service factory ───────────────────────────────────────────────────────

/** Create an AIService instance from shop settings and a task ID. */
export function createAIService(settings: AISettings | null, shop: string, taskId: string): AIService {
  return new AIService(
    toValidProvider(settings?.preferredProvider),
    {
      huggingfaceApiKey: tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface") || undefined,
      geminiApiKey: tryDecryptApiKey(settings?.geminiApiKey, "gemini") || undefined,
      claudeApiKey: tryDecryptApiKey(settings?.claudeApiKey, "claude") || undefined,
      openaiApiKey: tryDecryptApiKey(settings?.openaiApiKey, "openai") || undefined,
      grokApiKey: tryDecryptApiKey(settings?.grokApiKey, "grok") || undefined,
      deepseekApiKey: tryDecryptApiKey(settings?.deepseekApiKey, "deepseek") || undefined,
      selectedModel: settings?.selectedModel || undefined,
    },
    shop,
    taskId
  );
}

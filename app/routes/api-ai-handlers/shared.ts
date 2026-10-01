/**
 * Shared types and helpers used by all api.ai action handlers.
 */

import { data as json } from "react-router";
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
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-api";
import type { SeoLimits } from "../../utils/character-limits";
import { resolveSeoLimits } from "../../utils/character-limits";
import type { DataResponse } from "~/types/data-response";
import { aiServiceFor } from "~/services/ai/ai-credentials.server";
import { AI_REFUSAL_STATUS } from "~/services/ai/managed-ai.shared";

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
  // Menus have no CONTENT_CONFIGS entry — their only translatable field is a
  // menu item's `title`, addressed on its own Link GID rather than through a
  // field config. They reach exactly one action, `translateField`, which is
  // pure (it translates and returns; it persists nothing). The menus page then
  // saves through its own echo-verified path, so this entry widens what may be
  // TRANSLATED, never what may be written.
  'menus',
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
export function aiAuthErrorResponse(error: unknown): DataResponse {
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
): DataResponse {
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

/**
 * The HTTP gate for an AI action — PLAN_MANAGED_AI_KEY §6.
 *
 * Returns a coded refusal response, or `null` when the call may proceed. It
 * replaces the `getMissingPreferredKey` + `noAiKeyResponse` pair at every
 * entry point, because BYO's "you have no key" is now one of FOUR reasons a
 * call can be refused and the other three have nothing to do with keys.
 *
 * **This gate is necessary and nowhere near sufficient**, and the comment is
 * here so nobody mistakes it for the enforcement. It covers the interactive
 * paths only; the heaviest AI consumers in this app — the webhook
 * reconciliation, the nightly drift sweep, the bulk flush — never pass one.
 * The decision that actually bounds spend lives per REQUEST, inside
 * `executeAIRequest`, and this is its early, friendly copy: refusing before a
 * Task row exists is a better merchant experience, not a stronger guarantee.
 *
 * Every code answers the status `AI_REFUSAL_STATUS` assigns it — the map is
 * read rather than restated, or the two drift — and the WORDING comes from the
 * language bundles, shared with the one the Tasks tab renders for the same
 * refusal on a background run. One refusal, one sentence, wherever a merchant
 * meets it.
 */
const MANAGED_REFUSAL_FALLBACK = {
  managedAiBudgetExceeded:
    "The AI volume included in your plan is used up for this period.",
  // §10 — the taster never resets, so it gets the sentence that names the two
  // exits instead of the one that promises a reset.
  managedAiTasterExhausted:
    "Your free AI trial is used up. Add your own API key to continue for free, or choose an AI-included plan.",
  managedAiConsentMissing:
    "AI processing has not been confirmed for this shop. Confirm it in Settings and try again.",
  managedAiUnavailable: "The included AI is temporarily unavailable. Please try again shortly.",
} as const;

function managedRefusalSay(settings: AISettings | null) {
  const t = getTranslation((settings?.appLanguage ?? "en") as Locale);
  return (key: keyof typeof MANAGED_REFUSAL_FALLBACK): string => {
    const value = (t.tasks?.taskErrors as Record<string, unknown> | undefined)?.[key];
    return typeof value === "string" && value.trim() !== ""
      ? value
      : MANAGED_REFUSAL_FALLBACK[key];
  };
}

/**
 * The coded response for a MANAGED refusal — one builder for the up-front
 * gate below AND for a refusal the per-request preflight raises mid-call
 * (`ManagedAiRefusedError`, caught in `api.ai.tsx`). Two builders would come
 * to answer one refusal with two codes.
 *
 * `reason` is the resolver's / preflight's refusal code; anything it does not
 * recognise answers `managedUnavailable` — ours to fix, never the merchant's.
 */
export function managedRefusalResponse(
  reason: string,
  settings: AISettings | null,
  detail?: { usedMicros?: number; limitMicros?: number },
): DataResponse {
  const say = managedRefusalSay(settings);
  const micros =
    detail && (detail.usedMicros != null || detail.limitMicros != null)
      ? { usedMicros: detail.usedMicros, limitMicros: detail.limitMicros }
      : {};
  if (reason === "budgetExceeded" || reason === "tasterExhausted") {
    const taster = reason === "tasterExhausted";
    return json(
      {
        success: false,
        code: taster ? "AI_TASTER_EXHAUSTED" : "AI_BUDGET_EXCEEDED",
        error: say(taster ? "managedAiTasterExhausted" : "managedAiBudgetExceeded"),
        ...micros,
      },
      {
        status: taster
          ? AI_REFUSAL_STATUS.tasterExhausted
          : AI_REFUSAL_STATUS.budgetExceeded,
      },
    );
  }
  if (reason === "consentMissing") {
    return json(
      {
        success: false,
        code: "AI_CONSENT_REQUIRED",
        error: say("managedAiConsentMissing"),
      },
      { status: AI_REFUSAL_STATUS.consentMissing },
    );
  }
  // managedUnavailable — ours to fix, never the merchant's, so the message
  // does not send them anywhere and does not mention a key (§3a rule 9: in
  // managed mode the AI-keys tab is hidden, and pointing at it is nonsense).
  return json(
    {
      success: false,
      code: "AI_TEMPORARILY_UNAVAILABLE",
      error: say("managedAiUnavailable"),
    },
    { status: AI_REFUSAL_STATUS.managedUnavailable },
  );
}

export async function aiRefusalResponse(
  settings: AISettings | null,
  shop: string
): Promise<DataResponse | null> {
  const { resolveAiCredentials, fallBackToOwnKeyIfTasterSpent } = await import(
    "~/services/ai/ai-credentials.server"
  );
  const decision = resolveAiCredentials({ shop, settings });

  if (decision.ok) {
    if (decision.source !== "managed") return null;
    // Managed: the budget is the one question that costs a DB round trip, so
    // it is asked last and only for the shops it can refuse.
    const plan = (settings?.subscriptionPlan ?? "free") as never;
    const { managedBudgetStatus, managedPoolFor } = await import(
      "~/services/ai/managed-budget.server"
    );
    const status = await managedBudgetStatus(shop, settings, plan);
    if (!status.allowed) {
      if (status.unavailable) return managedRefusalResponse("managedUnavailable", settings);
      // §10: a spent taster is STAMPED here too, and a merchant with a key of
      // their own is handed straight back to it. Without this, only the
      // per-request preflight stamped — and it is never reached behind this
      // refusal, so a shop that had added its own key stayed refused for ever.
      const fallback = await fallBackToOwnKeyIfTasterSpent(shop, status);
      if (fallback) {
        // The caller builds its AI service from THIS settings object after the
        // gate. Refresh it in place, or it would still resolve to the managed
        // key and the preflight would refuse the very request this lets
        // through ("left managed mode mid-run" → temporarily unavailable).
        if (settings && fallback.settings) Object.assign(settings, fallback.settings);
        return null;
      }
      return managedRefusalResponse(
        status.kind === "taster" ? "tasterExhausted" : "budgetExceeded",
        settings,
        { usedMicros: status.usedMicros, limitMicros: status.limitMicros },
      );
    }
    // The GLOBAL pool (§9.3) — asked here as well, like the repair pre-check,
    // so an exhausted outer ring refuses before a Task row exists instead of
    // on the first provider call. Its refusal is `managedUnavailable`: the
    // merchant has budget left.
    const { globalPoolStatus } = await import("~/services/ai/managed-global-pool.server");
    const pool = await globalPoolStatus(managedPoolFor(shop, settings, plan));
    if (!pool.allowed) return managedRefusalResponse("managedUnavailable", settings);
    return null;
  }

  if (decision.reason === "noKey") {
    return noAiKeyResponse(settings, {
      provider: decision.provider,
      displayName: getProviderDisplayName(decision.provider),
    });
  }

  return managedRefusalResponse(
    decision.reason,
    settings,
    "usedMicros" in decision
      ? { usedMicros: decision.usedMicros, limitMicros: decision.limitMicros }
      : undefined,
  );
}

// ─── AI Service factory ───────────────────────────────────────────────────────

/**
 * Create an AIService instance from shop settings and a task ID.
 *
 * A thin wrapper over the credential resolver since PLAN_MANAGED_AI_KEY §5:
 * whose key the call spends is one module's answer, and this signature stays
 * only because a dozen handlers call it.
 */
export function createAIService(settings: AISettings | null, shop: string, taskId: string): AIService {
  return aiServiceFor(settings, shop, taskId).service;
}

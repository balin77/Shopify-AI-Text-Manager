/**
 * WHOSE key an AI call spends — the only module in this app that reads a
 * `MANAGED_AI_*` variable. PLAN_MANAGED_AI_KEY §5.
 *
 * That exclusivity is the compliance guarantee, not tidiness. The audit's §B4
 * permits an operator key only behind an explicit, logged consent gate, and a
 * credential that can be obtained ONLY together with its gate cannot be
 * obtained past it. `ai.service.ts` never learns that `process.env` exists;
 * the key is injected into its config by this function or not at all.
 * `tests/unit/ai-key-source-isolation.test.ts` is what keeps that true.
 *
 * Resolution order, and each step is a decision someone could get wrong:
 *
 *   1. The MODE comes from the verified subscription (`managedAiActive`,
 *      mirrored by `checkAndSyncSubscription`) AND the merchant's stored
 *      choice (`aiKeySource`) — never from a form field, never from the
 *      client. Same rule as `subscriptionPlan`.
 *   2. A MERCHANT key wins whenever the merchant has one and asked for it.
 *      Managed mode does not delete BYO keys and BYO keys do not disable a
 *      managed subscription; the stored choice decides, which is what makes
 *      "I hit the cap" one click rather than a support ticket.
 *   3. CONSENT is checked in managed mode only, before anything is spent.
 *   4. BUDGET is checked last, because it is the only step that costs a DB
 *      round trip.
 *
 * Everything here is deliberately cheap to call: it runs PER AI REQUEST,
 * including on detached paths that hold no admin client and no session.
 */

import type { AISettings } from "@prisma/client";
import type { BillingPlan } from "../../config/billing";
import type { AIProvider } from "../../utils/api-key-validation";
import { tryDecryptApiKey } from "../../utils/encryption.server";
import { logger } from "../../utils/logger.server";
import { UNPRICED_PROVIDERS } from "../../config/ai-pricing";
import { managedBudgetPeriod } from "./usage-meter.server";
// §7a "belt and braces": the operator key must never be served from the
// dev/custom-app build. IMPORTED rather than re-derived — the local copy read
// `process.env.DEV_APP_CLIENT_ID`, which is not an environment variable
// anywhere in this repo (the id is a constant in that module), so it was
// always false and this guard never fired.
import { isDevAppBuild } from "../dev-plan-override.server";
import { AIService, toValidProvider, type AIServiceConfig } from "../../../src/services/ai.service";
import { type AiCredentialSource } from "./usage-dimensions.shared";
import {
  hasCurrentAiProcessingConsent,
  wantsManagedAi,
  type AiRefusalCode,
} from "./managed-ai.shared";

/** Which encrypted column holds which provider's merchant key. */
const PROVIDER_KEY_FIELD: Record<AIProvider, keyof AISettings & string> = {
  huggingface: "huggingfaceApiKey",
  gemini: "geminiApiKey",
  claude: "claudeApiKey",
  openai: "openaiApiKey",
  grok: "grokApiKey",
  deepseek: "deepseekApiKey",
};

export type ManagedRole = "default" | "failover";

export type AiCredentialDecision =
  | {
      ok: true;
      source: "byo";
      provider: AIProvider;
      config: AIServiceConfig;
    }
  | {
      ok: true;
      source: "managed";
      provider: AIProvider;
      model: string;
      role: ManagedRole;
      config: AIServiceConfig;
    }
  | { ok: false; reason: "noKey"; provider: AIProvider }
  | { ok: false; reason: "consentMissing" }
  | { ok: false; reason: "budgetExceeded"; usedMicros: number; limitMicros: number }
  | { ok: false; reason: "managedUnavailable" };

export type AiCredentialRefusal = Extract<AiCredentialDecision, { ok: false }>;

/** Narrowing helper — `reason` is what every caller switches on. */
export function isRefusal(d: AiCredentialDecision): d is AiCredentialRefusal {
  return d.ok === false;
}

export function refusalCode(d: AiCredentialRefusal): AiRefusalCode {
  return d.reason;
}

// ─── The operator credential ─────────────────────────────────────────────────

interface ManagedCredential {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

/**
 * Is managed mode switched on for this deployment at all?
 *
 * OPT-IN, not opt-out: an unset variable means OFF. §9.4 describes the kill
 * switch as `MANAGED_AI_ENABLED=false`, and reading it that way — off only
 * when explicitly false — would turn managed mode on in every environment that
 * has a key configured and no opinion about the flag, which includes anyone
 * restoring a production env file into a staging box.
 */
export function isManagedAiEnabled(): boolean {
  return process.env.MANAGED_AI_ENABLED === "true";
}

/**
 * The operator credential for one role. Provider, model and key are read as a
 * UNIT and a partial configuration yields NOTHING: the failover crosses
 * providers, so a model or a key that belongs to a different provider than the
 * one named is a request sent to the wrong endpoint with somebody else's
 * secret in the header.
 */
export function readManagedCredential(role: ManagedRole): ManagedCredential | null {
  const prefix = role === "failover" ? "MANAGED_AI_FALLBACK_" : "MANAGED_AI_";
  const rawProvider = process.env[`${prefix}PROVIDER`];
  const model = process.env[`${prefix}MODEL`];
  const apiKey = process.env[`${prefix}API_KEY`];
  if (!rawProvider || !model || !apiKey) return null;

  // `toValidProvider` falls back to 'claude' for anything it does not
  // recognise, which is the right default for a merchant's stored preference
  // and the WRONG one here: it would pair an unknown provider's key with
  // Anthropic's endpoint. An unrecognised name is a misconfiguration.
  const provider = toValidProvider(rawProvider);
  if (provider !== rawProvider) {
    logger.error(
      `[ManagedAI] ${prefix}PROVIDER is "${rawProvider}", which is not a known provider — this credential is ignored.`,
    );
    return null;
  }
  // An UNPRICED provider cannot be a managed one, and this is a budget rule
  // before it is a compliance one. `priceCall` answers 0 for a provider with
  // no per-token list price, so the ledger's `billedMicros` never moves, the
  // remaining budget never falls and managed spend is UNCAPPED — the one
  // configuration that makes every gate in this module decorative. (§2 rule 3
  // disqualifies HuggingFace for a second, independent reason: no contractual
  // no-training default.)
  if (UNPRICED_PROVIDERS.has(provider)) {
    logger.error(
      `[ManagedAI] ${prefix}PROVIDER is "${provider}", which this app cannot price — a managed budget over it could never be enforced. This credential is ignored.`,
    );
    return null;
  }
  return { provider, model, apiKey };
}

/** Put the operator key in the one config slot its provider reads. */
function configFor(cred: ManagedCredential, settings: AISettings | null): AIServiceConfig {
  const config: AIServiceConfig = {
    selectedModel: cred.model,
    credentialSource: "managed",
    // The meter must WRITE under the key the budget is READ under. Written as
    // a calendar month and read as a billing period, the used figure is
    // always zero and the cap never fires.
    usagePeriod: managedBudgetPeriod(settings?.managedAiPeriodEnd ?? null),
  };
  (config as Record<string, unknown>)[PROVIDER_KEY_FIELD[cred.provider] as string] = cred.apiKey;
  return config;
}

/**
 * Is managed mode available at all in this deployment? Kill switch, dev-build
 * guard and a configured default credential — the three questions that have
 * nothing to do with which shop is asking.
 */
export function managedAiAvailable(): boolean {
  if (!isManagedAiEnabled()) return false;
  if (isDevAppBuild()) {
    logger.warn("[ManagedAI] Refusing to serve an operator key from a dev/custom app build.");
    return false;
  }
  return readManagedCredential("default") !== null;
}

// ─── The merchant credential ─────────────────────────────────────────────────

/** Every merchant key the shop has stored, decrypted, for the AIService config. */
export function byoConfig(settings: AISettings | null): AIServiceConfig {
  return {
    huggingfaceApiKey: tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(settings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(settings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(settings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(settings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(settings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: settings?.selectedModel || undefined,
    credentialSource: "byo",
  };
}

/**
 * The provider the shop wants but has no key for, or null when a usable
 * merchant key exists. Decrypts, because the column is encrypted and a
 * non-empty check would report a corrupt value as a key.
 */
export function missingMerchantKey(settings: AISettings | null): AIProvider | null {
  const provider = toValidProvider(settings?.preferredProvider);
  const stored = settings
    ? (settings as Record<string, unknown>)[PROVIDER_KEY_FIELD[provider]]
    : null;
  const decrypted = tryDecryptApiKey(stored as string | null | undefined, provider);
  return decrypted && decrypted.trim().length > 0 ? null : provider;
}

// ─── The decision ────────────────────────────────────────────────────────────

export interface ResolveArgs {
  shop: string;
  settings: AISettings | null;
  /**
   * Which managed credential to use. The BREAKER decides this (§3a rule 5),
   * never a caller — it is a parameter here only so the failover has a seam to
   * pass through when it ships. Phase 1 always resolves the default.
   */
  role?: ManagedRole;
}

/**
 * Whose key does this shop's next AI call spend?
 *
 * Never throws: a refusal is a value, because two of its four reasons reach a
 * DETACHED repair, where an exception is indistinguishable from "the AI could
 * not deliver this entry" — and that, on a shop with auto-translate on, is a
 * `translationsRemove` plus a local delete (§6a rule 1). A refusal that can be
 * inspected is what lets that path ABORT instead.
 */
export function resolveAiCredentials(args: ResolveArgs): AiCredentialDecision {
  const { settings, role = "default" } = args;

  // 1 + 2. Mode. Both halves are required, and neither comes from the client.
  if (!wantsManagedAi(settings)) {
    const missing = missingMerchantKey(settings);
    if (missing) return { ok: false, reason: "noKey", provider: missing };
    return {
      ok: true,
      source: "byo",
      provider: toValidProvider(settings?.preferredProvider),
      config: byoConfig(settings),
    };
  }

  // The shop asked for managed and Shopify verified it bought it. Everything
  // below is a reason we still cannot serve it.
  if (!managedAiAvailable()) return { ok: false, reason: "managedUnavailable" };

  // 3. Consent, before anything is spent.
  if (!hasCurrentAiProcessingConsent(settings)) return { ok: false, reason: "consentMissing" };

  // Read ONCE. Asking three times re-read the environment on every AI request
  // and, on a misconfigured provider name, logged the same error twice per
  // call.
  const roleCred = readManagedCredential(role);
  const cred = roleCred ?? readManagedCredential("default");
  if (!cred) return { ok: false, reason: "managedUnavailable" };

  // 4. Budget is NOT decided here — it is a DB round trip and belongs to the
  // caller that can afford one (§6). This function stays synchronous and
  // free so it can run on every detached path.
  return {
    ok: true,
    source: "managed",
    provider: cred.provider,
    model: cred.model,
    role: roleCred ? role : "default",
    config: configFor(cred, settings),
  };
}

/** The ledger dimension for a decision — `managed` or `byo`, never guessed. */
export function sourceOf(decision: AiCredentialDecision): AiCredentialSource | null {
  return decision.ok ? decision.source : null;
}

/**
 * The `(provider, config)` pair an `AIService` is constructed from, for a
 * caller that cannot (yet) act on a refusal.
 *
 * Every AI path in this app used to build that pair itself — ten copies of the
 * same six decrypt lines — which is what made "the operator key has one
 * reader" impossible to state. They all call this instead, and the decision is
 * handed back with it so a caller that CAN refuse does so on the code rather
 * than on a thrown error.
 *
 * What a refusal produces is the load-bearing part:
 *
 * - `noKey` yields the merchant's (empty) config, so `initializeProvider`
 *   throws `MissingAIKeyError` exactly as it does today. Nothing changes for a
 *   shop that never configured a key.
 * - A MANAGED refusal (`consentMissing`, `managedUnavailable`) yields a config
 *   with NO key at all, so the call fails instead of quietly falling back to
 *   the merchant's own key. A shop that asked for managed AI and has not
 *   consented must not have its own credential spent on its behalf — and a
 *   silent fallback would also make the consent gate unobservable, which is
 *   the one property §B4 is satisfied by.
 */
export interface AiRuntimeCredentials {
  provider: AIProvider;
  config: AIServiceConfig;
  decision: AiCredentialDecision;
}

export function aiCredentialsFor(
  settings: AISettings | null,
  shop: string,
  role: ManagedRole = "default",
): AiRuntimeCredentials {
  const decision = resolveAiCredentials({ shop, settings, role });
  if (decision.ok) {
    return {
      provider: decision.provider,
      config:
        decision.source === "managed"
          ? { ...decision.config, preflight: managedPreflight(shop, settings) }
          : decision.config,
      decision,
    };
  }

  const provider = toValidProvider(settings?.preferredProvider);
  if (decision.reason === "noKey") {
    return { provider, config: byoConfig(settings), decision };
  }
  // Managed was asked for and cannot be served. The config carries the REASON
  // rather than simply lacking a key: a keyless config makes
  // `initializeProvider` throw `MissingAIKeyError`, which is a different error
  // meaning a different thing — and the detached repair's purge path does not
  // recognise it, so a refusal would have been recorded as "the AI could not
  // deliver" and DELETED the merchant's translations. With the marker the
  // service builds (no client, no key) and every call on it throws the one
  // error that means "stand down".
  return {
    provider,
    config: { credentialSource: "managed", managedRefusal: decision.reason },
    decision,
  };
}

/**
 * An `AIService` for a shop, built through the resolver — THE factory.
 *
 * Every construction site in the app goes through this or through
 * `aiCredentialsFor` above, which is what makes §5's guarantee ("no
 * `AIServiceConfig` literal outside the resolver") checkable rather than
 * aspirational. The decision travels back so a caller that can refuse does so
 * on the code; a caller that cannot gets today's behaviour, because the
 * refusal has already been turned into a config that fails at
 * `initializeProvider`.
 */
export function aiServiceFor(
  settings: AISettings | null,
  shop: string,
  taskId?: string,
  role: ManagedRole = "default",
): { service: AIService; decision: AiCredentialDecision } {
  const creds = aiCredentialsFor(settings, shop, role);
  return {
    service: new AIService(creds.provider, creds.config, shop, taskId),
    decision: creds.decision,
  };
}

/**
 * The per-REQUEST gate installed on every managed AIService.
 *
 * It is asked before each provider call rather than once per service instance
 * because a bulk run holds one instance for hundreds of calls — a budget
 * checked at construction is a budget checked before the spend it bounds. The
 * HTTP gates are the early, friendly copy of the same question; the heaviest
 * consumers in this app (webhooks, the drift sweep, the bulk flush) never pass
 * one (§6a).
 *
 * It re-reads the SHOP's settings on every call, not just the environment, and
 * that is the difference between the comment and the code the first cut
 * shipped: closing over the settings loaded at construction meant a merchant
 * who withdrew consent, cancelled, or downgraded went on spending the operator
 * key for the rest of a bulk run — hours, on the one flag that makes managed
 * mode legal at all. It is one indexed read beside an aggregate this function
 * already makes, against a call that takes seconds.
 *
 * A failed read keeps the credential the service was BUILT with rather than
 * refusing: the resolver already granted it once, and answering a database
 * blink with a refusal would abort a repair (§6a) over nothing.
 */
function managedPreflight(
  shop: string,
  built: AISettings | null,
): NonNullable<AIServiceConfig["preflight"]> {
  return async () => {
    let settings = built;
    try {
      const { db } = await import("../../db.server");
      settings = await db.aISettings.findUnique({ where: { shop } });
    } catch {
      // Keep `built` — see above.
    }
    const decision = resolveAiCredentials({ shop, settings });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (decision.source !== "managed") {
      // The shop moved off managed mid-run. Nothing to bound: the merchant's
      // own key is not ours to cap.
      return { ok: true };
    }

    const { managedBudgetStatus } = await import("./managed-budget.server");
    const plan = (settings?.subscriptionPlan ?? "free") as BillingPlan;
    const status = await managedBudgetStatus(shop, settings, plan);
    if (status.allowed) return { ok: true };
    return {
      ok: false,
      reason: "budgetExceeded",
      usedMicros: status.usedMicros,
      limitMicros: status.limitMicros,
    };
  };
}

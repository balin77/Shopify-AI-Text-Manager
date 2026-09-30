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
 *   1. The MODE is the merchant's stored choice (`aiKeySource`). Since §10's
 *      taster it is that choice ALONE: a Free shop has no managed
 *      subscription by definition, so gating the mode on the verified one put
 *      the acquisition grant out of reach of the only population it is for.
 *      The verified half (`managedAiActive`, mirrored by
 *      `checkAndSyncSubscription` and settable by nobody else) moved down to
 *      the only thing it ever protected — the SIZE of the budget, in
 *      `periodBudgetMicros`. A shop that did not buy the variant gets the
 *      taster, once, ever.
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
import {
  managedPeriodKey,
  managedPoolFor,
} from "./managed-budget.server";
import { tasterActionsFor, tasterBudgetMicros } from "../../config/managed-ai-budget";
// §7a "belt and braces": the operator key must never be served from the
// dev/custom-app build. IMPORTED rather than re-derived — the local copy read
// `process.env.DEV_APP_CLIENT_ID`, which is not an environment variable
// anywhere in this repo (the id is a constant in that module), so it was
// always false and this guard never fired.
import { isDevAppBuild } from "../dev-plan-override.server";
import { AIService, toValidProvider, type AIServiceConfig } from "../../../src/services/ai.service";
import { type AiCredentialSource } from "./usage-dimensions.shared";
import {
  boughtManagedAi,
  hasCurrentAiProcessingConsent,
  wantsManagedAi,
  type AiRefusalCode,
} from "./managed-ai.shared";

/**
 * Which config field (and encrypted column) holds which provider's key.
 *
 * Exported because the smoke test builds a config too and had grown its own
 * derivation of this — a no-op ternary that agreed today and would have gone
 * quietly wrong in the one probe whose job is to notice a misconfigured
 * credential.
 */
export const PROVIDER_KEY_FIELD: Record<AIProvider, keyof AISettings & string> = {
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
  | { ok: false; reason: "tasterExhausted"; usedMicros: number; limitMicros: number }
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
function configFor(
  cred: ManagedCredential,
  settings: AISettings | null,
  shop: string,
): AIServiceConfig {
  const plan = (settings?.subscriptionPlan ?? "free") as BillingPlan;
  const config: AIServiceConfig = {
    selectedModel: cred.model,
    credentialSource: "managed",
    // The meter must WRITE under the key the budget is READ under. Written as
    // a calendar month and read as a billing period — or as a billing period
    // and read as the taster — the used figure is always zero and the cap
    // never fires. `managedPeriodKey` is the ONE function both sides ask.
    usagePeriod: managedPeriodKey(shop, settings, plan),
    // The meter must record against the pool the preflight checked, or the
    // cap is measured over a different number than it enforces.
    usagePool: managedPoolFor(shop, settings, plan),
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

/**
 * What the one-time taster (§10) is worth in this deployment, in micro-euro.
 *
 * DERIVED from the default credential's model, which is why it lives here: the
 * grant is expressed in AI actions and enforced in money, and only this module
 * is allowed to know which model those actions would run on. A deployment that
 * serves no managed AI grants nothing — zero, so the budget check refuses
 * rather than handing out an uncapped grant against a model it cannot price.
 */
export function managedTasterLimitMicros(): number {
  if (!managedAiAvailable()) return 0;
  const cred = readManagedCredential("default");
  if (!cred) return 0;
  return tasterBudgetMicros(cred.provider, cred.model);
}

/**
 * The same grant expressed in AI ACTIONS — what the Settings card says, and
 * the only half of it a merchant can reason about. It is `MANAGED_AI_TASTER_ACTIONS`
 * at the default model and fewer at a dearer one, because the ladder ceiling
 * shrinks the actions rather than bending (§10).
 */
export function managedTasterActions(): number {
  if (!managedAiAvailable()) return 0;
  const cred = readManagedCredential("default");
  if (!cred) return 0;
  return tasterActionsFor(cred.provider, cred.model);
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

  // The shop's stored choice says managed. Everything below is a reason we
  // cannot serve it — and each one asks the same question afterwards: does
  // this merchant still have a key of their own?
  //
  // That fallback is the half §10 nearly cost. Before the taster,
  // `wantsManagedAi` was false for a shop whose AI-included plan ENDED, so it
  // went straight back to its own key — which `checkAndSyncSubscription`
  // documents as the designed behaviour, and which is why cancelling never
  // deletes a stored key. With the mode now decided by the stored choice
  // alone, that shop would have sat in managed mode with a spent taster and a
  // perfectly good credential nothing ever reached.
  if (!managedAiAvailable()) return managedUnavailableOrByo(settings);

  // 3. Consent, before anything is spent. No fallback here: a merchant who
  // has not answered the question has not asked for their own key either, and
  // silently spending it would make the consent gate unobservable — which is
  // the one property §B4 is satisfied by.
  if (!hasCurrentAiProcessingConsent(settings)) return { ok: false, reason: "consentMissing" };

  // The TASTER is spent and this shop never bought the variant. Synchronous,
  // from a column, because this function runs on every detached path and
  // cannot afford the aggregate that established the fact. The stamp is
  // written by the preflight; the ledger row is what really enforces it.
  if (!boughtManagedAi(settings) && settings?.managedAiTasterSpentAt != null) {
    const missing = missingMerchantKey(settings);
    if (!missing) {
      return {
        ok: true,
        source: "byo",
        provider: toValidProvider(settings?.preferredProvider),
        config: byoConfig(settings),
      };
    }
    return { ok: false, reason: "tasterExhausted", usedMicros: 0, limitMicros: 0 };
  }

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
    config: {
      ...configFor(cred, settings, args.shop),
      // §3a rule 8 — the seam the switch goes through. `ai.service.ts` never
      // reads `process.env`, so the second credential is handed over by the
      // one module that holds it, on demand and not before.
      switchToFailover: async () => {
        const fallback = readManagedCredential("failover");
        if (!fallback) return null;
        if (fallback.provider === cred.provider && fallback.model === cred.model) return null;
        return {
          provider: fallback.provider,
          config: {
            ...configFor(fallback, settings, args.shop),
            // Rule 1: the merchant's budget is debited at the DEFAULT model's
            // price whatever ran.
            defaultModelForBilling: cred.model,
            defaultProviderForBilling: cred.provider,
          },
        };
      },
    },
  };
}

/**
 * Managed cannot be served — the merchant's own key if they have one, the
 * refusal otherwise.
 *
 * It is `managedUnavailable` and not a silent nothing, because the two states
 * read differently to a merchant: one says "use your key meanwhile", the
 * other says "this is ours to fix".
 */
function managedUnavailableOrByo(settings: AISettings | null): AiCredentialDecision {
  const missing = missingMerchantKey(settings);
  if (missing) return { ok: false, reason: "managedUnavailable" };
  return {
    ok: true,
    source: "byo",
    provider: toValidProvider(settings?.preferredProvider),
    config: byoConfig(settings),
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
 * One conditional write for the taster's two stamps. Never throws: the budget
 * has already been checked and the merchant's generation is about to run, so
 * a bookkeeping failure may not fail it.
 *
 * The `where` carries the same null condition as the read that decided to
 * write, so two concurrent calls cannot both claim the same stamp.
 */
async function stampTaster(
  shop: string,
  data: Record<string, unknown>,
  guard: Record<string, null>,
): Promise<void> {
  try {
    const { db } = await import("../../db.server");
    await db.aISettings.updateMany({ where: { shop, ...guard }, data: data as never });
  } catch (error) {
    logger.warn(
      `[ManagedAI] Could not stamp the taster for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
    let settingsAreFresh = false;
    try {
      const { db } = await import("../../db.server");
      settings = await db.aISettings.findUnique({ where: { shop } });
      settingsAreFresh = true;
    } catch {
      // Keep `built` — see above.
    }
    const decision = resolveAiCredentials({ shop, settings });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (decision.source !== "managed") {
      // The shop moved off managed MID-RUN — cancelled, withdrew consent, or
      // spent the last of its taster. This used to answer "nothing to bound,
      // the merchant's own key is not ours to cap", which describes the wrong
      // service: the one this gate is installed on is holding the OPERATOR's
      // credential and will go on spending it for the rest of a bulk run.
      // Refusing is the safe direction on both counts — the spend stops, and
      // a detached repair treats a managed refusal as an ABORT (§6a rule 1)
      // rather than as "the AI could not deliver", so nothing is deleted. The
      // next run resolves to the merchant's own key by itself.
      logger.warn(
        `[ManagedAI] ${shop} left managed mode mid-run — standing the operator credential down.`,
      );
      return { ok: false, reason: "managedUnavailable" };
    }

    const { managedBudgetStatus } = await import("./managed-budget.server");
    const plan = (settings?.subscriptionPlan ?? "free") as BillingPlan;
    const status = await managedBudgetStatus(shop, settings, plan);
    if (!status.allowed) {
      // A SPENT taster is stamped, so the synchronous resolver can hand the
      // shop back to its own key from the next call rather than refusing
      // every one of them for ever. Only on fresh settings: a stale snapshot
      // would write the stamp against a row whose grant may have moved.
      if (status.kind === "taster" && settingsAreFresh && settings?.managedAiTasterSpentAt == null) {
        await stampTaster(shop, { managedAiTasterSpentAt: new Date() }, {
          managedAiTasterSpentAt: null,
        });
      }
      return {
        // A spent TASTER is its own refusal (§10): it never resets, so the
        // period sentence would send a free shop to wait for a reset that
        // cannot come instead of to the two exits it really has.
        ok: false,
        reason: status.unavailable
          ? "managedUnavailable"
          : status.kind === "taster"
            ? "tasterExhausted"
            : "budgetExceeded",
        usedMicros: status.usedMicros,
        limitMicros: status.limitMicros,
      };
    }

    // The GLOBAL pool (§9.3) — the outer ring. Per-shop budgets bound what one
    // merchant can cost us; they do not bound what a BUG can, and this makes
    // the worst case one configured month rather than an unbounded invoice.
    // Its refusal is `managedUnavailable`, not `budgetExceeded`: the merchant
    // has budget left, so telling them they are out of volume would be a lie
    // and would send them to buy more of something we cannot serve.
    const { globalPoolStatus, alertIfPoolLow } = await import("./managed-global-pool.server");
    // The pool's own period, NOT `status.period` — see `globalPoolPeriod`.
    const poolStatus = await globalPoolStatus(managedPoolFor(shop, settings, plan));
    alertIfPoolLow(poolStatus);
    if (!poolStatus.allowed) return { ok: false, reason: "managedUnavailable" };

    // The taster has been ENTERED. Stamped here and nowhere else: this is the
    // last gate before a real provider call, so the date describes a grant the
    // shop actually began spending rather than one it was shown in Settings.
    //
    // The DATE is a record — the ledger row under the `taster` key is the
    // enforcement, and it is permanent. What is not merely a record is the
    // frozen WORTH beside it: the limit is derived from the managed default
    // model's price, so without freezing it here an ops change of model
    // re-grants a second taster to every shop that has spent its first.
    //
    // Gated on a FRESH settings read: writing this against a snapshot whose
    // read failed would stamp a row we cannot see, and re-issue a no-op
    // update before every provider call for the rest of the run.
    if (
      status.kind === "taster" &&
      settingsAreFresh &&
      settings?.managedAiTasterGrantedAt == null
    ) {
      await stampTaster(
        shop,
        {
          managedAiTasterGrantedAt: new Date(),
          managedAiTasterMicros: Math.min(status.limitMicros, 2_147_483_647),
        },
        { managedAiTasterGrantedAt: null },
      );
    }

    return { ok: true };
  };
}

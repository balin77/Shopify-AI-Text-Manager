/**
 * What both ends of managed mode have to agree on — PLAN_MANAGED_AI_KEY §5, §2.
 *
 * Client-safe and import-free by design: the Settings UI renders the mode
 * switch and the consent box, the server decides them, and neither may import
 * the other's module. Everything here is a constant or a pure predicate; the
 * credential itself lives in `ai-credentials.server.ts` and nowhere else.
 */

import { type AiCredentialSource } from "./usage-dimensions.shared";

/**
 * The version of the consent text. BUMP IT the day a managed sub-processor
 * changes — a merchant who consented to two named providers has not consented
 * to a third, and §2 rule 1 makes re-asking the mechanism rather than a
 * promise. The stored value is compared for EQUALITY, not ordering: a
 * downgrade of the text is still a different text.
 */
export const AI_PROCESSING_CONSENT_VERSION = "2026-09-20.2";

/**
 * The sub-processors the consent text NAMES, and the reason it has to.
 *
 * §2 requires consent naming the sub-processor, and §3a extends it to BOTH
 * managed providers from the first managed call: a second company that first
 * appears during an outage is not one anybody consented to. The first cut of
 * the text said "our AI providers", which is a version constant re-asking
 * everybody about wording that never told them what changed.
 *
 * Stated here rather than read from `MANAGED_AI_PROVIDER`, because the two
 * answer different questions: the env names what a deployment runs, this
 * names what a merchant agreed to. They are kept in step by hand, and by the
 * rule that bumping either means bumping the version above.
 */
export const AI_SUB_PROCESSORS = ["OpenAI", "Anthropic"] as const;

/**
 * The provider ids the consent above covers — the SAME two companies, spelled
 * the way `MANAGED_AI_PROVIDER` spells them. The resolver refuses any other
 * provider for a managed credential: a config change to a "cheaper model"
 * must not quietly send every consented merchant's content to a company the
 * text they agreed to never named. Extending this list is a consent change
 * and bumps `AI_PROCESSING_CONSENT_VERSION` (mirrored in validate-env.js).
 */
export const CONSENTED_MANAGED_PROVIDERS: readonly string[] = ["openai", "claude"];

/**
 * Why a managed AI call was refused. These travel to the client as codes —
 * the app ships in three languages and the wording lives in the bundles.
 *
 * `noKey` is today's 409 and is BYO's refusal; the other four are managed
 * mode's. Every one of them is an ABORT for a detached repair (§6a rule 1,
 * §3a rule 5), never "the AI could not deliver this entry" — that distinction
 * is the difference between a refused save and a deleted translation.
 *
 * `tasterExhausted` is `budgetExceeded`'s twin and is deliberately NOT folded
 * into it: a period budget comes back next month and the taster (§10) never
 * does, so one sentence cannot serve both. Telling a free shop its volume is
 * "used up for this period" sends it to wait for a reset that will not happen,
 * instead of to the two real exits — its own key, free and unlimited, or the
 * AI-included price of its tier.
 */
export const AI_REFUSAL_CODES = [
  "noKey",
  "consentMissing",
  "budgetExceeded",
  "tasterExhausted",
  "managedUnavailable",
] as const;

export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

/** HTTP status each refusal answers with, where one is answered at all. */
export const AI_REFUSAL_STATUS: Record<AiRefusalCode, number> = {
  noKey: 409,
  consentMissing: 409,
  budgetExceeded: 402,
  tasterExhausted: 402,
  managedUnavailable: 503,
};

/**
 * Is a stored `aiKeySource` value one we know?
 *
 * An unrecognised value reads as "byo": the column is a merchant CHOICE and
 * the safe reading of a choice we cannot parse is the one that spends the
 * merchant's own key, never ours.
 */
export function toAiKeySource(value: unknown): AiCredentialSource {
  return value === "managed" ? "managed" : "byo";
}

/**
 * Has Shopify VERIFIED that this shop bought the AI-included variant?
 *
 * Only `checkAndSyncSubscription` writes `managedAiActive`; a merchant can set
 * `aiKeySource` and nothing else. What this now decides is the SIZE of the
 * budget (`periodBudgetMicros`) and the plan-facing wording — not whether
 * managed mode may be entered at all, which is the next predicate.
 */
export function boughtManagedAi(settings: {
  managedAiActive?: boolean | null;
} | null): boolean {
  return settings?.managedAiActive === true;
}

/** The encrypted key column each provider's key lives in — presence only;
 *  this module is client-safe and never decrypts. */
const OWN_KEY_COLUMN: Record<string, string> = {
  huggingface: "huggingfaceApiKey",
  gemini: "geminiApiKey",
  claude: "claudeApiKey",
  openai: "openaiApiKey",
  grok: "grokApiKey",
  deepseek: "deepseekApiKey",
};

/**
 * Does the shop hold a key of its own for the provider it chose?
 *
 * Presence of the stored (encrypted) value — the resolver's
 * `missingMerchantKey` additionally decrypts, so a corrupted key reads as
 * "has one" here and as missing there; the merchant then gets the existing
 * "your key could not be read" answer rather than a managed one.
 */
export function hasOwnKeyStored(settings: Record<string, unknown> | null): boolean {
  if (!settings) return false;
  const provider = typeof settings.preferredProvider === "string" ? settings.preferredProvider : "";
  const column = OWN_KEY_COLUMN[provider] ?? OWN_KEY_COLUMN.claude;
  const value = settings[column];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Is this shop on managed AI? Decided by the PLAN — the merchant no longer
 * switches it (the owner's decision, 2026-10-01: "allein durch die Pläne").
 *
 *  - A verified AI-included subscription (`managedAiActive`, written only by
 *    the billing sync) ⇒ managed, whether or not a key of its own is stored.
 *    Its consent is still required — the resolver refuses without it rather
 *    than silently spending a key the merchant did not choose.
 *  - Otherwise the merchant's OWN key, wherever one is stored.
 *  - Otherwise — no plan with AI, no key — the one-time TASTER (§10), but
 *    only once the merchant has CONFIRMED the processing notice: that
 *    confirmation is the opt-in to the trial. Without it the shop stays on
 *    the old "add an API key" path instead of being told to confirm
 *    something it never asked for.
 *
 * `aiKeySource` is no longer read; the column stays only because dropping a
 * possibly-applied migration is the riskier error.
 */
export function wantsManagedAi(settings: Record<string, unknown> | null): boolean {
  if (!settings) return false;
  if (settings.managedAiActive === true) return true;
  if (hasOwnKeyStored(settings)) return false;
  return hasCurrentAiProcessingConsent(
    settings as { aiProcessingConsentAt?: Date | string | null; aiProcessingConsentVersion?: string | null },
  );
}

/**
 * Has this shop given the current consent?
 *
 * Absent version, absent timestamp, or a version that is not the current one
 * all mean NO. The last case is the point: a new sub-processor makes the old
 * consent describe something else.
 */
export function hasCurrentAiProcessingConsent(settings: {
  aiProcessingConsentAt?: Date | string | null;
  aiProcessingConsentVersion?: string | null;
} | null): boolean {
  if (!settings?.aiProcessingConsentAt) return false;
  return settings.aiProcessingConsentVersion === AI_PROCESSING_CONSENT_VERSION;
}

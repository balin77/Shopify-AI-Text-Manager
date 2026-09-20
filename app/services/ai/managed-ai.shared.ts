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
export const AI_PROCESSING_CONSENT_VERSION = "2026-09-20.1";

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

/**
 * May this shop's stored choice of "managed" be honoured?
 *
 * It is the merchant's stored choice ALONE, and that widening is what §10's
 * taster costs. Requiring the verified subscription here — which is what this
 * did until Phase 4 — makes the one grant an evaluating shop is offered before
 * it buys anything unreachable by exactly the population it exists for: a Free
 * shop has no managed subscription by definition.
 *
 * Nothing is given away by the move, because the verified half did not go
 * missing, it went DOWN. `periodBudgetMicros` grants a plan's monthly volume
 * only to a shop that bought the variant; everyone else falls to the taster,
 * which is worth cents and is once per shop ever. A merchant who posts
 * `aiKeySource=managed` without buying therefore gets precisely what they
 * would have been offered anyway — and still only after consent (§2), still
 * against the taster pool and the global cap (§9).
 */
export function wantsManagedAi(settings: {
  aiKeySource?: string | null;
} | null): boolean {
  return toAiKeySource(settings?.aiKeySource) === "managed";
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

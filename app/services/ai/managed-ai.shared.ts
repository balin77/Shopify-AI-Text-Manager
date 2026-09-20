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
 */
export const AI_REFUSAL_CODES = [
  "noKey",
  "consentMissing",
  "budgetExceeded",
  "managedUnavailable",
] as const;

export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

/** HTTP status each refusal answers with, where one is answered at all. */
export const AI_REFUSAL_STATUS: Record<AiRefusalCode, number> = {
  noKey: 409,
  consentMissing: 409,
  budgetExceeded: 402,
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
 * May this shop's stored choice of "managed" be honoured?
 *
 * Both halves are required and they answer different questions: `aiKeySource`
 * is what the merchant asked for, `managedAiActive` is what Shopify verified
 * they bought. A merchant can set the first; only `checkAndSyncSubscription`
 * writes the second.
 */
export function wantsManagedAi(settings: {
  aiKeySource?: string | null;
  managedAiActive?: boolean | null;
} | null): boolean {
  return toAiKeySource(settings?.aiKeySource) === "managed" && settings?.managedAiActive === true;
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

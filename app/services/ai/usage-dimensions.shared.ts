/**
 * The dimensions the AI ledger is keyed by that more than one side must agree
 * on — PLAN_MANAGED_AI_KEY §4.
 *
 * Its own client-safe module because the sides may not import each other: the
 * meter writes these into `AiUsageCounter` (server), `AIService` supplies them
 * per call (server), the credential resolver decides the source (server), and
 * the Settings UI renders which one a shop is on (client). A union or a
 * sentinel restated in any of those places is the drift this repo has paid for
 * before.
 */

/** Whose key paid for a call. */
export const AI_CREDENTIAL_SOURCES = ["managed", "byo"] as const;

export type AiCredentialSource = (typeof AI_CREDENTIAL_SOURCES)[number];

export function isAiCredentialSource(value: unknown): value is AiCredentialSource {
  return AI_CREDENTIAL_SOURCES.includes(value as AiCredentialSource);
}

/**
 * The `feature` of a call that belongs to no `Task` — an interactive editor
 * generation, or a path that runs without task tracking. A named constant
 * rather than an empty string, because "no task" and "we failed to look the
 * task up" must not both read as a blank column.
 */
export const ADHOC_FEATURE = "adhoc";

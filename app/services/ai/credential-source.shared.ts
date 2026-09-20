/**
 * Whose key paid for an AI call — the second axis of PLAN_MANAGED_AI_KEY.
 *
 * Its own module, and client-safe, because three sides have to agree on the
 * same two strings and none of them may import the others: the meter writes it
 * into `AiUsageCounter.source` (server), the credential resolver decides it
 * (server), and the Settings UI renders which one a shop is on (client). A
 * union restated in any of those places is the drift this repo has paid for
 * before.
 */

export const AI_CREDENTIAL_SOURCES = ["managed", "byo"] as const;

export type AiCredentialSource = (typeof AI_CREDENTIAL_SOURCES)[number];

export function isAiCredentialSource(value: unknown): value is AiCredentialSource {
  return AI_CREDENTIAL_SOURCES.includes(value as AiCredentialSource);
}

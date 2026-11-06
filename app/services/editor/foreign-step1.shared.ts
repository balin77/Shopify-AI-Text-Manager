/**
 * Step 1 of a FOREIGN accept-and-translate is the accepted text saved in its own
 * language; the AI translation into the other languages starts only AFTER that
 * save is CONFIRMED. The server stores every other foreign language it
 * translates at once, so a step 1 that was refused (plan limit, Shopify
 * refusal), left its field unconfirmed or never answered must not have been
 * accompanied by a translation of a text that does not exist in its language.
 *
 * Client-safe and import-free.
 */

/** How step 1's save ended, for the flow waiting on it. */
export type Step1Result = "saved" | "refused" | "unconfirmed";

export interface ForeignStep1Flow {
  /** true = answered and confirmed, false = refused or unconfirmed, null = not answered yet. */
  saved: boolean | null;
  step2: object | null;
  undo?: () => void;
  done?: boolean;
  /** Set while the AI translation waits for step 1: the answer handlers call it exactly once. */
  onSettled?: (result: Step1Result) => void;
}

/**
 * The longest the translation waits for step 1's answer. Past it nothing is
 * translated (a late answer is ignored): a save whose answer never arrives
 * (a send that threw, an abort) must fail CLOSED, not translate on a guess.
 */
export const FOREIGN_STEP1_DEADLINE_MS = 120_000;

/**
 * An ANSWERED step 1 counts as confirmed only if none of the fields it carried
 * is among the ones Shopify did not echo back (`unconfirmedClearedFieldSet`).
 */
export function step1AnswerResult(
  carriedFieldKeys: Iterable<string>,
  unconfirmed: ReadonlySet<string>,
): Step1Result {
  for (const key of carriedFieldKeys) if (unconfirmed.has(key)) return "unconfirmed";
  return "saved";
}

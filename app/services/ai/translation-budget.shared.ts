/**
 * How much translation fits in ONE AI request — the single place that answers it.
 *
 * Every batched translation path in this app asks the same question: may these
 * fields × these languages go in one call, or must they be split? The answer is
 * a property of the OUTPUT, not of the source: the providers are run with a
 * fixed `max_tokens`, and a response that exceeds it is TRUNCATED, which every
 * caller here then rejects wholesale (`assertNestedComplete`, the array-length
 * check in `translateBatchValues`). So the cost of getting this wrong is not a
 * slow run, it is a failed one.
 *
 * ── Why the number is not "the context window" ──────────────────────────────
 * `AI_MAX_OUTPUT_TOKENS` is the OUTPUT cap, and it is small. The merchant picks
 * the model ([ai-models.config.ts](../../config/ai-models.config.ts)), the list
 * spans six providers, and the floor is low: `gpt-4-turbo` caps output at 4096,
 * `deepseek-chat` and `gemini-*-flash` at 8192, and a HuggingFace endpoint can
 * be lower still. The app sends ONE `max_tokens` to all of them, so the budget
 * here has to hold for the weakest model a merchant can select — raising it is
 * a per-provider capability question, not a constant to tune.
 *
 * ── Why the estimate is in CHARACTERS ───────────────────────────────────────
 * Nothing on this path has a tokenizer (that would mean a provider round trip
 * per decision), so characters are the proxy, and the conversion is deliberately
 * pessimistic — `TRANSLATION_BATCH.CHARS_PER_OUTPUT_TOKEN`, which says why.
 *
 * ── Why locale COUNT is the other half ──────────────────────────────────────
 * The answer is a product, never a length: one request returns EVERY requested
 * language, so a 6 000-character body is 6 000 × 1.3 × 8 ≈ 62 000 characters of
 * output on an eight-language shop and comfortably one call on a two-language
 * one. A rule that only looked at the text length would split a short field
 * across eight requests and let a medium one truncate.
 */

import { TRANSLATION_BATCH } from "~/config/constants";

/**
 * The usable output budget of ONE request, in characters of translated text.
 *
 * `CHUNK_THRESHOLD_CHARS` already IS that number — derived in
 * [constants.ts](../../config/constants.ts) from the provider cap, the
 * pessimistic characters-per-token rate and the structural reserve. This is a
 * name for it, so the rest of this module reads as what it means and the
 * arithmetic stays in the one place that owns the numbers.
 */
export function outputBudgetChars(): number {
  return TRANSLATION_BATCH.CHUNK_THRESHOLD_CHARS;
}

/** Estimated characters of output for `sourceChars` translated into `localeCount` languages. */
export function estimateOutputChars(sourceChars: number, localeCount: number): number {
  return Math.ceil(sourceChars * Math.max(1, localeCount) * TRANSLATION_BATCH.OUTPUT_EXPANSION_FACTOR);
}

/** Does this whole payload fit in one request? */
export function fitsOneRequest(sourceChars: number, localeCount: number): boolean {
  return estimateOutputChars(sourceChars, localeCount) <= outputBudgetChars();
}

/**
 * How many locales of `sourceChars` fit in one request — at least ONE, because
 * a single locale that does not fit is a different problem (the caller splits
 * the FIELDS, or falls back to a per-field path) and answering `0` would make
 * the chunk loop produce no chunks at all and silently translate nothing.
 */
export function localesPerRequest(sourceChars: number): number {
  const perLocale = estimateOutputChars(sourceChars, 1);
  if (perLocale <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(outputBudgetChars() / perLocale));
}

/**
 * `locales` split into the groups that each fit one request.
 *
 * THE hybrid rule, in one function: a short payload comes back as a single group
 * holding every language, a long one as one group per language, and the middle —
 * a medium text on a many-language shop, which is the case that silently
 * truncated — as groups of two or three. Callers get the same shape either way,
 * so none of them needs an `if (isLong)` of its own.
 */
export function planLocaleChunks(locales: string[], sourceChars: number): string[][] {
  const perChunk = localesPerRequest(sourceChars);
  if (perChunk >= locales.length) return locales.length > 0 ? [locales] : [];
  const chunks: string[][] = [];
  for (let i = 0; i < locales.length; i += perChunk) chunks.push(locales.slice(i, i + perChunk));
  return chunks;
}

/**
 * The source-character ceiling for ONE locale's worth of a request.
 *
 * What a caller splitting FIELDS needs: a group of fields whose combined source
 * stays under this translates into one locale without truncating, which is the
 * precondition `planLocaleChunks` above assumes.
 */
export function perLocaleSourceBudgetChars(): number {
  return Math.floor(outputBudgetChars() / TRANSLATION_BATCH.OUTPUT_EXPANSION_FACTOR);
}

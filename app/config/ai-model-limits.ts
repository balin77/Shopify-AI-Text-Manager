/**
 * How many OUTPUT tokens one request may ask a model for -- the sibling of
 * ai-pricing.ts, with the same rule: an UNKNOWN model gets the cautious answer.
 *
 * Every provider call in this app has always been sent `max_tokens = 8192`
 * (TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS), a number chosen for the weakest
 * model a merchant can select. The packaged translate run (PLAN_BULK_TRANSLATE_
 * BATCHING 3.2) needs the real ceiling per model, but the picker is fed live
 * from the providers' model lists, so a merchant can choose ANY id and this
 * table cannot know them all. Hence the default is the OLD value (8192), never
 * higher: a too-high assumption is a truncated answer, a too-low one only a
 * smaller package.
 *
 * The values are RESEARCH STATE (LIMITS_CHECKED_ON), not measurements this repo
 * can re-check from the build sandbox; they are meant to be re-checked against
 * the providers' documentation together with the price table. They are
 * deliberately round and on the low side.
 *
 * Client-safe: imports nothing.
 */

export const LIMITS_CHECKED_ON = "2026-11-12";

/** What an unknown model gets: the historic app-wide `max_tokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface LimitRule {
  provider: string;
  /** Matched against the lower-cased model id. */
  match: RegExp;
  tokens: number;
  /** Where the number comes from (documentation page, date) -- every entry says. */
  source: string;
}

const RULES: LimitRule[] = [
  { provider: "claude", match: /^claude-(sonnet|haiku|opus)-[4-9]/, tokens: 32_000, source: "Anthropic models overview, 4.x family (research state 2026-11-12)" },
  { provider: "claude", match: /^claude-3-haiku/, tokens: 4096, source: "Anthropic models overview (research state 2026-11-12)" },
  { provider: "claude", match: /^claude-3-5-/, tokens: 8192, source: "Anthropic models overview (research state 2026-11-12)" },
  { provider: "openai", match: /^gpt-4-turbo/, tokens: 4096, source: "OpenAI model page (research state 2026-11-12)" },
  { provider: "openai", match: /^gpt-4o/, tokens: 16_384, source: "OpenAI model page (research state 2026-11-12)" },
  { provider: "openai", match: /^gpt-4\.1/, tokens: 32_000, source: "OpenAI model page (research state 2026-11-12)" },
  { provider: "openai", match: /^(gpt-5|o3|o4)/, tokens: 32_000, source: "OpenAI model page; reasoning tokens count against it (research state 2026-11-12)" },
  { provider: "gemini", match: /^gemini-2\.5-/, tokens: 32_000, source: "Google model page, 65 536 documented, halved on purpose (research state 2026-11-12)" },
  { provider: "gemini", match: /^gemini-2\.0-/, tokens: 8192, source: "Google model page (research state 2026-11-12)" },
  { provider: "deepseek", match: /^deepseek-chat/, tokens: 8192, source: "DeepSeek API docs (research state 2026-11-12)" },
];

/**
 * The output-token ceiling to plan against for `model` on `provider`.
 * Unknown provider, unknown model, empty id: DEFAULT_MAX_OUTPUT_TOKENS.
 */
export function maxOutputTokensFor(provider: string | undefined | null, model: string | undefined | null): number {
  const id = (model ?? "").toLowerCase().trim();
  if (!provider || !id) return DEFAULT_MAX_OUTPUT_TOKENS;
  for (const rule of RULES) {
    if (rule.provider === provider && rule.match.test(id)) return rule.tokens;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Test seam: every rule carries a source and a positive number. */
export function modelLimitRules(): ReadonlyArray<Readonly<LimitRule>> {
  return RULES;
}

/**
 * Prompt caching on the package path (PLAN_BULK_TRANSLATE_BATCHING 3.5): a
 * cache marker is only sent when the stable prefix reaches this many tokens.
 * Anthropic's documented minimum is model-dependent (about 1024 to 4096); NOT
 * measured here, so the cautious end is used for every model -- below the real
 * minimum a marker is silently ignored, so too high only forgoes a saving.
 */
export const PACKAGE_CACHE_MIN_PREFIX_TOKENS = 4096;

/** A group needs at least this many packages before a cache WRITE amortises. */
export const PACKAGE_CACHE_MIN_GROUP_PACKAGES = 3;

/**
 * Gemini 2.5 models THINK before they answer, and the thinking tokens count
 * against `maxOutputTokens`. The installed `@google/generative-ai` (0.24.1) has
 * no `thinkingConfig` in its typings, so thinking cannot be switched off; a
 * package request instead gets this allowance ON TOP of its own ceiling (capped
 * at the model's), so the answer is not cut off by thinking. Only package calls
 * of Gemini 2.5 models are SENT with it; the estimate adds it to the output of
 * every Gemini 2.5 request, package and per-row (thinking is billed as output).
 * Research state, not measured.
 */
export const GEMINI_THINKING_ALLOWANCE_TOKENS = 4096;

export function geminiThinkingAllowanceTokens(
  provider: string | undefined | null,
  model: string | undefined | null,
): number {
  return provider === "gemini" && /^gemini-2\.5-/.test((model ?? "").toLowerCase().trim())
    ? GEMINI_THINKING_ALLOWANCE_TOKENS
    : 0;
}

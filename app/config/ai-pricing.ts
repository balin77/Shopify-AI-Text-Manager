/**
 * What one AI call COSTS — the one place that knows.
 *
 * Until this existed the app could not answer "what does a generation cost",
 * and it still cannot answer it from `estimateTokens`: that helper feeds the
 * rate limiter, charges a flat 8192 output tokens for every call, and is an
 * order of magnitude above a typical completion. The provider SDKs return the
 * real numbers and `_executeAIRequestInner` discarded them.
 *
 * Two rules the numbers here obey, and both are about the direction of error:
 *
 * - **An unknown model is priced at a STATED per-provider ceiling**, not at
 *   zero, not at an average, and — the correction that matters — not at the
 *   most expensive entry of this table either. Deriving the ceiling from the
 *   table makes it a ceiling only if the table already holds the provider's
 *   dearest model, which it does not and is not meant to: this app's own
 *   picker offers `claude-opus-4-0-20250514` ($15/$75), while the dearest
 *   Claude entry here is $5/$25 — so a merchant on that model was metered at
 *   a third of what they spent, under a log line reassuring us it had been
 *   "priced at the ceiling". `UNKNOWN_MODEL_PRICE` is therefore its own dated
 *   fact per provider, deliberately at or above that provider's most
 *   expensive public model, and a table entry can never silently outgrow it.
 * - **Money is integer MICRO-EURO.** No floats (this is money), and no BigInt
 *   ANYWHERE in this module: it is imported by client-safe code and its values
 *   travel through `JSON.stringify`, which throws on a BigInt — the trap
 *   `entry.server.tsx`'s `describeError` already documents. A single CALL is
 *   far inside Int32; the accumulating LEDGER columns are not, which is a
 *   question for the store and not for this table (see
 *   `app/services/ai/usage-meter.server.ts`).
 *
 * Prices are provider LIST prices in USD per 1M tokens, converted here. They
 * are dated facts, not measurements this repo can re-check — the ops re-check
 * that owns them is named in docs/plans/PLAN_MANAGED_AI_KEY.md §13.
 */

import type { AIProvider } from "../utils/api-key-validation";

/**
 * USD → EUR. A constant that must exist the moment prices are stored in euro,
 * so it is named and dated rather than baked invisibly into every table entry.
 * Re-checked with the price table.
 */
export const USD_PER_EUR = 1.08;
export const PRICES_CHECKED_ON = "2026-09-17";

/** Micro-euro per 1M tokens, derived from a USD list price. */
function usdPerMTokenToMicros(usd: number): number {
  return Math.round((usd / USD_PER_EUR) * 1_000_000);
}

export interface ModelPrice {
  /** Micro-euro per 1M INPUT tokens. */
  inMicrosPerMToken: number;
  /** Micro-euro per 1M OUTPUT tokens. */
  outMicrosPerMToken: number;
}

function price(usdIn: number, usdOut: number): ModelPrice {
  return {
    inMicrosPerMToken: usdPerMTokenToMicros(usdIn),
    outMicrosPerMToken: usdPerMTokenToMicros(usdOut),
  };
}

/**
 * Known list prices (USD per 1M tokens, in the comments).
 *
 * Deliberately NOT exhaustive: a merchant on their own key may pick any model
 * the provider offers, and `priceForModel` prices an unknown one at the
 * provider's ceiling rather than refusing. Entries exist for what this app
 * defaults to, what it curates, and the two models the managed mode pins.
 */
export const MODEL_PRICING: Record<AIProvider, Record<string, ModelPrice>> = {
  openai: {
    "gpt-5-nano": price(0.05, 0.4),
    "gpt-5-mini": price(0.25, 2.0),
    "gpt-4o-mini": price(0.15, 0.6),
    "gpt-4o": price(2.5, 10.0),
    "gpt-4-turbo": price(10.0, 30.0),
    "o3-mini": price(1.1, 4.4),
  },
  claude: {
    "claude-haiku-4-5": price(1.0, 5.0),
    "claude-3-5-haiku-20241022": price(0.8, 4.0),
    "claude-sonnet-4-5-20250929": price(3.0, 15.0),
    "claude-sonnet-5": price(2.0, 10.0),
    "claude-opus-5": price(5.0, 25.0),
    // Offered by the app's own picker (app/config/ai-models.config.ts), which
    // is why its absence was not academic.
    "claude-opus-4-0-20250514": price(15.0, 75.0),
  },
  gemini: {
    "gemini-2.0-flash-lite": price(0.075, 0.3),
    "gemini-2.0-flash": price(0.1, 0.4),
    "gemini-1.5-flash": price(0.075, 0.3),
    "gemini-1.5-pro": price(1.25, 5.0),
  },
  grok: {
    "grok-3-mini": price(0.3, 0.5),
    "grok-3": price(3.0, 15.0),
    "grok-2-vision-1212": price(2.0, 10.0),
    // Also in the app's picker; priced at grok-3's rate it read ~15x high.
    "grok-4-fast-non-reasoning": price(0.2, 0.5),
  },
  deepseek: {
    "deepseek-chat": price(0.27, 1.1),
    "deepseek-flash": price(0.3, 1.2),
    "deepseek-reasoner": price(0.55, 2.19),
  },
  // HuggingFace Inference is billed per compute-second on a subscription, not
  // per token, so there is no list price to put here. Its calls are METERED
  // (tokens are still counted and stored) and priced at zero, which is stated
  // rather than silently true: a shop on HuggingFace sees its token volume and
  // an explicit "not priced" rather than a wrong euro figure.
  huggingface: {},
};

/** Providers whose usage is counted but deliberately not priced. */
export const UNPRICED_PROVIDERS: ReadonlySet<AIProvider> = new Set(["huggingface"]);

/** Int32 ceiling — the sanity bound for ONE call's value, not for a total. */
export const MAX_MICROS = 2_147_483_647;

export interface PricedUsage {
  costMicros: number;
  /** True when the model was unknown and the provider's ceiling was used. */
  pricedAtCeiling: boolean;
  /** True when the provider carries no per-token price at all. */
  unpriced: boolean;
}

/**
 * What an UNKNOWN model of each provider is priced at.
 *
 * A stated fact per provider — the provider's most expensive public model as
 * of PRICES_CHECKED_ON — and NOT the maximum of the table above. The two are
 * different questions: the table holds what this app defaults to and curates,
 * while this holds what the provider's dearest offering costs, which is the
 * only number that makes "unknown ⇒ ceiling" a real bound. `api.ai-models.tsx`
 * fetches each provider's model list LIVE, so a merchant is not restricted to
 * the curated ids and an unknown id is an ordinary Tuesday.
 *
 * `assertCeilingsCoverTable` (tests) fails the build if a table entry ever
 * exceeds its provider's ceiling on either dimension — which is what keeps
 * the word "ceiling" true as models are added.
 */
export const UNKNOWN_MODEL_PRICE: Record<AIProvider, ModelPrice | null> = {
  openai: price(15.0, 60.0), // gpt-4.5-class list price
  claude: price(15.0, 75.0), // Opus tier
  gemini: price(2.5, 15.0), // 2.5 Pro, long-context tier
  grok: price(5.0, 25.0), // grok-4 reasoning tier
  deepseek: price(1.0, 4.0), // reasoner tier, with headroom
  // No per-token list price exists at all — see UNPRICED_PROVIDERS.
  huggingface: null,
};

export function priceForModel(
  provider: AIProvider,
  model: string,
): { price: ModelPrice | null; atCeiling: boolean } {
  // The unpriced set is asked FIRST and is authoritative. It used to be
  // declared and never consulted, with "the provider's record is empty" doing
  // the real work — two expressions of one rule, which drift the day somebody
  // adds a single price entry to an unpriced provider.
  if (UNPRICED_PROVIDERS.has(provider)) return { price: null, atCeiling: false };
  const known = MODEL_PRICING[provider]?.[model];
  if (known) return { price: known, atCeiling: false };
  return { price: UNKNOWN_MODEL_PRICE[provider], atCeiling: true };
}

/**
 * Cost of one call in micro-euro, ROUNDED UP.
 *
 * Rounding up is the same rule the estimate follows: a fraction of a
 * micro-euro is noise, and the direction that errs cheap is the one that
 * understates a bill.
 */
export function priceCall(
  provider: AIProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): PricedUsage {
  const { price: p, atCeiling } = priceForModel(provider, model);
  if (!p) {
    return { costMicros: 0, pricedAtCeiling: false, unpriced: true };
  }
  const micros =
    (Math.max(0, inputTokens) * p.inMicrosPerMToken) / 1_000_000 +
    (Math.max(0, outputTokens) * p.outMicrosPerMToken) / 1_000_000;
  return {
    costMicros: clampMicros(Math.ceil(micros)),
    pricedAtCeiling: atCeiling,
    unpriced: false,
  };
}

/**
 * Keep a micro-euro value integral and non-negative.
 *
 * It CEILS, like `priceCall`, and the two saying opposite things two screens
 * apart is the drift this note replaces: rounding to nearest turned a billed
 * 0.4 µ€ into 0, i.e. free, which is the one direction this module's whole
 * comment header forbids. The `MAX_MICROS` cap is about a single value being
 * sane, not about what a stored TOTAL can hold — that is the store's problem
 * and the store solves it with a wider column.
 */
export function clampMicros(micros: number): number {
  if (!Number.isFinite(micros) || micros < 0) return 0;
  return Math.min(Math.ceil(micros), MAX_MICROS);
}

/** "€1.23" from micro-euro — display only, never used for arithmetic. */
export function formatMicrosAsEur(micros: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(micros / 1_000_000);
}

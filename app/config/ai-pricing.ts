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
 * - **An unknown model is priced at its provider's most expensive entry**, not
 *   at zero and not at an average. A model id we do not know is usually a NEW
 *   one, and the cheap direction is the one that hides a cost explosion.
 * - **Money is integer MICRO-EURO.** No floats (this is money), and no BigInt:
 *   the logger and the Task paths run their values through `JSON.stringify`,
 *   which throws on a BigInt — a trap `entry.server.tsx`'s `describeError`
 *   already documents. Int32 tops out at €2,147 per counter row, far past any
 *   monthly shop total, and `clampMicros` says so rather than wrapping.
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

/** Int32 ceiling for a stored micro-euro column. */
export const MAX_MICROS = 2_147_483_647;

export interface PricedUsage {
  costMicros: number;
  /** True when the model was unknown and the provider's ceiling was used. */
  pricedAtCeiling: boolean;
  /** True when the provider carries no per-token price at all. */
  unpriced: boolean;
}

/**
 * The most expensive known price of a provider — what an UNKNOWN model costs.
 * A provider with no entries at all yields null (see UNPRICED_PROVIDERS).
 */
function ceilingFor(provider: AIProvider): ModelPrice | null {
  const entries = Object.values(MODEL_PRICING[provider] ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((worst, p) =>
    p.inMicrosPerMToken + p.outMicrosPerMToken >
    worst.inMicrosPerMToken + worst.outMicrosPerMToken
      ? p
      : worst,
  );
}

export function priceForModel(
  provider: AIProvider,
  model: string,
): { price: ModelPrice | null; atCeiling: boolean } {
  const known = MODEL_PRICING[provider]?.[model];
  if (known) return { price: known, atCeiling: false };
  return { price: ceilingFor(provider), atCeiling: true };
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

/** Keep a micro-euro value inside the Int32 column it is stored in. */
export function clampMicros(micros: number): number {
  if (!Number.isFinite(micros) || micros < 0) return 0;
  return Math.min(Math.round(micros), MAX_MICROS);
}

/** "€1.23" from micro-euro — display only, never used for arithmetic. */
export function formatMicrosAsEur(micros: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(micros / 1_000_000);
}

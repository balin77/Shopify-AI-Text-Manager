/**
 * CLIENT-SAFE part of the keyword-distribution service: batch-plan and
 * cost-preview math (PLAN_KEYWORDS_EXPANSION.md §5.4). Split out of
 * keyword-distribution.service.ts because the keywords tab renders the cost
 * preview in the browser, while the service proper imports the prompt
 * sanitizer → logger.server and must stay server-only. No imports here —
 * keep it that way.
 */

/** Rough token estimates the batch plan + cost preview are built on. */
export const TOKENS_PER_KEYWORD = 8;
export const TOKENS_PER_ITEM = 320; // title + ~300-token snippet
export const PROMPT_OVERHEAD_TOKENS = 500;
export const OUTPUT_TOKENS_PER_ITEM = 100; // response JSON scales with items

export const DEFAULT_ITEMS_PER_BATCH = 15;
const MIN_ITEMS_PER_BATCH = 3;
/** Conservative per-call input budget (well under every provider's context). */
export const MODEL_INPUT_BUDGET_TOKENS = 100_000;

/**
 * Items per LLM call: starts at DEFAULT_ITEMS_PER_BATCH and shrinks when the
 * full keyword list would blow the per-call input budget (plan §5.4 — with
 * >300 keywords the batch size sinks automatically).
 */
export function computeItemsPerBatch(keywordCount: number): number {
  const budgetForItems =
    MODEL_INPUT_BUDGET_TOKENS - keywordCount * TOKENS_PER_KEYWORD - PROMPT_OVERHEAD_TOKENS;
  const fitting = Math.floor(budgetForItems / TOKENS_PER_ITEM);
  return Math.max(MIN_ITEMS_PER_BATCH, Math.min(DEFAULT_ITEMS_PER_BATCH, fitting));
}

export interface DistributionCostEstimate {
  batches: number;
  inputTokens: number;
  outputTokens: number;
  /** Rough USD estimate. MUST include output tokens — they are the more
   *  expensive share of this task (plan §5.4 Randfälle). */
  usd: number;
}

// Claude Sonnet-class pricing as the reference point ($/MTok). The preview is
// a rough guard against surprises, not a bill — a different provider changes
// the constant, not the shape.
const USD_PER_INPUT_MTOK = 3;
const USD_PER_OUTPUT_MTOK = 15;

/** Pure pre-computation for the modal's cost preview — no network call. */
export function estimateDistributionCost(
  keywordCount: number,
  itemCount: number,
): DistributionCostEstimate {
  if (itemCount <= 0 || keywordCount <= 0) {
    return { batches: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  }
  const perBatch = computeItemsPerBatch(keywordCount);
  const batches = Math.ceil(itemCount / perBatch);
  const inputTokens =
    batches * (keywordCount * TOKENS_PER_KEYWORD + PROMPT_OVERHEAD_TOKENS) +
    itemCount * TOKENS_PER_ITEM;
  const outputTokens = itemCount * OUTPUT_TOKENS_PER_ITEM;
  const usd =
    (inputTokens / 1_000_000) * USD_PER_INPUT_MTOK + (outputTokens / 1_000_000) * USD_PER_OUTPUT_MTOK;
  return { batches, inputTokens, outputTokens, usd: Math.round(usd * 100) / 100 };
}

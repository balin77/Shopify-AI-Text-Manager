/**
 * AI keyword distribution (PLAN_KEYWORDS_EXPANSION.md §5.4).
 *
 * Assigns the keywords of a SeoKeywordGroup to store items via batched LLM
 * calls: every call sees ALL keywords of the group plus ONE chunk of items and
 * proposes primary/secondary assignments as JSON. No embedding pipeline — for
 * the typical store (50–300 products) the batch approach is cheaper and
 * simpler (plan §10 non-goal). Everything here except the actual LLM call is
 * pure and unit-testable; the detached task runner lives in
 * app/routes/api-ai-handlers/keyword-distribution.handler.ts.
 */

import { stripHtml } from "../../utils/seo-score";
import { sanitizePromptInput } from "../../utils/prompt-sanitizer";

export interface DistributionKeyword {
  keyword: string; // normalized (lowercased, single-spaced)
  locale: string;
  priority: number; // 1 high / 2 medium / 3 low
  intent: string | null;
}

export interface DistributionItem {
  id: string; // Shopify GID
  title: string;
  /** Plain-text content snippet (title context for the LLM), pre-truncated. */
  snippet: string;
}

/** One keyword's proposed assignment, as parsed from an LLM batch response. */
export interface DistributionSuggestion {
  keyword: string;
  primaryItemId: string | null;
  secondaryItemIds: string[];
  /** 0..1 — an uncalibrated heuristic (plan §5.4 step 3): usable as a
   *  tie-breaker across batches and a default-accept threshold in the
   *  preview, NOT as a reliable ranking. */
  confidence: number;
  rationale: string;
}

// ── Batch sizing / cost math (plan §5.4 Context-Mathematik) ────────────────

/** Rough token estimates the batch plan + cost preview are built on. */
export const TOKENS_PER_KEYWORD = 8;
export const TOKENS_PER_ITEM = 320; // title + ~300-token snippet
export const PROMPT_OVERHEAD_TOKENS = 500;
export const OUTPUT_TOKENS_PER_ITEM = 100; // response JSON scales with items

export const DEFAULT_ITEMS_PER_BATCH = 15;
const MIN_ITEMS_PER_BATCH = 3;
/** Conservative per-call input budget (well under every provider's context). */
export const MODEL_INPUT_BUDGET_TOKENS = 100_000;

/** Character cap for the plain-text item snippet (~300 tokens). */
export const SNIPPET_MAX_CHARS = 1200;

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

/** Build the plain-text snippet for one item from its HTML/body content. */
export function buildItemSnippet(html: string | null | undefined): string {
  const text = stripHtml(html ?? "").replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) : text;
}

export function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// ── Prompt ─────────────────────────────────────────────────────────────────

export interface DistributionRules {
  maxSecondariesPerItem: number;
}

/**
 * One batch prompt: ALL keywords + ONE chunk of items + rules. The
 * anti-cannibalization rule ("at most one primary per keyword in this batch")
 * is mandatory (plan §5.4 step 2); cross-batch duplicates are resolved
 * deterministically in mergeBatchResults.
 */
export function buildDistributionPrompt(
  keywords: DistributionKeyword[],
  items: DistributionItem[],
  rules: DistributionRules,
): string {
  const keywordLines = keywords
    .map((k) => {
      const sanitized = sanitizePromptInput(k.keyword, { fieldType: "general" });
      const attrs: string[] = [`priority=${k.priority}`];
      if (k.intent) attrs.push(`intent=${k.intent}`);
      if (k.locale) attrs.push(`locale=${k.locale}`);
      return `- "${sanitized}" (${attrs.join(", ")})`;
    })
    .join("\n");

  const itemBlocks = items
    .map((it) => {
      const title = sanitizePromptInput(it.title, { fieldType: "title" });
      const snippet = sanitizePromptInput(it.snippet, { fieldType: "description", allowNewlines: false });
      return `ITEM id=${it.id}\ntitle: ${title}\ncontent: ${snippet || "(no description)"}`;
    })
    .join("\n\n");

  return `You are an SEO strategist assigning target keywords to store items.

KEYWORDS (complete list — every keyword must appear exactly once in your answer):
${keywordLines}

ITEMS (this batch only — other items exist but are not shown):
${itemBlocks}

RULES:
- For each keyword, choose the single best-matching item from THIS batch as "primaryItemId", or null if none of these items genuinely fits.
- Assign each keyword to AT MOST ONE primary item in this batch (no cannibalization: two items must never share the same primary keyword).
- Match search intent to item type where an intent is given: transactional/commercial keywords fit products and collections; informational keywords fit blog articles and guide pages.
- Optionally list up to ${rules.maxSecondariesPerItem} additional loosely-matching items per keyword as "secondaryItemIds" (may be empty).
- Never invent item ids — only use ids shown above.
- "confidence" is your 0..1 estimate that the primary assignment is right; be conservative.
- "rationale": ONE short sentence.

Respond with ONLY a JSON array, no markdown fences, no commentary:
[
  { "keyword": "<keyword>", "primaryItemId": "<item id or null>", "secondaryItemIds": ["<item id>"], "confidence": 0.8, "rationale": "..." }
]`;
}

// ── Response parsing ───────────────────────────────────────────────────────

/**
 * Parse one batch's LLM response defensively: tolerate markdown fences and
 * surrounding prose, drop rows referencing unknown keywords/items (the model
 * must not invent ids), clamp confidence into [0,1], dedupe secondaries and
 * never let the primary double as its own secondary. Returns [] for anything
 * unparseable — the runner records the batch as failed rather than crashing
 * the whole task.
 */
export function parseDistributionResponse(
  raw: string,
  validKeywords: Set<string>,
  validItemIds: Set<string>,
): DistributionSuggestion[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DistributionSuggestion[] = [];
  const seenKeywords = new Set<string>();
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const keyword = typeof r.keyword === "string" ? r.keyword.trim().toLowerCase() : "";
    if (!keyword || !validKeywords.has(keyword) || seenKeywords.has(keyword)) continue;
    seenKeywords.add(keyword);

    const primaryItemId =
      typeof r.primaryItemId === "string" && validItemIds.has(r.primaryItemId)
        ? r.primaryItemId
        : null;
    const rawSecondaries = Array.isArray(r.secondaryItemIds) ? r.secondaryItemIds : [];
    const secondaryItemIds = Array.from(
      new Set(
        rawSecondaries.filter(
          (id): id is string =>
            typeof id === "string" && validItemIds.has(id) && id !== primaryItemId,
        ),
      ),
    );
    const rawConfidence = typeof r.confidence === "number" ? r.confidence : 0;
    const confidence = Math.min(1, Math.max(0, rawConfidence));
    const rationale = typeof r.rationale === "string" ? r.rationale.slice(0, 300) : "";

    out.push({ keyword, primaryItemId, secondaryItemIds, confidence, rationale });
  }
  return out;
}

// ── Cross-batch merge (plan §5.4 step 3) ───────────────────────────────────

/**
 * Deterministic merge across batches: each batch only saw its own items, so
 * the same keyword can come back with a primary from several batches. The
 * primary with the highest confidence wins; the losing primaries are demoted
 * into the secondaries list (capped at maxSecondaries) — confidence values
 * from different calls are NOT calibrated against each other, so this is a
 * tie-breaker heuristic and the preview table stays the real quality gate.
 * No LLM involved.
 */
export function mergeBatchResults(
  batches: DistributionSuggestion[][],
  maxSecondaries: number,
): DistributionSuggestion[] {
  const byKeyword = new Map<string, DistributionSuggestion>();

  for (const batch of batches) {
    for (const s of batch) {
      const existing = byKeyword.get(s.keyword);
      if (!existing) {
        byKeyword.set(s.keyword, {
          ...s,
          secondaryItemIds: [...s.secondaryItemIds],
        });
        continue;
      }

      // Decide the winning primary; the loser's primary becomes a secondary
      // candidate (FIRST in line — a losing primary is still a stronger
      // signal than an ordinary secondary).
      let winner = existing;
      let loser = s;
      const loserWins =
        s.primaryItemId !== null &&
        (existing.primaryItemId === null || s.confidence > existing.confidence);
      if (loserWins) {
        winner = s;
        loser = existing;
      }

      const mergedSecondaries: string[] = [];
      const push = (id: string | null) => {
        if (id && id !== winner.primaryItemId && !mergedSecondaries.includes(id)) {
          mergedSecondaries.push(id);
        }
      };
      push(loser.primaryItemId);
      for (const id of winner.secondaryItemIds) push(id);
      for (const id of loser.secondaryItemIds) push(id);

      byKeyword.set(s.keyword, {
        keyword: s.keyword,
        primaryItemId: winner.primaryItemId,
        secondaryItemIds: mergedSecondaries.slice(0, maxSecondaries),
        confidence: winner.confidence,
        rationale: winner.rationale,
      });
    }
  }

  return Array.from(byKeyword.values());
}

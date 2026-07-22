/**
 * Search-intent classification for keywords (PLAN_KEYWORDS_EXPANSION.md §7.2).
 * Pure prompt/parse helpers — the LLM call + DB writes live in the
 * classifyKeywordIntents branch of api.ai.tsx's keyword-intent handler. One
 * call classifies up to INTENT_BATCH_SIZE keywords; the merchant re-triggers
 * until nothing unclassified remains (the button shows the open count).
 */

import { sanitizePromptInput } from "../../utils/prompt-sanitizer";

export const INTENT_BATCH_SIZE = 50;

export const KEYWORD_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;
export type KeywordIntent = (typeof KEYWORD_INTENTS)[number];

const INTENT_SET = new Set<string>(KEYWORD_INTENTS);

export function buildIntentPrompt(keywords: string[]): string {
  const lines = keywords
    .map((k) => `- "${sanitizePromptInput(k, { fieldType: "general" })}"`)
    .join("\n");
  return `Classify the search intent of each keyword below.

Intents:
- informational: the searcher wants to learn something ("how to clean a vase")
- commercial: researching/comparing before a purchase ("best ceramic vases")
- transactional: ready to buy ("buy green ceramic vase")
- navigational: looking for a specific site/brand ("ikea vases")

KEYWORDS:
${lines}

Respond with ONLY a JSON array, no markdown fences, no commentary — one entry
per keyword, keyword text repeated verbatim:
[
  { "keyword": "<keyword>", "intent": "informational" }
]`;
}

/**
 * Defensive parse: tolerate fences/prose, drop unknown keywords and invalid
 * intents, first entry per keyword wins. Returns keyword (lowercased) →
 * intent; missing keywords simply stay unclassified for the next run.
 */
export function parseIntentResponse(
  raw: string,
  validKeywords: Set<string>,
): Map<string, KeywordIntent> {
  const out = new Map<string, KeywordIntent>();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;

  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const keyword = typeof r.keyword === "string" ? r.keyword.trim().toLowerCase() : "";
    const intent = typeof r.intent === "string" ? r.intent.trim().toLowerCase() : "";
    if (!keyword || !validKeywords.has(keyword) || out.has(keyword)) continue;
    if (!INTENT_SET.has(intent)) continue;
    out.set(keyword, intent as KeywordIntent);
  }
  return out;
}

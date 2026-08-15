/**
 * The ONE keywords→AI bridge (PLAN_KEYWORDS_EXPANSION.md §2.2/§3.2).
 *
 * Every AI prompt that should respect an item's tracked keywords goes through
 * here: text generation, the format/improve path and alt-text generation. Before
 * this module each handler would have needed its own copy of "load the
 * assignments, sanitize them, split primary/secondary, phrase the requirement" —
 * and the three copies would have drifted on the locale rule first.
 *
 * Locale contract: a keyword is scoped to (item, locale) with "" = the shop's
 * primary locale, exactly like `SeoKeyword.locale`. Handlers must pass the
 * locale the CONTENT is being generated for — generating French copy while
 * injecting the German target keyword is the bug this parameter exists to
 * prevent. `resolveKeywordLocale` reads the client's value off the form; a
 * missing field falls back to "" (primary), which is what every caller that
 * predates the multilingual keywords did implicitly.
 */

import type { PrismaClient } from "@prisma/client";
import { analyzeOnPage, getItemKeywords } from "~/services/seo/keywords.service";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { getFormString } from "~/utils/form-data.utils";

/** Field keys whose prompts weave in the tracked keywords. */
const KEYWORD_AWARE_FIELDS = new Set([
  "title",
  "seoTitle",
  "metaDescription",
  "description",
  "body",
  // The slug prompt always asked for "2-5 relevant keywords" in the abstract;
  // with a tracked keyword it can ask for the RIGHT one.
  "handle",
]);

export function isKeywordAwareField(fieldType: string): boolean {
  return KEYWORD_AWARE_FIELDS.has(fieldType);
}

/**
 * Locale the keyword lookup should run against, read off the request. The
 * client sends the editor's current locale, already collapsed to "" when it
 * equals the shop's primary locale (see useFieldHandlers).
 */
export function resolveKeywordLocale(formData: FormData): string {
  return getFormString(formData, "keywordLocale") || "";
}

/** Sanitized, role-split view of an item's tracked keywords for prompt use. */
export interface TrackedKeywords {
  /** The single primary keyword, or null when the item tracks none. */
  primary: string | null;
  /** Secondary keywords, primary excluded. */
  secondaries: string[];
  /** Classified search intent of the primary keyword, when available. */
  primaryIntent: string | null;
  /** primary + secondaries — the set the stuffing guard measures. */
  all: string[];
}

const EMPTY: TrackedKeywords = { primary: null, secondaries: [], primaryIntent: null, all: [] };

/**
 * Load an item's tracked keywords for one locale, sanitized for prompt
 * interpolation. Returns the empty set for fields that aren't keyword-aware, so
 * callers can call unconditionally and skip their own gate.
 */
export async function loadTrackedKeywords(
  db: PrismaClient,
  shop: string,
  resourceId: string,
  locale: string,
  fieldType: string,
): Promise<TrackedKeywords> {
  if (!resourceId || !isKeywordAwareField(fieldType)) return EMPTY;
  return loadTrackedKeywordsUnfiltered(db, shop, resourceId, locale);
}

/**
 * Same as `loadTrackedKeywords` but without the field gate — for prompts that
 * have no editor field key of their own (alt text).
 */
export async function loadTrackedKeywordsUnfiltered(
  db: PrismaClient,
  shop: string,
  resourceId: string,
  locale: string,
): Promise<TrackedKeywords> {
  if (!resourceId) return EMPTY;
  const rows = await getItemKeywords(db, shop, resourceId, locale);
  if (rows.length === 0) return EMPTY;

  const primaryRow = rows.find((r) => r.role === "primary");
  const primary = primaryRow
    ? sanitizePromptInput(primaryRow.keyword, { fieldType: "general" }) || null
    : null;
  const secondaries = rows
    .filter((r) => r.role === "secondary")
    .map((r) => sanitizePromptInput(r.keyword, { fieldType: "general" }))
    .filter(Boolean);

  return {
    primary,
    secondaries,
    primaryIntent: primaryRow?.intent ?? null,
    all: [...(primary ? [primary] : []), ...secondaries],
  };
}

/**
 * Search-intent hints (PLAN_KEYWORDS_EXPANSION.md §7.2): when the primary
 * keyword has been classified, tell the model what the searcher is after — a
 * small but measurable quality lift, especially for meta descriptions.
 */
const INTENT_HINTS: Record<string, string> = {
  informational: "the searcher wants to learn — lead with the answer/benefit, not the sale",
  commercial: "the searcher is comparing options — emphasize differentiators and proof",
  transactional: "the searcher is ready to buy — emphasize purchase, benefit, availability",
  navigational: "the searcher looks for a specific brand/page — be precise and recognizable",
};

/**
 * Requirement lines for a GENERATING prompt — the model is writing new copy and
 * should work the keywords in. Returns "" when nothing is tracked, so callers
 * can append unconditionally.
 */
export function keywordRequirementLines(kw: TrackedKeywords, isSlug = false): string {
  let out = "";
  if (kw.primary) {
    out += isSlug
      ? `\n- Build the slug around the target keyword "${kw.primary}" (hyphenated, once).`
      : `\n- Naturally include the target keyword "${kw.primary}" (do not stuff it).`;
  }
  if (kw.secondaries.length && !isSlug) {
    out += `\n- If it fits naturally, you may also mention: ${kw.secondaries
      .map((s) => `"${s}"`)
      .join(", ")}. Only use those that flow with the sentence; skip any that would sound forced or repetitive. Never use more than one per sentence.`;
  }
  // The intent hints are prose advice ("emphasize purchase, benefit,
  // availability") — useless to a prompt whose output is restricted to
  // a-z0-9-, and noise the model may try to act on. Slugs get the keyword only.
  if (!isSlug && kw.primaryIntent && INTENT_HINTS[kw.primaryIntent]) {
    out += `\n- Search intent of the target keyword: ${kw.primaryIntent} — ${INTENT_HINTS[kw.primaryIntent]}.`;
  }
  return out;
}

/**
 * Requirement line for a REFORMATTING prompt.
 *
 * The baseline is preserve-don't-add: a formatting pass must not invent
 * keywords, but it must stop DROPPING one that is already there — which is
 * exactly how a reformat used to quietly cost an item its on-page score.
 *
 * `mayAddPrimary` additionally lets the pass work a MISSING primary keyword in.
 * The field-level format action opts into this (a text that doesn't contain its
 * own target keyword is the single most common thing a merchant wants fixed);
 * the generic `formatField` entrance does not, because it has no field
 * definition and therefore no idea what it is rewriting. Secondaries are never
 * added either way — offering four optional phrases to a pass that is supposed
 * to keep the content is how "format" turns into "rewrite".
 */
export function keywordPreservationLine(
  kw: TrackedKeywords,
  opts: { mayAddPrimary?: boolean } = {},
): string {
  if (kw.all.length === 0) return "";
  const list = kw.all.map((s) => `"${s}"`).join(", ");
  let out = `\n\nTracked keywords for this item: ${list}. Keep every one of them that already appears in the text — do not drop, split or reword them.`;
  if (opts.mayAddPrimary && kw.primary) {
    out += ` If the target keyword "${kw.primary}" does not appear yet, work it in ONCE by rewording an existing sentence — never by appending a new one, and never at the cost of the meaning. Do not add any of the other keywords.`;
  } else {
    out += ` Do NOT add keywords that are not already present.`;
  }
  return out;
}

/**
 * Post-generation stuffing guard (PLAN_KEYWORDS_EXPANSION.md §3.2). Field-type
 * aware, because one global density threshold can't work: a 5-word SEO title
 * containing a 2-word keyword is ~40 % density by definition.
 *   - long content: density > 3 % for any tracked keyword
 *   - short fields: the same keyword occurring more than once
 * Returns the first offending keyword, or null when the output is clean.
 */
export function findStuffedKeyword(
  generated: string,
  keywords: string[],
  isLongContent: boolean,
): string | null {
  for (const keyword of keywords) {
    if (!keyword) continue;
    // analyzeOnPage is pure; feeding the generated text as body gives us
    // occurrence + density counting with the same word-boundary rules the
    // keywords tab uses.
    const analysis = analyzeOnPage({ keyword, bodyHtml: generated });
    if (isLongContent ? analysis.densityPct > 3 : analysis.occurrences > 1) {
      return keyword;
    }
  }
  return null;
}

/** The retry instruction appended after the guard caught a stuffed output. */
export function stuffingRetryWarning(stuffed: string, isLongContent: boolean): string {
  return `\n\nWARNING: A previous attempt stuffed the keyword "${stuffed}". Rewrite with ${
    isLongContent
      ? "lower keyword density (well below 3%) — mention each keyword only where it truly fits"
      : "each keyword mentioned at most once"
  }.`;
}

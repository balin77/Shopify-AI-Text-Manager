/**
 * Keyword tracking + on-page analysis (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * `analyzeOnPage` is pure (server + client safe): it checks the target keyword's
 * presence in title / SEO-title / meta / H1 / body, computes keyword density
 * (with a stuffing guard) and the first-occurrence position — all local, no
 * external keyword API. The CRUD helpers persist one keyword per item/locale.
 */

import type { PrismaClient } from "@prisma/client";
import { stripHtml } from "../../utils/seo-score";

export type KeywordResourceType = "Product" | "Collection" | "Article" | "Page";

export interface KeywordOnPageInput {
  keyword: string;
  title?: string | null;
  seoTitle?: string | null;
  metaDescription?: string | null;
  bodyHtml?: string | null;
  /**
   * Determines the H1 source (see analyzeOnPage doc below). Optional so
   * existing callers keep working — when omitted, the more permissive
   * article/page behavior (title OR an explicit body <h1>) is used.
   */
  resourceType?: KeywordResourceType;
}

export interface KeywordFinding {
  code: string; // i18n key under t.seo.keywordsPage.findings.*
  severity: "success" | "warning" | "error";
}

export type DensityBand = "none" | "low" | "ok" | "high";

export interface KeywordOnPageResult {
  keyword: string;
  presence: {
    title: boolean;
    seoTitle: boolean;
    metaDescription: boolean;
    h1: boolean;
    body: boolean;
  };
  occurrences: number;
  wordCount: number;
  densityPct: number;
  densityBand: DensityBand;
  /** Position of the first body occurrence as a % of body length (lower = earlier). */
  firstPositionPct: number | null;
  findings: KeywordFinding[];
  /** 0–100 on-page keyword score (presence-weighted + density). */
  score: number;
}

/** Extract the first H1's text from raw HTML (BEFORE stripping the whole body). */
function extractH1(html: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripHtml(m[1]) : "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Unicode-aware "whole word(s)" match: the keyword must be bounded by
 * start/end-of-string or a non-letter/non-digit character on each side, so
 * "tee" no longer matches inside "Garantee" (R-keywords-1). A multi-word
 * keyword (escaped, so its internal literal space survives) still matches
 * across a single space, e.g. "blue shoes" inside "...blue shoes...".
 * `giu` flags: global (for counting), case-insensitive, unicode (so
 * `\p{L}`/`\p{N}` property escapes are valid and match non-ASCII letters).
 */
function buildWordBoundaryRegex(needleNormalized: string): RegExp {
  const escaped = escapeRegExp(needleNormalized);
  return new RegExp(`(?<=^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu");
}

/** Case/diacritic-normalize for matching — NFC so composed vs. combining-mark
 *  spellings of the same character (e.g. umlauts) compare equal. */
function normalizeForMatch(s: string): string {
  return s.normalize("NFC").toLocaleLowerCase();
}

function containsWord(haystack: string, needleNormalized: string): boolean {
  if (!needleNormalized) return false;
  return buildWordBoundaryRegex(needleNormalized).test(haystack);
}

function countOccurrences(haystack: string, needleNormalized: string): number {
  if (!needleNormalized) return 0;
  const matches = haystack.match(buildWordBoundaryRegex(needleNormalized));
  return matches ? matches.length : 0;
}

/**
 * Upper bound for a stored keyword (review N4). Real target keywords are a
 * few words; the cap mainly stops an unbounded string from flowing into AI
 * prompts (text-generation.handler.ts appends the tracked keyword verbatim,
 * sanitized but untruncated) and into every analyze pass. Enforced at the
 * write endpoints (keywords tab + sidebar API), asserted here for reuse.
 */
export const MAX_KEYWORD_LENGTH = 120;

/** Normalize a keyword for storage and matching (lowercased, single-spaced). */
export function normalizeKeyword(keyword: string): string {
  return normalizeForMatch(keyword.trim().replace(/\s+/g, " "));
}

export function analyzeOnPage(input: KeywordOnPageInput): KeywordOnPageResult {
  const keyword = normalizeKeyword(input.keyword);
  const title = input.title ?? "";
  const seoTitle = input.seoTitle ?? "";
  const metaDescription = input.metaDescription ?? "";
  const rawBody = input.bodyHtml ?? "";

  const bodyText = stripHtml(rawBody);

  const titleL = normalizeForMatch(title);
  const seoTitleL = normalizeForMatch(seoTitle);
  const metaL = normalizeForMatch(metaDescription);
  const bodyL = normalizeForMatch(bodyText);

  // R-keywords-2: Shopify themes render the item's TITLE as the storefront H1
  // (product/collection descriptionHtml never contains a real h1), so scanning
  // only descriptionHtml for `<h1>` unfairly penalized every product/collection.
  // For products/collections the effective H1 is the title. Articles/pages MAY
  // additionally contain an authored `<h1>` in the body — kept as an extra
  // signal for those types (and as the permissive default when the caller
  // hasn't been updated to pass `resourceType` yet).
  const includeBodyH1 = input.resourceType !== "Product" && input.resourceType !== "Collection";
  const explicitH1Text = includeBodyH1 ? extractH1(rawBody) : "";
  const explicitH1L = normalizeForMatch(explicitH1Text);

  const titleHasKeyword = containsWord(titleL, keyword);

  const presence = {
    title: titleHasKeyword,
    seoTitle: containsWord(seoTitleL, keyword),
    metaDescription: containsWord(metaL, keyword),
    h1: titleHasKeyword || (!!explicitH1L && containsWord(explicitH1L, keyword)),
    body: containsWord(bodyL, keyword),
  };

  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const occurrences = countOccurrences(bodyL, keyword);
  const keywordWords = keyword ? keyword.split(/\s+/).filter(Boolean).length : 1;

  const densityPct =
    wordCount > 0 ? Math.round(((occurrences * keywordWords) / wordCount) * 1000) / 10 : 0;

  let densityBand: DensityBand;
  if (occurrences === 0) densityBand = "none";
  else if (densityPct < 0.5) densityBand = "low";
  else if (densityPct > 2.5) densityBand = "high";
  else densityBand = "ok";

  let firstPositionPct: number | null = null;
  if (presence.body && bodyText.length > 0) {
    const match = buildWordBoundaryRegex(keyword).exec(bodyL);
    firstPositionPct = match ? Math.round((match.index / bodyText.length) * 100) : null;
  }

  // Findings (codes → t.seo.keywordsPage.findings.*)
  const findings: KeywordFinding[] = [
    { code: presence.title ? "inTitle" : "notInTitle", severity: presence.title ? "success" : "warning" },
    { code: presence.h1 ? "inH1" : "notInH1", severity: presence.h1 ? "success" : "warning" },
    { code: presence.metaDescription ? "inMeta" : "notInMeta", severity: presence.metaDescription ? "success" : "warning" },
    { code: presence.seoTitle ? "inSeoTitle" : "notInSeoTitle", severity: presence.seoTitle ? "success" : "warning" },
  ];
  if (densityBand === "none") findings.push({ code: "densityNone", severity: "warning" });
  else if (densityBand === "low") findings.push({ code: "densityLow", severity: "warning" });
  else if (densityBand === "high") findings.push({ code: "densityHigh", severity: "error" });
  else findings.push({ code: "densityOk", severity: "success" });

  // Presence-weighted score (max 100): title 25 / h1 20 / meta 20 / seoTitle 15 / body-density 20.
  let score = 0;
  if (presence.title) score += 25;
  if (presence.h1) score += 20;
  if (presence.metaDescription) score += 20;
  if (presence.seoTitle) score += 15;
  if (densityBand === "ok") score += 20;
  else if (densityBand === "low") score += 10;
  else if (densityBand === "high") score += 5; // stuffing — partial credit

  return {
    keyword,
    presence,
    occurrences,
    wordCount,
    densityPct,
    densityBand,
    firstPositionPct,
    findings,
    score,
  };
}

// ── Multi-keyword analysis (PLAN_KEYWORDS_EXPANSION.md §3.3) ────────────────

export interface MultiKeywordResult {
  /** Per-keyword analyzeOnPage results, in input order. */
  results: KeywordOnPageResult[];
  /** Sum of the individual density percentages (same body → additive). */
  aggregateDensityPct: number;
  /** Cross-keyword stuffing warning: combined density > 5 %. */
  aggregateStuffing: boolean;
}

/**
 * Thin wrapper over analyzeOnPage for an item tracking several keywords: runs
 * the existing single-keyword analyzer per keyword and adds a cross-keyword
 * stuffing aggregate (the individual 2.5 % "high" band can look fine per
 * keyword while five keywords together saturate the copy).
 */
export function analyzeMultiKeyword(
  content: Omit<KeywordOnPageInput, "keyword">,
  keywords: string[],
): MultiKeywordResult {
  const results = keywords.map((keyword) => analyzeOnPage({ ...content, keyword }));
  const aggregateDensityPct =
    Math.round(results.reduce((sum, r) => sum + r.densityPct, 0) * 10) / 10;
  return { results, aggregateDensityPct, aggregateStuffing: aggregateDensityPct > 5 };
}

// ── Persistence (keyword + assignment, PLAN_KEYWORDS_EXPANSION.md §2) ───────

export type KeywordRole = "primary" | "secondary";

/** Hard cap per (item, locale): 1 primary + up to 4 secondaries. */
export const MAX_KEYWORDS_PER_ITEM = 5;

/** One assignment row joined with its keyword — what the keywords tab lists. */
export interface KeywordAssignmentRow {
  id: string; // assignment id
  keywordId: string;
  resourceType: string;
  resourceId: string;
  keyword: string;
  locale: string;
  role: KeywordRole;
  priority: number;
  intent: string | null;
  gscPosition: number | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscCtr: number | null;
  updatedAt: Date; // keyword.updatedAt (list ordering parity with the old table)
}

export type AssignKeywordResult =
  | { ok: true }
  | {
      /** A different keyword is already primary for this (item, locale) and
       *  the caller didn't pass demoteExisting — UI shows a confirm dialog
       *  and re-submits with demoteExisting: true. */
      ok: false;
      reason: "primaryExists";
      existingKeyword: string;
    }
  | { ok: false; reason: "tooMany" };

const assignmentInclude = { keyword: true } as const;

function toRow(a: {
  id: string;
  resourceType: string;
  resourceId: string;
  role: string;
  gscPosition: number | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscCtr: number | null;
  keyword: {
    id: string;
    keyword: string;
    locale: string;
    priority: number;
    intent: string | null;
    updatedAt: Date;
  };
}): KeywordAssignmentRow {
  return {
    id: a.id,
    keywordId: a.keyword.id,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    keyword: a.keyword.keyword,
    locale: a.keyword.locale,
    role: a.role as KeywordRole,
    priority: a.keyword.priority,
    intent: a.keyword.intent,
    gscPosition: a.gscPosition,
    gscClicks: a.gscClicks,
    gscImpressions: a.gscImpressions,
    gscCtr: a.gscCtr,
    updatedAt: a.keyword.updatedAt,
  };
}

/**
 * Upsert a keyword (by (shop, keyword, locale)) and assign it to an item with
 * a role. "At most one primary per (item, locale)" is enforced HERE, inside a
 * transaction — Prisma can't express it as a constraint because the locale
 * lives on the keyword. When another keyword already holds the primary role:
 * without `demoteExisting` the call returns `primaryExists` (no write) so the
 * UI can confirm; with it, the old primary is demoted to secondary in the same
 * transaction (check+swap — two parallel writers serialize on the row).
 */
export async function assignKeyword(
  db: PrismaClient,
  shop: string,
  input: {
    resourceType: KeywordResourceType;
    resourceId: string;
    keyword: string;
    locale?: string;
    role: KeywordRole;
    demoteExisting?: boolean;
    /**
     * Optional GSC metrics to stamp onto the assignment immediately — the
     * GSC adopt flow (PLAN_KEYWORDS_EXPANSION.md §4.2) already holds the
     * row's values, so the merchant sees them without waiting for the next
     * ranking sync.
     */
    gsc?: {
      position: number | null;
      clicks: number | null;
      impressions: number | null;
      ctr: number | null;
      updatedAt: Date;
    };
  },
): Promise<AssignKeywordResult> {
  const keyword = normalizeKeyword(input.keyword);
  const locale = input.locale ?? "";

  return db.$transaction(async (tx) => {
    const keywordRow = await tx.seoKeyword.upsert({
      where: { shop_keyword_locale: { shop, keyword, locale } },
      create: { shop, keyword, locale },
      // No data change needed — the touch keeps updatedAt (list ordering) fresh.
      update: { updatedAt: new Date() },
    });

    // All assignments of this item in this locale (locale hangs off the keyword).
    const siblings = await tx.seoKeywordAssignment.findMany({
      where: { shop, resourceId: input.resourceId, keyword: { locale } },
      include: assignmentInclude,
    });
    const self = siblings.find((s) => s.keywordId === keywordRow.id);

    if (!self && siblings.length >= MAX_KEYWORDS_PER_ITEM) {
      return { ok: false, reason: "tooMany" } as const;
    }

    if (input.role === "primary") {
      const existingPrimary = siblings.find(
        (s) => s.role === "primary" && s.keywordId !== keywordRow.id,
      );
      if (existingPrimary) {
        if (!input.demoteExisting) {
          return {
            ok: false,
            reason: "primaryExists",
            existingKeyword: existingPrimary.keyword.keyword,
          } as const;
        }
        await tx.seoKeywordAssignment.update({
          where: { id: existingPrimary.id },
          data: { role: "secondary" },
        });
      }
    }

    const gscData = input.gsc
      ? {
          gscPosition: input.gsc.position,
          gscClicks: input.gsc.clicks,
          gscImpressions: input.gsc.impressions,
          gscCtr: input.gsc.ctr,
          gscUpdatedAt: input.gsc.updatedAt,
        }
      : {};
    await tx.seoKeywordAssignment.upsert({
      where: {
        shop_keywordId_resourceId: {
          shop,
          keywordId: keywordRow.id,
          resourceId: input.resourceId,
        },
      },
      create: {
        shop,
        keywordId: keywordRow.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        role: input.role,
        ...gscData,
      },
      update: { role: input.role, resourceType: input.resourceType, ...gscData },
    });

    return { ok: true } as const;
  });
}

/** All assignments of a shop (keywords tab listing), newest keyword first. */
export async function listAssignments(
  db: PrismaClient,
  shop: string,
): Promise<KeywordAssignmentRow[]> {
  const rows = await db.seoKeywordAssignment.findMany({
    where: { shop },
    include: assignmentInclude,
    orderBy: { keyword: { updatedAt: "desc" } },
  });
  return rows.map(toRow);
}

/**
 * The keywords tracked for one (item, locale), primary first — what the SEO
 * sidebar and the AI-prompt bridge consume.
 */
export async function getItemKeywords(
  db: PrismaClient,
  shop: string,
  resourceId: string,
  locale = "",
): Promise<KeywordAssignmentRow[]> {
  const rows = await db.seoKeywordAssignment.findMany({
    where: { shop, resourceId, keyword: { locale } },
    include: assignmentInclude,
    // primary before secondary (alphabetical luck), then priority 1→3.
    orderBy: [{ role: "asc" }, { keyword: { priority: "asc" } }],
  });
  return rows.map(toRow);
}

/**
 * Promote an existing assignment to primary, demoting the item's current
 * primary (same locale) to secondary — both inside one transaction (same
 * check+swap rule as assignKeyword). No-op when the id doesn't belong to the
 * shop.
 */
export async function promoteAssignment(
  db: PrismaClient,
  shop: string,
  assignmentId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const assignment = await tx.seoKeywordAssignment.findFirst({
      where: { id: assignmentId, shop },
      include: assignmentInclude,
    });
    if (!assignment) return;
    const currentPrimary = await tx.seoKeywordAssignment.findFirst({
      where: {
        shop,
        resourceId: assignment.resourceId,
        role: "primary",
        id: { not: assignment.id },
        keyword: { locale: assignment.keyword.locale },
      },
    });
    if (currentPrimary) {
      await tx.seoKeywordAssignment.update({
        where: { id: currentPrimary.id },
        data: { role: "secondary" },
      });
    }
    if (assignment.role !== "primary") {
      await tx.seoKeywordAssignment.update({
        where: { id: assignment.id },
        data: { role: "primary" },
      });
    }
  });
}

/**
 * Delete an assignment — scoped to the shop so one shop can't delete
 * another's. The keyword itself survives while other assignments or group
 * memberships still reference it; a fully orphaned keyword is removed so
 * Phase-1 UI (which has no standalone-keyword view yet) leaves no invisible
 * rows behind. Phase-3 CSV imports create deliberately unassigned keywords —
 * those carry group memberships and are therefore kept.
 */
export async function removeAssignment(
  db: PrismaClient,
  shop: string,
  assignmentId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const assignment = await tx.seoKeywordAssignment.findFirst({
      where: { id: assignmentId, shop },
      select: { keywordId: true },
    });
    if (!assignment) return;
    await tx.seoKeywordAssignment.delete({ where: { id: assignmentId } });
    const [remaining, memberships] = await Promise.all([
      tx.seoKeywordAssignment.count({ where: { keywordId: assignment.keywordId } }),
      tx.seoKeywordGroupMembership.count({ where: { keywordId: assignment.keywordId } }),
    ]);
    if (remaining === 0 && memberships === 0) {
      await tx.seoKeyword.delete({ where: { id: assignment.keywordId } });
    }
  });
}

// ── Locale-aware analysis input ─────────────────────────────────────────────

/** A flat ContentTranslation row, as selected by the keywords loader's batched
 *  findMany over [resourceIds] x [locales] x the four SEO-relevant keys. */
export interface TranslationRow {
  resourceId: string;
  locale: string;
  key: string; // "title" | "meta_title" | "meta_description" | "body_html"
  value: string;
}

/** ContentTranslation.key for each analyzeOnPage input field — mirrors
 *  hreflang.service.ts's TRANSLATION_KEYS / audit.service.ts's FIELD_TO_KEY
 *  (same four Shopify translation keys the sync pipeline writes for every
 *  audited resource type: Product, Collection, Article, Page). */
const CONTENT_TRANSLATION_KEY: Record<keyof TranslatedItemContent, string> = {
  title: "title",
  seoTitle: "meta_title",
  metaDescription: "meta_description",
  bodyHtml: "body_html",
};

export interface TranslatedItemContent {
  title: string;
  seoTitle: string;
  metaDescription: string;
  bodyHtml: string;
}

/**
 * Build the analyzeOnPage input for one (resourceId, locale) pair from its
 * ContentTranslation rows (already filtered/grouped to that single pair by the
 * caller). Untranslated fields fall back to "" — NOT the primary-locale value
 * — so the analysis honestly reports the keyword as missing rather than
 * crediting a translation that was never made.
 */
export function buildTranslatedContentInput(rowsForItem: TranslationRow[]): TranslatedItemContent {
  const get = (key: string) => rowsForItem.find((r) => r.key === key)?.value ?? "";
  return {
    title: get(CONTENT_TRANSLATION_KEY.title),
    seoTitle: get(CONTENT_TRANSLATION_KEY.seoTitle),
    metaDescription: get(CONTENT_TRANSLATION_KEY.metaDescription),
    bodyHtml: get(CONTENT_TRANSLATION_KEY.bodyHtml),
  };
}

/** The ContentTranslation.key values buildTranslatedContentInput reads — used
 *  by the loader to scope its findMany's `key: { in: ... }` filter. */
export const TRANSLATED_CONTENT_KEYS: string[] = Object.values(CONTENT_TRANSLATION_KEY);

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

// ── Persistence ──────────────────────────────────────────────────────────────

export interface SeoKeywordRow {
  id: string;
  resourceType: string;
  resourceId: string;
  keyword: string;
  locale: string;
  gscPosition: number | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscCtr: number | null;
  updatedAt: Date;
}

/** Upsert the target keyword for an item/locale (keyword stored lowercased). */
export async function setKeyword(
  db: PrismaClient,
  shop: string,
  input: { resourceType: KeywordResourceType; resourceId: string; keyword: string; locale?: string },
): Promise<void> {
  const keyword = normalizeKeyword(input.keyword);
  const locale = input.locale ?? "";
  await db.seoKeyword.upsert({
    where: { shop_resourceId_locale: { shop, resourceId: input.resourceId, locale } },
    create: { shop, resourceType: input.resourceType, resourceId: input.resourceId, keyword, locale },
    update: { keyword, resourceType: input.resourceType },
  });
}

export async function listKeywords(db: PrismaClient, shop: string): Promise<SeoKeywordRow[]> {
  return db.seoKeyword.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      resourceType: true,
      resourceId: true,
      keyword: true,
      locale: true,
      gscPosition: true,
      gscClicks: true,
      gscImpressions: true,
      gscCtr: true,
      updatedAt: true,
    },
  });
}

/** Delete a keyword row — scoped to the shop so one shop can't delete another's. */
export async function deleteKeyword(db: PrismaClient, shop: string, id: string): Promise<void> {
  await db.seoKeyword.deleteMany({ where: { id, shop } });
}

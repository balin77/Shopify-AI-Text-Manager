/**
 * Keyword tracking + on-page analysis (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * `analyzeOnPage` is pure (server + client safe): it checks the target keyword's
 * presence in title / SEO-title / meta / H1 / body, computes keyword density
 * (with a stuffing guard) and the first-occurrence position — all local, no
 * external keyword API. The CRUD helpers persist one keyword per item/locale.
 */

import type { PrismaClient } from "@prisma/client";

export type KeywordResourceType = "Product" | "Collection" | "Article" | "Page";

export interface KeywordOnPageInput {
  keyword: string;
  title?: string | null;
  seoTitle?: string | null;
  metaDescription?: string | null;
  bodyHtml?: string | null;
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

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the first H1's text from raw HTML (BEFORE stripping the whole body). */
function extractH1(html: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0;
  const re = new RegExp(escapeRegExp(needleLower), "g");
  const matches = haystackLower.match(re);
  return matches ? matches.length : 0;
}

/** Normalize a keyword for storage and matching (lowercased, single-spaced). */
export function normalizeKeyword(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ").toLowerCase();
}

export function analyzeOnPage(input: KeywordOnPageInput): KeywordOnPageResult {
  const keyword = normalizeKeyword(input.keyword);
  const title = input.title ?? "";
  const seoTitle = input.seoTitle ?? "";
  const metaDescription = input.metaDescription ?? "";
  const rawBody = input.bodyHtml ?? "";

  const h1Text = extractH1(rawBody);
  const bodyText = stripTags(rawBody);

  const titleL = title.toLowerCase();
  const seoTitleL = seoTitle.toLowerCase();
  const metaL = metaDescription.toLowerCase();
  const h1L = h1Text.toLowerCase();
  const bodyL = bodyText.toLowerCase();

  const presence = {
    title: !!keyword && titleL.includes(keyword),
    seoTitle: !!keyword && seoTitleL.includes(keyword),
    metaDescription: !!keyword && metaL.includes(keyword),
    h1: !!keyword && h1L.includes(keyword),
    body: !!keyword && bodyL.includes(keyword),
  };

  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const occurrences = keyword ? countOccurrences(bodyL, keyword) : 0;
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
    const idx = bodyL.indexOf(keyword);
    firstPositionPct = idx >= 0 ? Math.round((idx / bodyText.length) * 100) : null;
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

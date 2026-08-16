/**
 * Keyword tracking + on-page analysis (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * `analyzeOnPage` is pure (server + client safe): it checks the target keyword's
 * presence in title / SEO-title / meta / H1 / body, computes keyword density
 * (with a stuffing guard) and the first-occurrence position — all local, no
 * external keyword API. The CRUD helpers persist one keyword per item/locale.
 */

// TYPE-ONLY Prisma imports — this module is imported CLIENT-SIDE (SeoSidebar
// uses analyzeOnPage), so a value import of @prisma/client would drag the
// Prisma runtime into the browser bundle and break the vite build.
import type { Prisma, PrismaClient } from "@prisma/client";
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

/**
 * Run an interactive transaction at SERIALIZABLE isolation, retrying on
 * serialization conflicts (P2034). The check+swap invariants below are only
 * race-proof at this level: two parallel writers setting DIFFERENT keywords
 * as primary on the same item share no row lock at READ COMMITTED — both
 * would read "no primary yet" and both would insert one.
 */
async function serializableWithRetry<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(fn, {
        // String literal instead of Prisma.TransactionIsolationLevel.* — the
        // enum would need a VALUE import of @prisma/client (see header note).
        isolationLevel: "Serializable" as Prisma.TransactionIsolationLevel,
      });
    } catch (err) {
      lastError = err;
      // Duck-typed instead of `instanceof Prisma.PrismaClientKnownRequestError`
      // for the same client-bundle reason.
      if ((err as { code?: string } | null)?.code === "P2034") continue;
      throw err;
    }
  }
  throw lastError;
}

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
     * Guard for automated paths (distribution apply, review M3): when the
     * keyword is ALREADY the item's primary, a secondary-role write must not
     * silently demote it — with this flag the existing primary role wins and
     * the call still succeeds. Manual UI paths omit it (an explicit merchant
     * choice to re-add as secondary IS a role change).
     */
    keepExistingPrimary?: boolean;
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

  return serializableWithRetry(db, async (tx) => {
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
    // keepExistingPrimary: a secondary write onto a row that IS the primary
    // keeps the primary role (no silent downgrade).
    const effectiveRole =
      input.role === "secondary" && input.keepExistingPrimary && self?.role === "primary"
        ? "primary"
        : input.role;
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
        role: effectiveRole,
        ...gscData,
      },
      update: { role: effectiveRole, resourceType: input.resourceType, ...gscData },
    });

    return { ok: true } as const;
  });
}

// ── Bulk assignment (PLAN_KEYWORDS_UI_REWORK.md §4.1) ───────────────────────

export interface AssignManyTarget {
  resourceType: KeywordResourceType;
  resourceId: string;
}
export type AssignManySkipReason = "limitReached" | "primaryExists" | "duplicate";
export interface AssignManySkip {
  keywordId: string;
  resourceId: string;
  reason: AssignManySkipReason;
}
export interface AssignManyResult {
  applied: number;
  skipped: AssignManySkip[];
}

/**
 * PURE planner for ONE (item, locale) bucket — the piece that makes the 5er
 * limit + one-primary rule testable and lets the dryRun preview and the real
 * write path share the same accounting. Given the item's CURRENT (item, locale)
 * assignments (`siblings`) it simulates assigning `keywords` in order, tracking
 * a working keyword→role set and a running count so the Nth add that would
 * exceed MAX_KEYWORDS_PER_ITEM is skipped `limitReached`.
 *
 * Mirrors assignKeyword's invariants:
 *  - already present + same role → `duplicate`;
 *  - already present as secondary, requested primary → promotion (may demote a
 *    different existing primary, subject to `demoteExisting`), no count change;
 *  - new keyword over the cap → `limitReached`;
 *  - new primary while a different primary exists → `primaryExists` (skip) or,
 *    with `demoteExisting`, a `demote: true` apply that flips the old primary;
 *  - only ONE primary ever lives in the working set.
 */
export function planItemAssignments(input: {
  resourceId: string;
  keywords: { keywordId: string; role: KeywordRole }[];
  siblings: { keywordId: string; role: KeywordRole }[];
  demoteExisting: boolean;
}): {
  applies: { keywordId: string; role: KeywordRole; demote: boolean }[];
  skipped: AssignManySkip[];
} {
  const { resourceId, keywords, siblings, demoteExisting } = input;
  const working = new Map<string, KeywordRole>();
  for (const s of siblings) working.set(s.keywordId, s.role);
  let count = working.size;

  const applies: { keywordId: string; role: KeywordRole; demote: boolean }[] = [];
  const skipped: AssignManySkip[] = [];

  const currentPrimaryId = (): string | undefined => {
    for (const [id, role] of working) if (role === "primary") return id;
    return undefined;
  };

  for (const req of keywords) {
    const self = working.get(req.keywordId);

    if (self !== undefined) {
      // Already assigned to this item/locale.
      if (self === req.role) {
        skipped.push({ keywordId: req.keywordId, resourceId, reason: "duplicate" });
        continue;
      }
      if (req.role === "primary") {
        // Promotion (self is currently secondary) — may displace a different
        // existing primary, same rule as the new-primary branch. No count change.
        const existing = currentPrimaryId();
        if (existing && existing !== req.keywordId) {
          if (!demoteExisting) {
            skipped.push({ keywordId: req.keywordId, resourceId, reason: "primaryExists" });
            continue;
          }
          working.set(existing, "secondary");
          applies.push({ keywordId: req.keywordId, role: "primary", demote: true });
        } else {
          applies.push({ keywordId: req.keywordId, role: "primary", demote: false });
        }
        working.set(req.keywordId, "primary");
      } else {
        // Demotion (self is currently primary → secondary). No count change.
        applies.push({ keywordId: req.keywordId, role: "secondary", demote: false });
        working.set(req.keywordId, "secondary");
      }
      continue;
    }

    // New keyword for this item/locale.
    if (count >= MAX_KEYWORDS_PER_ITEM) {
      skipped.push({ keywordId: req.keywordId, resourceId, reason: "limitReached" });
      continue;
    }
    if (req.role === "primary") {
      const existing = currentPrimaryId();
      if (existing) {
        if (!demoteExisting) {
          skipped.push({ keywordId: req.keywordId, resourceId, reason: "primaryExists" });
          continue;
        }
        working.set(existing, "secondary");
        applies.push({ keywordId: req.keywordId, role: "primary", demote: true });
      } else {
        applies.push({ keywordId: req.keywordId, role: "primary", demote: false });
      }
      working.set(req.keywordId, "primary");
    } else {
      applies.push({ keywordId: req.keywordId, role: "secondary", demote: false });
      working.set(req.keywordId, "secondary");
    }
    count += 1;
  }

  return { applies, skipped };
}

/**
 * Assign several keywords to several items in one action (plan §4.1). Plans the
 * writes with `planItemAssignments` (per (target, locale) bucket — a keyword
 * only competes with same-locale siblings on that item) for a correct
 * cumulative-limit preview, then — unless `dryRun` — executes each planned
 * apply through `assignKeyword`, whose serializable transaction re-checks every
 * invariant so the real path stays race-safe and consistent with the AI-apply
 * path. Hard aborts become a per-pair skip report instead.
 */
export async function assignMany(
  db: PrismaClient,
  shop: string,
  input: {
    keywordIds: string[];
    targets: AssignManyTarget[];
    role: KeywordRole;
    demoteExisting?: boolean;
    dryRun?: boolean;
  },
): Promise<AssignManyResult> {
  const role = input.role;
  const demoteExisting = input.demoteExisting ?? false;

  // 1. Load the keyword rows; drop unknown/foreign ids (keep requested order).
  const keywordRows = await db.seoKeyword.findMany({
    where: { shop, id: { in: input.keywordIds } },
    select: { id: true, keyword: true, locale: true },
  });
  const keywordById = new Map(keywordRows.map((k) => [k.id, k]));
  const validKeywordIds = input.keywordIds.filter((id) => keywordById.has(id));
  if (validKeywordIds.length === 0 || input.targets.length === 0) {
    return { applied: 0, skipped: [] };
  }

  // 2. Load every existing assignment for the target items in ONE query, and
  //    index siblings by (resourceId, keyword.locale).
  const targetIds = Array.from(new Set(input.targets.map((t) => t.resourceId)));
  const existing = await db.seoKeywordAssignment.findMany({
    where: { shop, resourceId: { in: targetIds } },
    include: { keyword: { select: { id: true, locale: true } } },
  });
  const siblingKey = (resourceId: string, locale: string) => `${resourceId}::${locale}`;
  const siblingIndex = new Map<string, { keywordId: string; role: KeywordRole }[]>();
  for (const a of existing) {
    const key = siblingKey(a.resourceId, a.keyword.locale);
    let bucket = siblingIndex.get(key);
    if (!bucket) {
      bucket = [];
      siblingIndex.set(key, bucket);
    }
    bucket.push({ keywordId: a.keyword.id, role: a.role as KeywordRole });
  }

  // 3. Plan per (target, locale) bucket.
  interface PlannedApply {
    target: AssignManyTarget;
    keywordId: string;
    keyword: string;
    locale: string;
    role: KeywordRole;
    demote: boolean;
  }
  const plannedApplies: PlannedApply[] = [];
  const skipped: AssignManySkip[] = [];

  for (const target of input.targets) {
    const byLocale = new Map<string, { keywordId: string; role: KeywordRole }[]>();
    for (const id of validKeywordIds) {
      const kw = keywordById.get(id)!;
      let bucket = byLocale.get(kw.locale);
      if (!bucket) {
        bucket = [];
        byLocale.set(kw.locale, bucket);
      }
      bucket.push({ keywordId: id, role });
    }
    for (const [locale, requested] of byLocale) {
      const plan = planItemAssignments({
        resourceId: target.resourceId,
        keywords: requested,
        siblings: siblingIndex.get(siblingKey(target.resourceId, locale)) ?? [],
        demoteExisting,
      });
      skipped.push(...plan.skipped);
      for (const a of plan.applies) {
        plannedApplies.push({
          target,
          keywordId: a.keywordId,
          keyword: keywordById.get(a.keywordId)!.keyword,
          locale,
          role: a.role,
          demote: a.demote,
        });
      }
    }
  }

  // 4. dryRun: predicted counts only, no writes.
  if (input.dryRun) {
    return { applied: plannedApplies.length, skipped };
  }

  // 5. Real path: each apply through assignKeyword (race-safe re-check).
  let applied = 0;
  for (const p of plannedApplies) {
    const res = await assignKeyword(db, shop, {
      resourceType: p.target.resourceType,
      resourceId: p.target.resourceId,
      keyword: p.keyword,
      locale: p.locale,
      role: p.role,
      demoteExisting: p.demote,
    });
    if (res.ok) {
      applied += 1;
    } else if (res.reason === "tooMany") {
      skipped.push({ keywordId: p.keywordId, resourceId: p.target.resourceId, reason: "limitReached" });
    } else {
      skipped.push({ keywordId: p.keywordId, resourceId: p.target.resourceId, reason: "primaryExists" });
    }
  }
  return { applied, skipped };
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
  await serializableWithRetry(db, async (tx) => {
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

// ── Cannibalization (PLAN_KEYWORDS_EXPANSION.md §7.1) ───────────────────────

export interface CannibalizationConflict {
  keywordId: string;
  keyword: string;
  locale: string;
  resourceType: string;
  /** The items competing for the same primary keyword (≥ 2). */
  resourceIds: string[];
}

/**
 * Two items of the SAME resource type sharing the same primary keyword
 * cannibalize each other. Product ≠ Collection is deliberately NOT a conflict
 * (a category page ranking for "vases" and a product for "green ceramic vase"
 * is healthy) — hence the (keywordId, resourceType) grouping. Pure over the
 * already-loaded assignment list; the keywords-tab loader feeds it.
 */
export function findCannibalizationConflicts(
  rows: KeywordAssignmentRow[],
): CannibalizationConflict[] {
  const groups = new Map<string, KeywordAssignmentRow[]>();
  for (const row of rows) {
    if (row.role !== "primary") continue;
    const key = `${row.keywordId}::${row.resourceType}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const conflicts: CannibalizationConflict[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    conflicts.push({
      keywordId: bucket[0].keywordId,
      keyword: bucket[0].keyword,
      locale: bucket[0].locale,
      resourceType: bucket[0].resourceType,
      resourceIds: bucket.map((b) => b.resourceId),
    });
  }
  return conflicts.sort((a, b) => a.keyword.localeCompare(b.keyword));
}

// ── Groups (PLAN_KEYWORDS_EXPANSION.md §5.1–§5.3) ───────────────────────────

export interface KeywordGroupRow {
  id: string;
  name: string;
  locale: string;
  description: string | null;
  keywordCount: number;
}

export interface GroupKeywordRow {
  keywordId: string;
  keyword: string;
  locale: string;
  priority: number;
  intent: string | null;
  /** How many items this keyword is currently assigned to (any role). */
  assignmentCount: number;
}

export async function listGroups(
  db: PrismaClient,
  shop: string,
  locale = "",
): Promise<KeywordGroupRow[]> {
  const groups = await db.seoKeywordGroup.findMany({
    where: { shop, locale },
    orderBy: { name: "asc" },
    include: { _count: { select: { memberships: true } } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    locale: g.locale,
    description: g.description,
    keywordCount: g._count.memberships,
  }));
}

export type CreateGroupResult = { ok: true; id: string } | { ok: false; reason: "duplicateName" };

export async function createGroup(
  db: PrismaClient,
  shop: string,
  name: string,
  locale = "",
  description?: string,
): Promise<CreateGroupResult> {
  const trimmed = name.trim();
  const existing = await db.seoKeywordGroup.findUnique({
    where: { shop_name_locale: { shop, name: trimmed, locale } },
    select: { id: true },
  });
  if (existing) return { ok: false, reason: "duplicateName" };
  try {
    const created = await db.seoKeywordGroup.create({
      data: { shop, name: trimmed, locale, description: description?.trim() || null },
    });
    return { ok: true, id: created.id };
  } catch (err) {
    // Parallel create of the same name races past the pre-check — the unique
    // constraint answers P2002, which is just "duplicateName", not a 500.
    // (Duck-typed — no @prisma/client value import in this client-safe module.)
    if ((err as { code?: string } | null)?.code === "P2002") {
      return { ok: false, reason: "duplicateName" };
    }
    throw err;
  }
}

/** Rename a group (plan §5.1) — same duplicate-name semantics as create;
 *  an unknown/foreign id reports `notFound` (e.g. deleted in another tab). */
export async function renameGroup(
  db: PrismaClient,
  shop: string,
  groupId: string,
  name: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: "duplicateName" | "notFound" }> {
  const trimmed = name.trim();
  const group = await db.seoKeywordGroup.findFirst({
    where: { id: groupId, shop },
    select: { id: true },
  });
  if (!group) return { ok: false, reason: "notFound" };
  try {
    await db.seoKeywordGroup.update({ where: { id: group.id }, data: { name: trimmed } });
    return { ok: true, id: group.id };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "P2002") {
      return { ok: false, reason: "duplicateName" };
    }
    throw err;
  }
}

/** Delete a group — the group now OWNS its keywords (§3.2). Deleting it removes
 *  every member keyword that is not also in another group, regardless of item
 *  assignments; those assignments (and their snapshots) cascade via
 *  onDelete: Cascade. A keyword that also belongs to another group survives. */
export async function deleteGroup(db: PrismaClient, shop: string, groupId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const group = await tx.seoKeywordGroup.findFirst({ where: { id: groupId, shop }, select: { id: true } });
    if (!group) return;
    // Defensively shop-scoped (review H1): should a foreign-shop membership
    // ever exist in this group, the orphan cleanup must not touch the other
    // tenant's keywords.
    const memberKeywordIds = (
      await tx.seoKeywordGroupMembership.findMany({ where: { groupId, shop }, select: { keywordId: true } })
    ).map((m) => m.keywordId);
    await tx.seoKeywordGroup.delete({ where: { id: groupId } }); // cascades memberships
    if (memberKeywordIds.length) {
      await tx.seoKeyword.deleteMany({
        where: {
          id: { in: memberKeywordIds },
          shop,
          groups: { none: {} },
        },
      });
    }
  });
}

export async function getGroupKeywords(
  db: PrismaClient,
  shop: string,
  groupId: string,
): Promise<GroupKeywordRow[]> {
  const memberships = await db.seoKeywordGroupMembership.findMany({
    where: { groupId, shop },
    include: {
      keyword: {
        include: { _count: { select: { assignments: true } } },
      },
    },
  });
  return memberships
    .map((m) => ({
      keywordId: m.keyword.id,
      keyword: m.keyword.keyword,
      locale: m.keyword.locale,
      priority: m.keyword.priority,
      intent: m.keyword.intent,
      assignmentCount: m.keyword._count.assignments,
    }))
    .sort((a, b) => a.priority - b.priority || a.keyword.localeCompare(b.keyword));
}

/** How many of a locale's keywords belong to no group at all (§3.2 ungrouped
 *  bucket count — drives the sidebar badge without loading the rows). */
export async function countUngrouped(db: PrismaClient, shop: string, locale = ""): Promise<number> {
  return db.seoKeyword.count({ where: { shop, locale, groups: { none: {} } } });
}

/** The ungrouped keywords for one locale (§3.2), same row shape + sort as
 *  getGroupKeywords — the "Ungrouped" pseudo-group's keyword list. */
export async function listUngrouped(
  db: PrismaClient,
  shop: string,
  locale = "",
): Promise<GroupKeywordRow[]> {
  const keywords = await db.seoKeyword.findMany({
    where: { shop, locale, groups: { none: {} } },
    include: { _count: { select: { assignments: true } } },
  });
  return keywords
    .map((k) => ({
      keywordId: k.id,
      keyword: k.keyword,
      locale: k.locale,
      priority: k.priority,
      intent: k.intent,
      assignmentCount: k._count.assignments,
    }))
    .sort((a, b) => a.priority - b.priority || a.keyword.localeCompare(b.keyword));
}

/** How many keywords a locale has in total (§2.1 "Alle" pseudo-group badge —
 *  drives the sidebar count without loading the rows). */
export async function countAllKeywords(db: PrismaClient, shop: string, locale = ""): Promise<number> {
  return db.seoKeyword.count({ where: { shop, locale } });
}

/** Every keyword of one locale (§2.1 "Alle" pseudo-group), same row shape +
 *  sort as getGroupKeywords/listUngrouped. */
export async function listAllKeywords(
  db: PrismaClient,
  shop: string,
  locale = "",
): Promise<GroupKeywordRow[]> {
  const keywords = await db.seoKeyword.findMany({
    where: { shop, locale },
    include: { _count: { select: { assignments: true } } },
  });
  return keywords
    .map((k) => ({
      keywordId: k.id,
      keyword: k.keyword,
      locale: k.locale,
      priority: k.priority,
      intent: k.intent,
      assignmentCount: k._count.assignments,
    }))
    .sort((a, b) => a.priority - b.priority || a.keyword.localeCompare(b.keyword));
}

export interface GroupImportEntry {
  keyword: string;
  locale?: string;
  priority?: number;
  intent?: string | null;
}

/**
 * Upsert keywords (by (shop, keyword, locale)) and put them into a group —
 * the CSV importer's write path, also used for single manual adds. The locale
 * is OWNED by the group (§3.1 invariant: membership.keyword.locale ===
 * group.locale), so `entry.locale` is IGNORED — every keyword is created under
 * the group's locale. Explicit priority/intent from the file win over an
 * existing keyword's values; omitted ones (undefined priority / null intent)
 * leave the existing row untouched. Returns how many keywords were newly added
 * to the group vs. already members. A missing/foreign group is a no-op.
 *
 * Batched (review L13): a 2000-row import used to be ~6000 sequential
 * queries inside a synchronous Remix action — now it's a handful of
 * findMany/createMany calls plus one updateMany per distinct explicit
 * (priority, intent) combination (≤ 15).
 */
export async function addKeywordsToGroup(
  db: PrismaClient,
  shop: string,
  groupId: string,
  entries: GroupImportEntry[],
): Promise<{ added: number; alreadyInGroup: number }> {
  // Normalize + dedupe within the request by (keyword, locale) — later
  // duplicates win so an explicit priority late in the file still applies.
  const group = await db.seoKeywordGroup.findFirst({
    where: { id: groupId, shop },
    select: { locale: true },
  });
  if (!group) return { added: 0, alreadyInGroup: 0 };
  const byKey = new Map<string, { keyword: string; locale: string; priority?: number; intent?: string | null }>();
  for (const entry of entries) {
    const keyword = normalizeKeyword(entry.keyword);
    if (!keyword) continue;
    // The locale is owned by the group, not the entry (invariant).
    const locale = group.locale;
    byKey.set(`${keyword} ${locale}`, { keyword, locale, priority: entry.priority, intent: entry.intent });
  }
  if (byKey.size === 0) return { added: 0, alreadyInGroup: 0 };
  const normalized = Array.from(byKey.values());
  const texts = Array.from(new Set(normalized.map((e) => e.keyword)));

  const keyOf = (k: { keyword: string; locale: string }) => `${k.keyword} ${k.locale}`;
  const loadIds = async (): Promise<Map<string, string>> => {
    const rows = await db.seoKeyword.findMany({
      where: { shop, keyword: { in: texts } },
      select: { id: true, keyword: true, locale: true },
    });
    return new Map(rows.map((r) => [keyOf(r), r.id]));
  };

  const existingIds = await loadIds();

  // 1. Create the missing keywords in one shot.
  const toCreate = normalized.filter((e) => !existingIds.has(keyOf(e)));
  if (toCreate.length) {
    await db.seoKeyword.createMany({
      data: toCreate.map((e) => ({
        shop,
        keyword: e.keyword,
        locale: e.locale,
        priority: e.priority ?? 2,
        intent: e.intent ?? null,
      })),
      skipDuplicates: true,
    });
  }

  // 2. Explicit priority/intent overrides for PRE-EXISTING rows, grouped by
  //    value combination so 2000 explicit rows become ≤ 15 updateMany calls.
  const overrideGroups = new Map<string, { priority?: number; intent?: string; ids: string[] }>();
  for (const e of normalized) {
    const id = existingIds.get(keyOf(e));
    if (!id) continue; // freshly created above — values already right
    const hasPriority = e.priority != null;
    const hasIntent = e.intent != null;
    if (!hasPriority && !hasIntent) continue;
    const comboKey = `${hasPriority ? e.priority : "-"}::${hasIntent ? e.intent : "-"}`;
    const group = overrideGroups.get(comboKey) ?? {
      ...(hasPriority ? { priority: e.priority } : {}),
      ...(hasIntent ? { intent: e.intent as string } : {}),
      ids: [],
    };
    group.ids.push(id);
    overrideGroups.set(comboKey, group);
  }
  for (const group of overrideGroups.values()) {
    await db.seoKeyword.updateMany({
      where: { id: { in: group.ids }, shop },
      data: {
        ...(group.priority != null ? { priority: group.priority } : {}),
        ...(group.intent != null ? { intent: group.intent } : {}),
      },
    });
  }

  // 3. Memberships: diff against the existing set, insert the rest in one go.
  const allIds = await loadIds();
  const memberIds = normalized
    .map((e) => allIds.get(keyOf(e)))
    .filter((id): id is string => typeof id === "string");
  const existingMemberships = await db.seoKeywordGroupMembership.findMany({
    where: { groupId, keywordId: { in: memberIds } },
    select: { keywordId: true },
  });
  const have = new Set(existingMemberships.map((m) => m.keywordId));
  const toAdd = memberIds.filter((id) => !have.has(id));
  if (toAdd.length) {
    await db.seoKeywordGroupMembership.createMany({
      data: toAdd.map((keywordId) => ({ shop, groupId, keywordId })),
      skipDuplicates: true,
    });
  }
  return { added: toAdd.length, alreadyInGroup: memberIds.length - toAdd.length };
}

/** Remove one keyword from a group (orphan cleanup like removeAssignment). */
export async function removeKeywordFromGroup(
  db: PrismaClient,
  shop: string,
  groupId: string,
  keywordId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const membership = await tx.seoKeywordGroupMembership.findFirst({
      where: { groupId, keywordId, shop },
      select: { id: true },
    });
    if (!membership) return;
    await tx.seoKeywordGroupMembership.delete({ where: { id: membership.id } });
    const [assignments, memberships] = await Promise.all([
      tx.seoKeywordAssignment.count({ where: { keywordId } }),
      tx.seoKeywordGroupMembership.count({ where: { keywordId } }),
    ]);
    if (assignments === 0 && memberships === 0) {
      await tx.seoKeyword.delete({ where: { id: keywordId } });
    }
  });
}

// ── Moving a keyword between groups and/or languages ────────────────────────

export interface MoveKeywordInput {
  keywordId: string;
  /**
   * The group the keyword is currently viewed in — its membership is dropped
   * on a same-language move. Empty/undefined for the "Alle" / "Ohne Gruppe"
   * pseudo groups: there is no source membership to drop, so a same-language
   * move only ADDS the target membership. A language change always drops every
   * membership (groups are locale-scoped, §3.1).
   */
  fromGroupId?: string | null;
  /** "" = the shop's primary locale (the SeoKeyword convention). */
  targetLocale: string;
  /** null = no group — the keyword lands in the "Ohne Gruppe" bucket. */
  targetGroupId: string | null;
}

export type MoveKeywordResult =
  | {
      ok: true;
      /** The keyword row the caller should now look at — a NEW id whenever the
       *  language changed and the target language already had that keyword. */
      keywordId: string;
      /** Item assignments carried over into the target language. */
      movedAssignments: number;
      /** Assignments that arrived as secondary because the item already had a
       *  primary in the target language. */
      demoted: number;
      /** Assignments dropped: the item already tracks this keyword in the
       *  target language, or it is at MAX_KEYWORDS_PER_ITEM there. */
      droppedAssignments: number;
    }
  | { ok: false; reason: "notFound" | "groupLocaleMismatch" };

/**
 * Move ONE keyword to another group and/or another language (the merchant-side
 * fix for a keyword that was tracked under the wrong language — historically a
 * one-way street, since every writer created keywords under the language it
 * happened to be on).
 *
 * Same language → pure membership churn (drop `fromGroupId`, add
 * `targetGroupId`), nothing else moves.
 *
 * Different language → the (shop, keyword, locale) unique key means the row
 * itself cannot be re-stamped when the target language already knows this
 * keyword, so the keyword is MERGED into the target language's row and the old
 * one is deleted:
 *  - item assignments are re-pointed at the target row, honouring BOTH
 *    invariants of the target language: at most one primary per (item, locale)
 *    — a moved primary that meets an existing one lands as secondary — and the
 *    MAX_KEYWORDS_PER_ITEM cap per (item, locale).
 *  - an assignment whose item already tracks the keyword in the target
 *    language is dropped (the existing row wins — it may carry GSC history).
 *  - memberships are NOT carried over: a group belongs to exactly one language
 *    (§3.1), so the caller picks the target group (or "no group").
 *
 * Serializable like assignKeyword: the primary check+swap below has the same
 * race as the one there.
 */
export async function moveKeyword(
  db: PrismaClient,
  shop: string,
  input: MoveKeywordInput,
): Promise<MoveKeywordResult> {
  return serializableWithRetry(db, async (tx) => {
    const source = await tx.seoKeyword.findFirst({
      where: { id: input.keywordId, shop },
      select: { id: true, keyword: true, locale: true, priority: true, intent: true },
    });
    if (!source) return { ok: false, reason: "notFound" } as const;

    // A target group must exist, belong to this shop AND to the target
    // language — otherwise the move would create the very inconsistency
    // (membership.keyword.locale !== group.locale) §3.1 rules out.
    if (input.targetGroupId) {
      const group = await tx.seoKeywordGroup.findFirst({
        where: { id: input.targetGroupId, shop },
        select: { id: true, locale: true },
      });
      if (!group) return { ok: false, reason: "notFound" } as const;
      if (group.locale !== input.targetLocale) {
        return { ok: false, reason: "groupLocaleMismatch" } as const;
      }
    }

    const addMembership = async (keywordId: string) => {
      if (!input.targetGroupId) return;
      const existing = await tx.seoKeywordGroupMembership.findFirst({
        where: { groupId: input.targetGroupId, keywordId },
        select: { id: true },
      });
      if (!existing) {
        await tx.seoKeywordGroupMembership.create({
          data: { shop, groupId: input.targetGroupId, keywordId },
        });
      }
    };

    // ── Same language: membership churn only ──
    if (source.locale === input.targetLocale) {
      if (input.fromGroupId && input.fromGroupId !== input.targetGroupId) {
        await tx.seoKeywordGroupMembership.deleteMany({
          where: { groupId: input.fromGroupId, keywordId: source.id, shop },
        });
      }
      await addMembership(source.id);
      return {
        ok: true,
        keywordId: source.id,
        movedAssignments: 0,
        demoted: 0,
        droppedAssignments: 0,
      } as const;
    }

    // ── Language change: merge into the target language's keyword row ──
    const target =
      (await tx.seoKeyword.findUnique({
        where: {
          shop_keyword_locale: { shop, keyword: source.keyword, locale: input.targetLocale },
        },
        select: { id: true },
      })) ??
      (await tx.seoKeyword.create({
        data: {
          shop,
          keyword: source.keyword,
          locale: input.targetLocale,
          priority: source.priority,
          intent: source.intent,
        },
        select: { id: true },
      }));

    const sourceAssignments = await tx.seoKeywordAssignment.findMany({
      where: { shop, keywordId: source.id },
      select: { id: true, resourceId: true, resourceType: true, role: true },
    });

    let movedAssignments = 0;
    let demoted = 0;
    let droppedAssignments = 0;

    if (sourceAssignments.length > 0) {
      const resourceIds = Array.from(new Set(sourceAssignments.map((a) => a.resourceId)));
      // Everything the target language already tracks on those items — the cap
      // and the single-primary rule are both per (item, locale).
      const existing = await tx.seoKeywordAssignment.findMany({
        where: { shop, resourceId: { in: resourceIds }, keyword: { locale: input.targetLocale } },
        select: { keywordId: true, resourceId: true, role: true },
      });
      const byResource = new Map<string, { keywordId: string; role: string }[]>();
      for (const a of existing) {
        const bucket = byResource.get(a.resourceId) ?? [];
        bucket.push({ keywordId: a.keywordId, role: a.role });
        byResource.set(a.resourceId, bucket);
      }

      for (const assignment of sourceAssignments) {
        const siblings = byResource.get(assignment.resourceId) ?? [];
        // The item already tracks this keyword in the target language: keep
        // that row (it may carry GSC history) and drop the incoming one.
        if (siblings.some((s) => s.keywordId === target.id)) {
          await tx.seoKeywordAssignment.delete({ where: { id: assignment.id } });
          droppedAssignments += 1;
          continue;
        }
        if (siblings.length >= MAX_KEYWORDS_PER_ITEM) {
          await tx.seoKeywordAssignment.delete({ where: { id: assignment.id } });
          droppedAssignments += 1;
          continue;
        }
        let role = assignment.role;
        if (role === "primary" && siblings.some((s) => s.role === "primary")) {
          role = "secondary";
          demoted += 1;
        }
        await tx.seoKeywordAssignment.update({
          where: { id: assignment.id },
          data: { keywordId: target.id, role },
        });
        siblings.push({ keywordId: target.id, role });
        byResource.set(assignment.resourceId, siblings);
        movedAssignments += 1;
      }
    }

    // Old-language memberships cannot follow (groups are locale-scoped), so
    // the source row is now empty — drop it and wire up the chosen target group.
    await tx.seoKeywordGroupMembership.deleteMany({ where: { keywordId: source.id, shop } });
    await tx.seoKeyword.delete({ where: { id: source.id } });
    await addMembership(target.id);

    return {
      ok: true,
      keywordId: target.id,
      movedAssignments,
      demoted,
      droppedAssignments,
    } as const;
  });
}

/** Inline priority edit (keywords table + group detail, plan §5.2). */
export async function setKeywordPriority(
  db: PrismaClient,
  shop: string,
  keywordId: string,
  priority: number,
): Promise<void> {
  if (priority !== 1 && priority !== 2 && priority !== 3) return;
  await db.seoKeyword.updateMany({ where: { id: keywordId, shop }, data: { priority } });
}

/** Bulk action (plan §5.1 group detail): set the priority of EVERY keyword in
 *  a group in one statement. Returns the number of updated keywords. */
export async function setGroupPriority(
  db: PrismaClient,
  shop: string,
  groupId: string,
  priority: number,
): Promise<number> {
  if (priority !== 1 && priority !== 2 && priority !== 3) return 0;
  const group = await db.seoKeywordGroup.findFirst({
    where: { id: groupId, shop },
    select: { id: true },
  });
  if (!group) return 0;
  const updated = await db.seoKeyword.updateMany({
    where: { shop, groups: { some: { groupId } } },
    data: { priority },
  });
  return updated.count;
}

/**
 * Cross-item cannibalization pre-check for MANUAL primary creation (plan
 * §7.1): is this (keyword, locale) already someone else's primary on another
 * item of the same resource type? Returns that item's id, or null. The
 * writer paths use it to drive a confirm dialog — automated paths (adopt,
 * distribution) skip it by design.
 */
export async function findPrimaryElsewhere(
  db: PrismaClient,
  shop: string,
  input: { keyword: string; locale?: string; resourceType: KeywordResourceType; excludeResourceId: string },
): Promise<{ resourceId: string } | null> {
  const keyword = normalizeKeyword(input.keyword);
  if (!keyword) return null;
  const assignment = await db.seoKeywordAssignment.findFirst({
    where: {
      shop,
      role: "primary",
      resourceType: input.resourceType,
      resourceId: { not: input.excludeResourceId },
      keyword: { keyword, locale: input.locale ?? "" },
    },
    select: { resourceId: true },
  });
  return assignment;
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

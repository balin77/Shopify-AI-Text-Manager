/**
 * Internal Linking Suggestions (Phase 2 of PLAN_SEO_SUITE_COMPLETION.md §4).
 *
 * "12 mentions of 'ceramic vase' across blog articles could link to product
 * X." Pure DB-cache content analysis (contract §3/§6) — no live fetch, so
 * this is independent of the Phase 1 crawler.
 *
 * ── Algorithm (§4.1) ────────────────────────────────────────────────────────
 * 1. TARGET set: Product/Collection rows with a handle, keyed to their
 *    keyword assignments (SeoKeywordAssignment via keywords.service's
 *    `listAssignments`, primary + secondary, KEYWORDS_CONTRACT.md already
 *    shipped) plus title, plus optional AI synonyms (§4.4 below). Draft/
 *    archived PRODUCTS are excluded as targets (Collection has no status
 *    column in the DB cache — see CLAUDE.md, so it can't be filtered the
 *    same way; documented gap, not a bug).
 * 2. SOURCE set: HTML bodies of Article/Page + Product descriptionHtml (DB
 *    cache, uncapped by status — the plan's skip-rule is target-only).
 * 3. MATCH: per source, per target, try that target's anchors in priority
 *    order (title > primary keyword > secondary > synonym) against the
 *    source's TEXT NODES ONLY — never inside an existing `<a>`, never inside
 *    a heading, and never via a regex sweep of the raw HTML string (cheerio
 *    DOM traversal only, so `<a href="x">Product Foo</a>` never becomes a
 *    nested link, and "Foo" inside `<h2>` is never turned into an anchor).
 *    Skips: source already links to target (href contains the target's
 *    `/products/<handle>` or `/collections/<handle>` path); target === source;
 *    target draft/archived (Product only, see above).
 * 4. CONFIDENCE: base score per match kind (title > primary > secondary >
 *    synonym), reduced by how late in the document the match occurred.
 * 5. Idempotent upsert into `SeoInternalLinkSuggestion` — a `dismissed` row
 *    whose `dismissedUntil` is still in the future is left untouched.
 *
 * ── Locale (§4.1 "Locale rule") ─────────────────────────────────────────────
 * v1 only matches PRIMARY-locale content (source locale = primary is
 * explicitly the plan's assumption; cross-locale matching is a stated
 * non-goal). Every suggestion this module produces therefore carries
 * `locale: ""`. Keyword anchors are filtered to `locale === ""` for the same
 * reason (SeoKeyword.locale: "" = primary, see KEYWORDS_CONTRACT.md §1).
 *
 * ── resourceType casing ─────────────────────────────────────────────────────
 * "Product" | "Collection" | "Article" | "Page" — the SAME capitalized
 * convention as ContentTranslation/SeoKeywordAssignment/SeoGscPageStat/
 * FreshnessResourceType, NOT SeoCrawlPage's lowercase `AuditType` convention.
 * Chosen because the target set is built directly from SeoKeywordAssignment
 * rows, which already use this casing — converting back and forth would be
 * pure friction with no benefit.
 *
 * ── Synonym cache (§4.4 / §11.1, "open for implementation") ─────────────────
 * DECISION: ephemeral-per-run, ADR-style reasoning below. No schema change,
 * no GDPR surface added beyond the suggestion rows themselves.
 *   - A persistent synonym cache (JSON column on Product/Collection, or a new
 *     table) would need its own invalidation story (title changes, keyword
 *     re-assignment) that nothing else in this codebase currently tracks for
 *     ANY AI-derived field — every existing AI cache in this app (alt text,
 *     generated titles, etc.) is either a direct content field (invalidated
 *     by the normal edit flow) or genuinely ephemeral. Synonyms have no
 *     natural "this changed" signal to key off.
 *   - The run is merchant-triggered and infrequent (a manual button, not a
 *     cron), and the match loop itself is LLM-free — so the "cost" of
 *     ephemeral is a handful of BATCHED synonym requests once per manual run
 *     (SYNONYM_BATCH_SIZE terms each, capped at MAX_SYNONYM_TARGETS targets),
 *     not one request per target and not once per page view or scheduled
 *     sweep.
 *
 * ── Rejection feedback (merchant "Ablehnen") ────────────────────────────────
 * A rejected suggestion is suppressed on TWO levels:
 *   1. Deterministic, per (source, target) pair: a `dismissed` row with
 *      `dismissedUntil: null` is never revived by a later run (step 5 above) —
 *      this is the actual guarantee that the same suggestion isn't re-made.
 *   2. As an AI input: the anchor texts rejected for a target are passed into
 *      the next run's synonym prompt as "already rejected, do not repeat", and
 *      any that come back anyway are filtered out. Rejections deliberately
 *      only suppress SYNONYM anchors, never the target's own title/keyword
 *      anchors — a merchant who rejects a link from article A must still be
 *      offered the same product from page B.
 *   - If usage data later shows merchants re-running this often enough that
 *     synonym cost dominates, the fix is a cache keyed by (title, locale) —
 *     but that is speculative today, so it is not built (contract: don't
 *     build ahead of evidence).
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { PrismaClient } from "@prisma/client";
import { listAssignments } from "./keywords.service";
import { MAX_AUDIT_ITEMS_PER_TYPE } from "./audit.service";

// ── Constants ────────────────────────────────────────────────────────────────

/** §4.1 "Cap": at most this many suggestions surface per source item per run. */
export const MAX_SUGGESTIONS_PER_SOURCE = 3;
/** §4.1 "Cap": at most this many `pending` suggestions open per shop at once. */
export const MAX_PENDING_PER_SHOP = 200;
/**
 * Bounds the number of target items enriched with AI synonyms in one run
 * (capped so a shop with thousands of products/collections can't turn one
 * button click into an unbounded amount of AI work). Targets beyond this cap
 * still match on title/keywords, just without synonyms.
 */
export const MAX_SYNONYM_TARGETS = 200;
/**
 * Terms per synonym AI request. The plan's §4.3 sketch ("roughly 1 call per
 * target item") turned out to be the dominant cost of a run — 200 targets =
 * 200 requests for a few words each. Synonym lists are tiny, so they batch:
 * with 25 terms per request the same 200 targets cost 8 requests instead of
 * 200 (~96% fewer), with no change to the match algorithm (which is LLM-free).
 * Kept small enough that one malformed response only costs one chunk's
 * synonyms (the batch degrades to "no synonyms", never to a mis-aligned
 * mapping — see AIService.generateSynonymsBatch).
 */
export const SYNONYM_BATCH_SIZE = 25;
/** §4.3 heartbeat cadence. */
export const HEARTBEAT_EVERY_SOURCES = 20;

export type TargetResourceType = "Product" | "Collection";
export type SourceResourceType = "Product" | "Article" | "Page";
export type AnchorKind = "title" | "primary" | "secondary" | "synonym";

const KIND_BASE_CONFIDENCE: Record<AnchorKind, number> = {
  title: 0.95,
  primary: 0.85,
  secondary: 0.7,
  synonym: 0.55,
};

export interface AnchorCandidate {
  text: string;
  kind: AnchorKind;
}

export interface TargetItem {
  resourceType: TargetResourceType;
  resourceId: string;
  handle: string;
  title: string;
  /** Priority-ordered: title, then primary keyword, then secondaries, then synonyms. */
  anchors: AnchorCandidate[];
}

export interface SourceItem {
  resourceType: SourceResourceType;
  resourceId: string;
  html: string;
}

export interface LinkMatch {
  toResourceType: TargetResourceType;
  toResourceId: string;
  anchorText: string; // the exact substring found in the source
  confidence: number;
  matchKind: AnchorKind;
}

// ── Anchor candidates (pure) ────────────────────────────────────────────────

/**
 * Priority-ordered, de-duplicated (case-insensitive) anchor list for one
 * target item — title first, then primary keyword, then secondaries in the
 * order given, then synonyms in the order given.
 */
export function buildAnchorCandidates(input: {
  title: string;
  primaryKeyword?: string | null;
  secondaryKeywords?: string[];
  synonyms?: string[];
}): AnchorCandidate[] {
  const seen = new Set<string>();
  const out: AnchorCandidate[] = [];
  const push = (text: string | null | undefined, kind: AnchorKind) => {
    const t = (text || "").trim();
    if (!t) return;
    const key = t.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, kind });
  };
  push(input.title, "title");
  push(input.primaryKeyword, "primary");
  for (const s of input.secondaryKeywords ?? []) push(s, "secondary");
  for (const s of input.synonyms ?? []) push(s, "synonym");
  return out;
}

/** `/products/<handle>` or `/collections/<handle>` — the storefront path
 *  used both for the "already linked" check and the Accept-time href. */
export function targetUrlPath(target: { resourceType: TargetResourceType; handle: string }): string {
  const segment = target.resourceType === "Product" ? "products" : "collections";
  return `/${segment}/${target.handle}`;
}

// ── cheerio text-node traversal (pure) ──────────────────────────────────────

const EXCLUDED_ANCESTOR_SELECTOR = "a, h1, h2, h3, h4, h5, h6, script, style, title";

interface TextNodeRef {
  el: AnyNode; // cheerio/domhandler text node
  text: string;
}

/**
 * Every non-empty text node in the document EXCEPT ones nested inside an
 * `<a>`, a heading, or `<script>`/`<style>`/`<title>` — the eligible surface
 * for both matching (§4.1 "nur Text-Knoten... nicht innerhalb bestehender
 * <a>, nicht in Headings") and insertion (Accept flow, §4.2).
 */
function collectTextNodes($: cheerio.CheerioAPI): TextNodeRef[] {
  const out: TextNodeRef[] = [];
  $("*")
    .addBack()
    .contents()
    .each((_i, el) => {
      if (el.type !== "text") return;
      const text = el.data;
      if (!text || !text.trim()) return;
      const parent = $(el).parent();
      if (parent.length && parent.closest(EXCLUDED_ANCESTOR_SELECTOR).length > 0) return;
      out.push({ el, text });
    });
  return out;
}

function collectHrefs($: cheerio.CheerioAPI): string[] {
  const hrefs: string[] = [];
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (href) hrefs.push(href);
  });
  return hrefs;
}

/** Exact handle-segment comparison (§ fix 7) — a naive `h.includes(needle)`
 *  would treat `/products/vase-large` as already linking to `/products/vase`
 *  (prefix collision). Parses the href's path and compares the final
 *  segment exactly, tolerant of a trailing slash and of relative/absolute
 *  hrefs (a bare `new URL(href)` would throw on `/products/vase`). */
function isAlreadyLinked(hrefs: string[], target: { resourceType: TargetResourceType; handle: string }): boolean {
  const needle = targetUrlPath(target);
  const needleSegments = needle.split("/").filter(Boolean);
  return hrefs.some((h) => {
    let pathname: string;
    try {
      pathname = new URL(h, "https://placeholder.invalid").pathname;
    } catch {
      return false;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length < needleSegments.length) return false;
    const tail = segments.slice(segments.length - needleSegments.length);
    return tail.every((seg, i) => seg === needleSegments[i]);
  });
}

/**
 * Unicode-aware whole-word/whole-phrase, case-insensitive match (same
 * boundary trick as keywords.service's private `buildWordBoundaryRegex` —
 * re-implemented rather than imported/exported because this one needs the
 * match INDEX for position-based confidence and insertion, which the
 * presence/counting use case in keywords.service never needed).
 */
function buildAnchorRegex(anchorText: string): RegExp {
  const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "iu");
}

/** First occurrence of `anchorText` across the text nodes, in document order,
 *  plus its character offset into the concatenated eligible text (for the
 *  position-based confidence penalty). Null when no eligible node matches. */
function findFirstMatch(textNodes: TextNodeRef[], anchorText: string): { matchedText: string; charOffset: number } | null {
  if (!anchorText.trim()) return null;
  const re = buildAnchorRegex(anchorText);
  let offset = 0;
  for (const node of textNodes) {
    const m = node.text.match(re);
    if (m && typeof m.index === "number") {
      return { matchedText: m[1], charOffset: offset + m.index };
    }
    offset += node.text.length;
  }
  return null;
}

function computeConfidence(kind: AnchorKind, positionRatio: number): number {
  const base = KIND_BASE_CONFIDENCE[kind];
  const positionPenalty = Math.min(0.15, Math.max(0, positionRatio) * 0.15);
  const raw = base - positionPenalty;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}

// ── Per-source matching (pure — no DB, no network) ──────────────────────────

/**
 * Match every candidate target against one source's HTML, returning up to
 * `MAX_SUGGESTIONS_PER_SOURCE` matches sorted by confidence. `targets` must
 * already exclude the source item itself (target === source is a §4.1 skip
 * the caller applies before calling this, since it needs no HTML parsing).
 */
export function matchSourceAgainstTargets(
  sourceHtml: string | null | undefined,
  targets: TargetItem[],
  maxPerSource: number = MAX_SUGGESTIONS_PER_SOURCE,
): LinkMatch[] {
  if (!sourceHtml || !sourceHtml.trim() || targets.length === 0) return [];

  const $ = cheerio.load(sourceHtml);
  const textNodes = collectTextNodes($);
  if (textNodes.length === 0) return [];
  const totalLength = textNodes.reduce((sum, n) => sum + n.text.length, 0) || 1;
  const hrefs = collectHrefs($);

  const candidates: LinkMatch[] = [];
  for (const target of targets) {
    if (isAlreadyLinked(hrefs, target)) continue;
    for (const anchor of target.anchors) {
      const match = findFirstMatch(textNodes, anchor.text);
      if (!match) continue;
      candidates.push({
        toResourceType: target.resourceType,
        toResourceId: target.resourceId,
        anchorText: match.matchedText,
        confidence: computeConfidence(anchor.kind, match.charOffset / totalLength),
        matchKind: anchor.kind,
      });
      break; // priority order already encoded in target.anchors — first hit wins for this target
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, maxPerSource);
}

// ── Accept-time insertion (pure) ────────────────────────────────────────────

export interface InsertLinkResult {
  html: string;
  inserted: boolean;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtmlText(s).replace(/"/g, "&quot;");
}

/**
 * cheerio-based link insertion for the Accept flow (§4.2) — finds the FIRST
 * eligible text node (same exclusion rules as matching: not inside an `<a>`
 * or heading) containing `anchorText` and wraps just that substring in
 * `<a href="href">`, leaving every surrounding tag untouched. NEVER a regex
 * replace over the raw HTML string (would silently strip/garble the rest of
 * the markup on any real-world rich-text body).
 *
 * Returns `{ inserted: false }` unchanged when the anchor text is no longer
 * present (content changed since the suggestion was generated) — callers
 * must treat that as "suggestion stale", not silently save unrelated HTML.
 */
export function insertLinkIntoHtml(sourceHtml: string, anchorText: string, href: string): InsertLinkResult {
  if (!sourceHtml || !sourceHtml.trim() || !anchorText.trim()) {
    return { html: sourceHtml, inserted: false };
  }

  // Fragment mode (§ fix 3): `cheerio.load(sourceHtml)` (document mode)
  // hoists a leading `<style>`/`<meta>`/`<title>`/`<link>`/`<base>` into a
  // synthesized `<head>`, and `$("body").html()` then excludes it —
  // silently DELETING those elements from the saved content. Loading as a
  // fragment (`cheerio.load(sourceHtml, null, false)`) + serializing the
  // fragment root directly (`$.html()`, not `$("body").html()`) keeps
  // every element exactly where it was.
  const $ = cheerio.load(sourceHtml, null, false);
  const textNodes = collectTextNodes($);
  const re = buildAnchorRegex(anchorText);

  for (const { el, text } of textNodes) {
    const m = text.match(re);
    if (!m || typeof m.index !== "number") continue;

    const matchedText = m[1];
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + matchedText.length);
    const linkHtml = `<a href="${escapeHtmlAttr(href)}">${escapeHtmlText(matchedText)}</a>`;
    const replacementHtml = `${escapeHtmlText(before)}${linkHtml}${escapeHtmlText(after)}`;

    $(el).replaceWith(replacementHtml);
    return { html: $.html(), inserted: true };
  }

  return { html: sourceHtml, inserted: false };
}

// ── DB orchestration ─────────────────────────────────────────────────────────

export interface InternalLinksSummary {
  targetsConsidered: number;
  targetsWithSynonyms: number;
  /** How many AI requests the synonym stage actually issued (one per batch of
   *  SYNONYM_BATCH_SIZE targets, not one per target). Surfaced in the Task
   *  result so the AI cost of a run is visible without reading logs. */
  synonymRequests: number;
  sourcesScanned: number;
  created: number;
  updated: number;
  /** True if the shop's MAX_PENDING_PER_SHOP cap was hit before every source
   *  was scanned — some real matches were not persisted this run. */
  cappedByPendingLimit: boolean;
}

export interface AssignmentLike {
  resourceType: string;
  resourceId: string;
  keyword: string;
  role: "primary" | "secondary";
  locale: string;
}

/** Build the per-target keyword map (primary + secondaries) from the shop's
 *  full assignment list, filtered to primary-locale Product/Collection rows
 *  (§4.1 locale rule). Exported for the locale-isolation unit test — a
 *  foreign-locale keyword assignment must never surface as an anchor. */
export function keywordsByResource(assignments: AssignmentLike[]): Map<string, { primary: string | null; secondaries: string[] }> {
  const map = new Map<string, { primary: string | null; secondaries: string[] }>();
  for (const a of assignments) {
    if (a.locale !== "") continue;
    if (a.resourceType !== "Product" && a.resourceType !== "Collection") continue;
    const key = `${a.resourceType}:${a.resourceId}`;
    const entry = map.get(key) ?? { primary: null, secondaries: [] };
    if (a.role === "primary") entry.primary = a.keyword;
    else entry.secondaries.push(a.keyword);
    map.set(key, entry);
  }
  return map;
}

function suggestionKey(row: { fromResourceType: string; fromResourceId: string; toResourceType: string; toResourceId: string; locale: string }): string {
  return `${row.fromResourceType}:${row.fromResourceId}::${row.toResourceType}:${row.toResourceId}::${row.locale}`;
}

export interface RunInternalLinksDeps {
  db: PrismaClient;
  /**
   * Optional — omitted (e.g. no AI key configured) means targets match on
   * title/keywords only, no synonyms. BATCH shape: one call per chunk of up to
   * SYNONYM_BATCH_SIZE terms, returning one synonym list per term in the SAME
   * order (`avoid[i]` = anchor texts already rejected for `terms[i]`). Matches
   * AIService.generateSynonymsBatch without importing the AI service into this
   * DB-cache-first module.
   */
  synonymProvider?: (terms: string[], locale: string, avoid: string[][]) => Promise<string[][]>;
  onProgress?: (processed: number, total: number) => void | Promise<void>;
  heartbeatEvery?: number;
}

/** Anchor texts the merchant has rejected per target item, keyed
 *  `<resourceType>:<resourceId>` — the "don't propose this again" signal fed
 *  into the next run's synonym prompts. Exported for the unit test. */
export function rejectedAnchorsByTarget(
  rows: Array<{ toResourceType: string; toResourceId: string; anchorText: string; status: string; dismissedUntil: Date | null }>,
  now: Date,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== "dismissed") continue;
    // A lapsed 90-day ignore is no longer a rejection (the run revives it), so
    // it must not suppress anything either.
    if (row.dismissedUntil && row.dismissedUntil <= now) continue;
    const anchor = (row.anchorText || "").trim();
    if (!anchor) continue;
    const key = `${row.toResourceType}:${row.toResourceId}`;
    const list = map.get(key) ?? [];
    if (!list.some((a) => a.toLocaleLowerCase() === anchor.toLocaleLowerCase())) list.push(anchor);
    map.set(key, list);
  }
  return map;
}

/**
 * Buckets suggestions by their SOURCE item, preserving the given order both
 * between and inside buckets.
 *
 * "Alle annehmen" applies buckets concurrently but each bucket strictly in
 * order: two suggestions that link out of the same product/article are applied
 * one after the other, because the second insertion has to run against the HTML
 * the first one saved. Applying them in parallel would compute both from the
 * same original content, and whichever save lands last would silently drop the
 * other link.
 */
export function groupSuggestionsBySource<T extends { fromResourceType: string; fromResourceId: string }>(
  suggestions: T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.fromResourceType}:${suggestion.fromResourceId}`;
    const group = groups.get(key);
    if (group) group.push(suggestion);
    else groups.set(key, [suggestion]);
  }
  return Array.from(groups.values());
}

/**
 * The full merchant-triggered run (§4.1–§4.3): load targets + sources from
 * the DB cache, optionally enrich targets with AI synonyms, match, and
 * upsert suggestions. This is the ONLY function in this module that touches
 * the database — everything above is pure and unit-testable without a DB.
 */
export async function runInternalLinkSuggestions(shop: string, deps: RunInternalLinksDeps): Promise<InternalLinksSummary> {
  const { db, synonymProvider, onProgress, heartbeatEvery = HEARTBEAT_EVERY_SOURCES } = deps;

  // ── Targets ────────────────────────────────────────────────────────────
  const [products, collections, assignments] = await Promise.all([
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { id: true, handle: true, title: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.collection.findMany({
      where: { shop },
      select: { id: true, handle: true, title: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    listAssignments(db, shop),
  ]);

  const keywordMap = keywordsByResource(assignments as unknown as AssignmentLike[]);

  const targets: TargetItem[] = [
    ...products
      .filter((p) => p.handle)
      .map((p) => ({ resourceType: "Product" as const, resourceId: p.id, handle: p.handle, title: p.title })),
    ...collections
      .filter((c) => c.handle)
      .map((c) => ({ resourceType: "Collection" as const, resourceId: c.id, handle: c.handle, title: c.title })),
  ].map((base) => {
    const kw = keywordMap.get(`${base.resourceType}:${base.resourceId}`);
    return {
      ...base,
      anchors: buildAnchorCandidates({
        title: base.title,
        primaryKeyword: kw?.primary ?? null,
        secondaryKeywords: kw?.secondaries ?? [],
      }),
    } satisfies TargetItem;
  });

  // ── Existing suggestions (rejection feedback + dismissed-future guard +
  //    pending budget) ─────────────────────────────────────────────────────
  // Loaded BEFORE the synonym stage on purpose: the merchant's rejections are
  // an input to it (see rejectedAnchorsByTarget), not just a persistence-time
  // guard. One query serves all three uses.
  const existingRows = await db.seoInternalLinkSuggestion.findMany({
    where: { shop },
    select: {
      fromResourceType: true,
      fromResourceId: true,
      toResourceType: true,
      toResourceId: true,
      anchorText: true,
      locale: true,
      status: true,
      dismissedUntil: true,
    },
    take: 5000,
  });
  const now = new Date();
  const rejectedAnchors = rejectedAnchorsByTarget(existingRows, now);

  // ── Synonyms (§4.4 — ephemeral, capped, BATCHED) ───────────────────────
  let targetsWithSynonyms = 0;
  let synonymRequests = 0;
  if (synonymProvider) {
    const synonymTargets = targets.slice(0, MAX_SYNONYM_TARGETS);
    for (let i = 0; i < synonymTargets.length; i += SYNONYM_BATCH_SIZE) {
      const chunk = synonymTargets.slice(i, i + SYNONYM_BATCH_SIZE);
      const terms = chunk.map((t) => t.anchors.find((a) => a.kind === "primary")?.text || t.title);
      const avoid = chunk.map((t) => rejectedAnchors.get(`${t.resourceType}:${t.resourceId}`) ?? []);
      let lists: string[][];
      try {
        synonymRequests++;
        lists = await synonymProvider(terms, "", avoid);
      } catch {
        // Best-effort — a failed synonym batch must not abort the run; those
        // targets simply match on title/keywords only.
        continue;
      }
      if (!Array.isArray(lists) || lists.length !== chunk.length) continue; // never risk a mis-aligned mapping
      chunk.forEach((target, idx) => {
        // The prompt asks the model to skip rejected wordings; this is the
        // guarantee that it did (a model hint is never the enforcement point).
        const blocked = new Set((avoid[idx] ?? []).map((a) => a.toLocaleLowerCase()));
        const synonyms = (lists[idx] ?? []).filter((s) => !blocked.has(s.trim().toLocaleLowerCase()));
        if (synonyms.length === 0) return;
        target.anchors.push(...buildAnchorCandidates({ title: "", synonyms }).filter((a) => a.kind === "synonym"));
        targetsWithSynonyms++;
      });
    }
  }

  // ── Sources ────────────────────────────────────────────────────────────
  const [sourceProducts, articles, pages] = await Promise.all([
    db.product.findMany({
      where: { shop },
      select: { id: true, descriptionHtml: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.article.findMany({
      where: { shop },
      select: { id: true, body: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.page.findMany({
      where: { shop },
      select: { id: true, body: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
  ]);

  const sources: SourceItem[] = [
    ...sourceProducts.map((p) => ({ resourceType: "Product" as const, resourceId: p.id, html: p.descriptionHtml || "" })),
    ...articles.map((a) => ({ resourceType: "Article" as const, resourceId: a.id, html: a.body || "" })),
    ...pages.map((p) => ({ resourceType: "Page" as const, resourceId: p.id, html: p.body || "" })),
  ];

  const existingByKey = new Map<string, { status: string; dismissedUntil: Date | null }>(
    existingRows.map((r) => [suggestionKey(r), { status: r.status, dismissedUntil: r.dismissedUntil }]),
  );
  let pendingCount = existingRows.filter((r) => r.status === "pending").length;

  let created = 0;
  let updated = 0;
  let cappedByPendingLimit = false;
  let processed = 0;

  for (const source of sources) {
    processed++;
    const eligibleTargets = targets.filter(
      (t) => !(t.resourceType === source.resourceType && t.resourceId === source.resourceId),
    );
    const matches = matchSourceAgainstTargets(source.html, eligibleTargets);

    for (const match of matches) {
      const candidateKey = suggestionKey({
        fromResourceType: source.resourceType,
        fromResourceId: source.resourceId,
        toResourceType: match.toResourceType,
        toResourceId: match.toResourceId,
        locale: "",
      });
      const existing = existingByKey.get(candidateKey);

      // "Ablehnen" (permanent reject) stores dismissedUntil: null; "90 Tage
      // ignorieren" stores a future date. Either way, a dismissed row is
      // reactivatable ONLY once its dismissedUntil has passed — a null
      // dismissedUntil never passes, so a permanent reject is never
      // reactivated by a later run.
      if (existing?.status === "dismissed" && (!existing.dismissedUntil || existing.dismissedUntil > now)) {
        continue;
      }
      if (existing?.status === "accepted") {
        continue; // already applied — a rerun should see it as "already linked" anyway
      }

      if (!existing) {
        if (pendingCount >= MAX_PENDING_PER_SHOP) {
          cappedByPendingLimit = true;
          continue;
        }
        const whereKey = {
          shop,
          fromResourceType: source.resourceType,
          fromResourceId: source.resourceId,
          toResourceType: match.toResourceType,
          toResourceId: match.toResourceId,
          locale: "",
        };
        try {
          await db.seoInternalLinkSuggestion.create({
            data: {
              ...whereKey,
              anchorText: match.anchorText,
              confidence: match.confidence,
              status: "pending",
            },
          });
          pendingCount++;
          created++;
          existingByKey.set(candidateKey, { status: "pending", dismissedUntil: null });
        } catch (err: unknown) {
          // §8: `existingRows` is capped at 5000 with no orderBy — beyond
          // that a dismissed-future row can fall outside the loaded window,
          // bypass the reactivation guard above, and land here as a unique-
          // constraint violation (the row already exists, we just never
          // loaded it). Re-read just THIS row and apply the same
          // dismissed-future/accepted guards instead of crashing the run —
          // any other error still propagates.
          if ((err as { code?: string } | null)?.code !== "P2002") throw err;
          const row = await db.seoInternalLinkSuggestion.findUnique({
            where: { shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale: whereKey },
            select: { status: true, dismissedUntil: true },
          });
          if (row?.status === "dismissed" && (!row.dismissedUntil || row.dismissedUntil > now)) {
            existingByKey.set(candidateKey, { status: row.status, dismissedUntil: row.dismissedUntil });
            continue; // never resurrect a dismissed-future/permanent row via this path either
          }
          if (row?.status === "accepted") {
            existingByKey.set(candidateKey, { status: "accepted", dismissedUntil: row.dismissedUntil ?? null });
            continue;
          }
          await db.seoInternalLinkSuggestion.update({
            where: { shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale: whereKey },
            data: { anchorText: match.anchorText, confidence: match.confidence, status: "pending", dismissedUntil: null },
          });
          updated++;
          existingByKey.set(candidateKey, { status: "pending", dismissedUntil: null });
        }
      } else {
        // Existing "pending" row, or a "dismissed" row whose dismissedUntil
        // has lapsed — refresh it back to pending with the latest match.
        // Reviving a lapsed dismissal counts against the same budget as a
        // brand-new suggestion (it wasn't in the pending count above).
        const wasPending = existing.status === "pending";
        if (!wasPending && pendingCount >= MAX_PENDING_PER_SHOP) {
          cappedByPendingLimit = true;
          continue;
        }
        if (!wasPending) pendingCount++;
        await db.seoInternalLinkSuggestion.update({
          where: {
            shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale: {
              shop,
              fromResourceType: source.resourceType,
              fromResourceId: source.resourceId,
              toResourceType: match.toResourceType,
              toResourceId: match.toResourceId,
              locale: "",
            },
          },
          data: {
            anchorText: match.anchorText,
            confidence: match.confidence,
            status: "pending",
            dismissedUntil: null,
          },
        });
        updated++;
        existing.status = "pending";
        existing.dismissedUntil = null;
      }
    }

    if (onProgress && processed % heartbeatEvery === 0) {
      await onProgress(processed, sources.length);
    }
  }
  if (onProgress) await onProgress(processed, sources.length);

  return {
    targetsConsidered: targets.length,
    targetsWithSynonyms,
    synonymRequests,
    sourcesScanned: sources.length,
    created,
    updated,
    cappedByPendingLimit,
  };
}

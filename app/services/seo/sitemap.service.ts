/**
 * Sitemap & indexation control (Phase 4 of PLAN_SEO_SUITE_COMPLETION.md §6).
 *
 * Shopify's `sitemap.xml` is platform-generated and not directly editable.
 * The documented lever is the `seo.hidden` metafield (namespace "seo", key
 * "hidden") on Product/Page/Article/Collection/Blog: setting it removes the
 * resource from the sitemap AND sets `noindex`; clearing it restores both.
 * `applyExclusion`/`revertExclusion` below set/clear that metafield via the
 * same `metafieldsSet`/`metafieldsDelete` mutations the bulk editor uses
 * (content.mutations.ts) — never re-declared here.
 *
 * ── Empirical spike NOT run (§6.1) ──────────────────────────────────────────
 * The plan calls for a ~1h dev-store spike verifying that `seo.hidden` (a)
 * actually clears the sitemap, (b) is settable via `metafieldsSet` with the
 * type below, (c) reverts cleanly. No dev store is available in this
 * environment, so the spike was NOT performed. The apply/revert flow is
 * implemented in full and is safe regardless of the spike's eventual
 * outcome: `applyExclusion`/`revertExclusion` only flip
 * `SeoSitemapExclusion.status` after Shopify ECHOES the write back —
 * `userErrors: []` alone is never treated as success (CLAUDE.md invariant,
 * the same discipline as `translationsRegister`/`registerAndVerify`). If the
 * metafield type or namespace turns out to be wrong, Shopify's response
 * simply won't echo it, the row stays "suggested", and the UI surfaces the
 * failure — no silent no-op, no corrupted local state.
 *
 * Metafield type: the plan text says "Integer"; Shopify's metafield type
 * system has no bare "Integer" type — the closest/standard identifier is
 * "number_integer" (SEO_HIDDEN_METAFIELD_TYPE below). This is a best-effort
 * determination (unverified against a live shop, see above), which is
 * exactly why the echo check exists as the safety net.
 *
 * ── DB-cache-first / the one live fetch (SEO_SECTION_CONTRACT.md §3/§6) ────
 * Exclusion SUGGESTIONS (`computeExclusionSuggestions`) are 100% DB-cache
 * reads — no live Admin API sweep. The sitemap index + sub-sitemap fetch
 * (`fetchSitemapInfo`) is the one live fetch this section is allowed, same
 * discipline as the AEO robots.txt check (aeo.service.ts): best-effort,
 * timeout-bounded, cached ~1h (`getCachedSitemapInfo`) so repeated loader
 * hits don't refetch on every request.
 *
 * ── Data-model deviation: "empty collection" (documented, see final report) ─
 * The plan lists "empty collections" as an exclusion-suggestion reason, but
 * Collection↔Product membership is NOT persisted anywhere in this app's DB
 * (`Collection` has no `productsCount`, and `Product` carries no collection
 * reference) — verified against prisma/schema.prisma. Fetching per-collection
 * product counts live would be exactly the "Live-GraphQL-Sweep über den
 * ganzen Katalog" the section contract forbids for `analyze()`. Instead this
 * reuses the Phase-1 crawl cache (`SeoCrawlPage`, itself a DB cache — no new
 * live fetch): a crawled collection page with a very low word count
 * (EMPTY_COLLECTION_MAX_WORDCOUNT, just the theme's "no products" chrome) is
 * the proxy signal. Requires a completed/capped crawl snapshot to exist —
 * without one, `emptyCollection` simply yields zero suggestions (same
 * "hidden without a snapshot" precedent the broken-links-in-sitemap tile
 * uses). Similarly, "archivedProduct" narrows the plan's "out-of-stock
 * archived products" to just `status === "ARCHIVED"` — `ProductVariant` has
 * no inventory/`availableForSale` column (confirmed against
 * json-ld-audit.service.ts's header comment, which hit the same gap).
 */

import * as cheerio from "cheerio";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { PrismaClient } from "@prisma/client";
import { stripHtml } from "../../utils/seo-score";
import { METAFIELDS_SET, METAFIELDS_DELETE } from "../../graphql/content.mutations";
import { MAX_AUDIT_ITEMS_PER_TYPE } from "./audit.service";

// ── Constants ────────────────────────────────────────────────────────────

/** Pages with fewer stripped-text words than this are "thin content" (§6.2). */
export const THIN_CONTENT_MIN_WORDS = 150;
/** Crawled collection-page word count at/below this looks like an empty
 *  product grid (just theme chrome / "no products found" text). */
export const EMPTY_COLLECTION_MAX_WORDCOUNT = 20;

export const SEO_HIDDEN_NAMESPACE = "seo";
export const SEO_HIDDEN_KEY = "hidden";
/** See header comment — best-effort, echo-verified, not spike-confirmed. */
export const SEO_HIDDEN_METAFIELD_TYPE = "number_integer";

const REQUEST_TIMEOUT_MS = 10_000;
/** Bound on how many sub-sitemaps a sitemap INDEX fetch will follow — a
 *  defensive cap, not a plan requirement, mirroring crawl.service.ts's
 *  MAX_SITEMAP_SEED_URLS-style guards. */
const MAX_SUB_SITEMAPS = 25;
/** Cap on URLs kept for the broken-links crossmatch (memory guard on very
 *  large catalogs — entryCount itself is never capped). */
const MAX_SITEMAP_URLS = 5000;
/** Overall wall-clock budget for fetching a sitemap INDEX's sub-sitemaps
 *  (§ fix 10): fetched concurrently (bounded at MAX_SUB_SITEMAPS, each with
 *  its own REQUEST_TIMEOUT_MS abort) rather than sequentially — up to 25
 *  sequential 10s fetches could otherwise block a route loader for ~250s and
 *  trip the platform's own request timeout. This budget is defense-in-depth
 *  on top of that: if it's ever exceeded, the loader still degrades to the
 *  graceful `sitemapFetchError`/`ok:false` path instead of hanging further. */
const SUB_SITEMAP_FETCH_BUDGET_MS = 20_000;
/** "cached ~1h" (§6.3). */
const SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000;

// ── Exclusion-suggestion rules (pure — unit-tested without a DB) ───────────

export type SitemapExclusionReason = "emptyCollection" | "thinContent" | "archivedProduct";
export type SitemapExclusionResourceType = "product" | "collection" | "page";

export interface SitemapExclusionCandidate {
  resourceType: SitemapExclusionResourceType;
  resourceId: string;
  reason: SitemapExclusionReason;
  title: string;
  handle: string;
}

export interface ThinPageRow {
  id: string;
  title: string;
  handle: string;
  body: string | null;
}

/** Page rows whose stripped-text word count is below the threshold (§6.2 —
 *  "Wortzahl aus DB"). Word count is computed from the DB `body` value at
 *  call time, not a stored column. */
export function findThinContentPages(
  pages: ThinPageRow[],
  minWords: number = THIN_CONTENT_MIN_WORDS,
): SitemapExclusionCandidate[] {
  const out: SitemapExclusionCandidate[] = [];
  for (const p of pages) {
    const text = stripHtml(p.body);
    const wordCount = text ? text.split(" ").filter(Boolean).length : 0;
    if (wordCount < minWords) {
      out.push({ resourceType: "page", resourceId: p.id, reason: "thinContent", title: p.title, handle: p.handle });
    }
  }
  return out;
}

export interface ArchivedProductRow {
  id: string;
  title: string;
  handle: string;
  status: string;
}

/** Archived products (see header comment for why "out-of-stock" is dropped —
 *  no inventory data in the DB cache). Callers typically already filter the
 *  query to `status: "ARCHIVED"`; this also re-checks so the pure function is
 *  safe against a caller passing an unfiltered list. */
export function findArchivedProducts(products: ArchivedProductRow[]): SitemapExclusionCandidate[] {
  return products
    .filter((p) => p.status === "ARCHIVED")
    .map((p) => ({
      resourceType: "product" as const,
      resourceId: p.id,
      reason: "archivedProduct" as const,
      title: p.title,
      handle: p.handle,
    }));
}

/**
 * Handle/title fragments that mark a Page as legally-required or service
 * content (Impressum, Datenschutz, AGB, Widerruf, Versand, Kontakt, …) in the
 * three UI languages. Such pages are ALWAYS short — they trip
 * `findThinContentPages` on word count alone — but they are trust signals that
 * should normally stay indexable. We do NOT filter them out of the suggestion
 * list (the merchant may genuinely want an Impressum out of the index); the
 * UI flags them so the decision is a conscious one instead of a reflex click.
 * Substring match on the lowercased handle+title, so `datenschutzerklaerung`
 * and `privacy-policy` both hit.
 */
const POLICY_PAGE_FRAGMENTS = [
  // de
  "impressum", "datenschutz", "agb", "widerruf", "versand", "zahlung",
  "liefer", "ruckgabe", "rückgabe", "kontakt", "haftung",
  // en
  "privacy", "terms", "legal", "imprint", "refund", "return", "shipping",
  "delivery", "payment", "contact", "disclaimer", "cookie", "policy", "policies",
  // es
  "aviso-legal", "privacidad", "terminos", "términos", "envio", "envío",
  "contacto", "devolucion", "devolución", "pago",
];

/**
 * Heuristic: does this row look like a legally-required / service page whose
 * short length is expected rather than a defect? Pages only — a short product
 * or collection carries no such expectation. Pure, so it is unit-testable and
 * usable from both `analyze()` and tests.
 */
export function isLikelyPolicyPage(
  resourceType: SitemapExclusionResourceType,
  handle: string,
  title: string,
): boolean {
  if (resourceType !== "page") return false;
  const haystack = `${handle} ${title}`.toLowerCase();
  return POLICY_PAGE_FRAGMENTS.some((f) => haystack.includes(f));
}

export interface CollectionRow {
  id: string;
  title: string;
  handle: string;
}

/** Collections whose latest crawled page has a near-zero word count (see
 *  header comment — the DB-only proxy for "zero products"). `crawledWordCountById`
 *  is keyed by Collection.id; collections absent from the map (no crawl data
 *  for them) never produce a candidate. */
export function findEmptyCollections(
  collections: CollectionRow[],
  crawledWordCountById: Map<string, number>,
  maxWords: number = EMPTY_COLLECTION_MAX_WORDCOUNT,
): SitemapExclusionCandidate[] {
  const out: SitemapExclusionCandidate[] = [];
  for (const c of collections) {
    const wordCount = crawledWordCountById.get(c.id);
    if (wordCount !== undefined && wordCount <= maxWords) {
      out.push({ resourceType: "collection", resourceId: c.id, reason: "emptyCollection", title: c.title, handle: c.handle });
    }
  }
  return out;
}

// ── Suggestion computation + idempotent upsert (DB-cache-first) ────────────

export interface ComputeSuggestionsDeps {
  db: PrismaClient;
}

/**
 * DB-cache-first candidate sweep (SEO_SECTION_CONTRACT.md §3): reads
 * Page/Product/Collection (capped at MAX_AUDIT_ITEMS_PER_TYPE, same cap
 * audit.service.ts uses) plus, for the empty-collection proxy, the latest
 * completed/capped crawl snapshot's SeoCrawlPage rows. No live Shopify call.
 */
export async function computeExclusionSuggestions(
  shop: string,
  deps: ComputeSuggestionsDeps,
): Promise<SitemapExclusionCandidate[]> {
  const { db } = deps;

  const [pages, archivedProducts, collections, latestSnapshot] = await Promise.all([
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true, body: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.product.findMany({
      where: { shop, status: "ARCHIVED" },
      select: { id: true, title: true, handle: true, status: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true },
      take: MAX_AUDIT_ITEMS_PER_TYPE,
    }),
    db.seoCrawlSnapshot.findFirst({
      where: { shop, status: { in: ["completed", "capped"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    }),
  ]);

  const crawledWordCountById = new Map<string, number>();
  if (latestSnapshot) {
    const collectionPages = await db.seoCrawlPage.findMany({
      where: { shop, snapshotId: latestSnapshot.id, resourceType: "collection", resourceId: { not: null }, locale: "" },
      select: { resourceId: true, wordCount: true },
    });
    for (const cp of collectionPages) {
      if (cp.resourceId) crawledWordCountById.set(cp.resourceId, cp.wordCount);
    }
  }

  return [
    ...findEmptyCollections(collections, crawledWordCountById),
    ...findThinContentPages(pages),
    ...findArchivedProducts(archivedProducts),
  ];
}

export interface UpsertSuggestionsSummary {
  created: number;
  skipped: number;
}

/**
 * Idempotent upsert into SeoSitemapExclusion (unique key: shop+resourceType+
 * resourceId). A re-run NEVER touches a row that already exists — whether
 * it's still "suggested", or the merchant/a prior run moved it to "applied"
 * or "reverted" — same non-reactivation rule as SeoInternalLinkSuggestion
 * (internal-links.service.ts).
 */
export async function upsertExclusionSuggestions(
  db: PrismaClient,
  shop: string,
  candidates: SitemapExclusionCandidate[],
): Promise<UpsertSuggestionsSummary> {
  if (candidates.length === 0) return { created: 0, skipped: 0 };

  const existing = await db.seoSitemapExclusion.findMany({
    where: {
      shop,
      OR: candidates.map((c) => ({ resourceType: c.resourceType, resourceId: c.resourceId })),
    },
    select: { resourceType: true, resourceId: true },
  });
  const existingKeys = new Set(existing.map((e) => `${e.resourceType}::${e.resourceId}`));

  let created = 0;
  let skipped = 0;
  for (const c of candidates) {
    const key = `${c.resourceType}::${c.resourceId}`;
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    await db.seoSitemapExclusion.create({
      data: { shop, resourceType: c.resourceType, resourceId: c.resourceId, reason: c.reason, status: "suggested" },
    });
    existingKeys.add(key); // guard against duplicate candidates in the same sweep
    created += 1;
  }
  return { created, skipped };
}

// ── Live sitemap fetch (the ONE allowed live call, §6.2/§6.3) ──────────────

export interface SitemapFetchResult {
  sitemapUrl: string;
  /** Sum of `<url>` entries across the sub-sitemaps actually fetched. For a
   *  plain (non-index) sitemap this IS the true total. For a sitemap INDEX,
   *  it is capped: only the first MAX_SUB_SITEMAPS sub-sitemaps are fetched
   *  (and, on top of that, a hanging sub-sitemap can trip the overall fetch
   *  budget before all of them finish) — NOT a guaranteed true total on a
   *  catalog with more sub-sitemaps than that. */
  entryCount: number;
  /** URLs kept for the broken-links crossmatch, capped at MAX_SITEMAP_URLS. */
  urls: string[];
  ok: boolean;
}

async function fetchXml(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: "application/xml, text/xml" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch `/sitemap.xml` and, when it's a sitemap INDEX, its sub-sitemaps
 * (bounded at MAX_SUB_SITEMAPS), returning the effective entry count. Same
 * fetch discipline as aeo.service.ts's robots.txt check: best-effort,
 * timeout-bounded, never throws — `ok: false` on any failure. Pure aside
 * from the fetch calls; `fetchImpl` is injectable for tests.
 */
export async function fetchSitemapInfo(fetchImpl: typeof fetch, primaryDomain: string): Promise<SitemapFetchResult> {
  const sitemapUrl = `https://${primaryDomain}/sitemap.xml`;
  const rootXml = await fetchXml(fetchImpl, sitemapUrl);
  if (!rootXml) return { sitemapUrl, entryCount: 0, urls: [], ok: false };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(rootXml, { xmlMode: true });
  } catch {
    return { sitemapUrl, entryCount: 0, urls: [], ok: false };
  }

  const subSitemapLocs: string[] = [];
  $("sitemap > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) subSitemapLocs.push(loc);
  });
  const isIndex = $("sitemapindex").length > 0 || subSitemapLocs.length > 0;

  if (!isIndex) {
    let entryCount = 0;
    const urls: string[] = [];
    $("url > loc").each((_, el) => {
      entryCount += 1;
      const loc = $(el).text().trim();
      if (loc && urls.length < MAX_SITEMAP_URLS) urls.push(loc);
    });
    return { sitemapUrl, entryCount, urls, ok: true };
  }

  // Concurrent (§ fix 10), not sequential — each `fetchXml` call already has
  // its own REQUEST_TIMEOUT_MS abort, so fetching all sub-sitemaps in
  // parallel bounds the whole batch to roughly one fetch's worth of time
  // instead of MAX_SUB_SITEMAPS × REQUEST_TIMEOUT_MS. The outer race against
  // SUB_SITEMAP_FETCH_BUDGET_MS is a defensive backstop on top of that.
  const toFetch = subSitemapLocs.slice(0, MAX_SUB_SITEMAPS);
  const fetchAll = Promise.all(toFetch.map((sub) => fetchXml(fetchImpl, sub)));
  const budgetExceeded = Symbol("sub-sitemap fetch budget exceeded");
  const budget = new Promise<typeof budgetExceeded>((resolve) =>
    setTimeout(() => resolve(budgetExceeded), SUB_SITEMAP_FETCH_BUDGET_MS),
  );
  const raced = await Promise.race([fetchAll, budget]);
  if (raced === budgetExceeded) {
    return { sitemapUrl, entryCount: 0, urls: [], ok: false };
  }

  let entryCount = 0;
  const urls: string[] = [];
  for (const subXml of raced) {
    if (!subXml) continue;
    let $sub: cheerio.CheerioAPI;
    try {
      $sub = cheerio.load(subXml, { xmlMode: true });
    } catch {
      continue;
    }
    $sub("url > loc").each((_, el) => {
      entryCount += 1;
      const loc = $sub(el).text().trim();
      if (loc && urls.length < MAX_SITEMAP_URLS) urls.push(loc);
    });
  }

  return { sitemapUrl, entryCount, urls, ok: true };
}

interface CachedSitemap {
  data: SitemapFetchResult;
  timestamp: number;
}

// In-memory TTL cache, same pattern as shop-locales-cache.server.ts — a
// dedicated DB model for this would be overkill for a ~1h-TTL live fetch
// (PLAN §2 lists no such model for Phase 4 beyond SeoSitemapExclusion).
const SITEMAP_CACHE = new Map<string, CachedSitemap>();

/** `fetchSitemapInfo`, cached ~1h per shop (§6.3). A failed fetch is never
 *  cached, so a transient storefront hiccup doesn't stick around for an hour. */
export async function getCachedSitemapInfo(
  fetchImpl: typeof fetch,
  shop: string,
  primaryDomain: string,
): Promise<SitemapFetchResult> {
  const cached = SITEMAP_CACHE.get(shop);
  if (cached && Date.now() - cached.timestamp < SITEMAP_CACHE_TTL_MS) return cached.data;

  const data = await fetchSitemapInfo(fetchImpl, primaryDomain);
  if (data.ok) SITEMAP_CACHE.set(shop, { data, timestamp: Date.now() });
  return data;
}

/** Test/ops escape hatch — clears one shop's cache entry, or all of them. */
export function clearSitemapInfoCache(shop?: string): void {
  if (shop) SITEMAP_CACHE.delete(shop);
  else SITEMAP_CACHE.clear();
}

// ── Broken-links-in-sitemap crossmatch (pure) ───────────────────────────────

export interface CrawlPageStatusRow {
  url: string;
  statusCode: number;
}

/**
 * Sitemap URLs that also appear in the crawl cache with a >=400 status.
 * Exact string match only (both sides are absolute URLs) — a sitemap URL
 * whose formatting differs from the crawler's normalized form (trailing
 * slash, casing) simply won't match; documented limitation, not a plan
 * requirement to reconcile. Only called when a crawl snapshot exists (Phase
 * 1 dependency, §6.2 — "nur wenn Phase 1 live ist; sonst Kachel ausblenden").
 */
export function crossmatchBrokenSitemapLinks(
  sitemapUrls: string[],
  crawlPages: CrawlPageStatusRow[],
): CrawlPageStatusRow[] {
  const statusByUrl = new Map(crawlPages.map((p) => [p.url, p.statusCode]));
  const out: CrawlPageStatusRow[] = [];
  for (const url of sitemapUrls) {
    const status = statusByUrl.get(url);
    if (status !== undefined && status >= 400) out.push({ url, statusCode: status });
  }
  return out;
}

// ── Apply / Revert — echo-verified metafield writes (§6.1/§6.2) ────────────

export interface ApplyRevertResult {
  ok: boolean;
  error?: string;
}

/**
 * Set `seo.hidden = 1` on the excluded resource via `metafieldsSet`. Flips
 * `SeoSitemapExclusion.status` to "applied" ONLY when Shopify echoes the
 * metafield back in the response — `userErrors: []` alone is not success
 * (CLAUDE.md invariant). Never sends an empty-string value (that's the
 * `metafieldsSet` footgun CLAUDE.md documents for a different field; not
 * applicable here since the value is always "1", but the same discipline —
 * always send `type` — applies).
 */
export async function applyExclusion(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  exclusionId: string,
): Promise<ApplyRevertResult> {
  const row = await db.seoSitemapExclusion.findFirst({ where: { id: exclusionId, shop } });
  if (!row) return { ok: false, error: "not_found" };
  if (row.status === "applied") return { ok: true }; // idempotent no-op

  let json: any;
  try {
    const res = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: row.resourceId,
            namespace: SEO_HIDDEN_NAMESPACE,
            key: SEO_HIDDEN_KEY,
            type: SEO_HIDDEN_METAFIELD_TYPE,
            value: "1",
          },
        ],
      },
    });
    json = await res.json();
  } catch {
    return { ok: false, error: "request_failed" };
  }

  const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) return { ok: false, error: userErrors[0]?.message || "userError" };

  const echoed = json?.data?.metafieldsSet?.metafields ?? [];
  const echo = echoed.find((m: any) => m.namespace === SEO_HIDDEN_NAMESPACE && m.key === SEO_HIDDEN_KEY);
  if (!echo) return { ok: false, error: "not_confirmed" };

  await db.seoSitemapExclusion.update({ where: { id: row.id }, data: { status: "applied", appliedAt: new Date() } });
  return { ok: true };
}

/**
 * Clear `seo.hidden` via `metafieldsDelete` (MetafieldIdentifierInput —
 * ownerId+namespace+key; CLAUDE.md: setting `""` via metafieldsSet does NOT
 * clear a metafield, deletion is the only way). Same echo discipline as
 * `applyExclusion` — and the same as the translationsRemove lesson in
 * CLAUDE.md ("delete on Shopify must check the echo too"): the local row
 * only moves to "reverted" once `deletedMetafields` confirms it.
 */
export async function revertExclusion(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  exclusionId: string,
): Promise<ApplyRevertResult> {
  const row = await db.seoSitemapExclusion.findFirst({ where: { id: exclusionId, shop } });
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "applied") return { ok: false, error: "not_applied" };

  let json: any;
  try {
    const res = await admin.graphql(METAFIELDS_DELETE, {
      variables: {
        metafields: [{ ownerId: row.resourceId, namespace: SEO_HIDDEN_NAMESPACE, key: SEO_HIDDEN_KEY }],
      },
    });
    json = await res.json();
  } catch {
    return { ok: false, error: "request_failed" };
  }

  const userErrors = json?.data?.metafieldsDelete?.userErrors ?? [];
  if (userErrors.length > 0) return { ok: false, error: userErrors[0]?.message || "userError" };

  const deleted = json?.data?.metafieldsDelete?.deletedMetafields ?? [];
  const echo = deleted.find(
    (m: any) => m.namespace === SEO_HIDDEN_NAMESPACE && m.key === SEO_HIDDEN_KEY && m.ownerId === row.resourceId,
  );
  if (!echo) return { ok: false, error: "not_confirmed" };

  await db.seoSitemapExclusion.update({ where: { id: row.id }, data: { status: "reverted", appliedAt: null } });
  return { ok: true };
}

// ── analyze() — the section's read model (SEO_SECTION_CONTRACT.md §3) ──────

export interface SitemapExclusionRow {
  id: string;
  resourceType: SitemapExclusionResourceType;
  resourceId: string;
  reason: string | null;
  status: string;
  appliedAt: string | null;
  title: string;
  handle: string;
  /** `isLikelyPolicyPage` — the UI shows a "check this first" warning instead
   *  of a plain apply button. Never hides the row. */
  caution: boolean;
}

export interface SitemapAnalysis {
  sitemapUrl: string | null;
  entryCount: number | null;
  sitemapFetchError: boolean;
  exclusions: SitemapExclusionRow[];
  /** Broken-links-in-sitemap tile is only meaningful (and only rendered)
   *  when a crawl snapshot exists — §6.2. */
  hasCrawlSnapshot: boolean;
  brokenInSitemap: CrawlPageStatusRow[];
}

export interface SitemapAnalyzeDeps {
  db: PrismaClient;
  primaryDomain: string;
  fetchImpl?: typeof fetch;
}

async function resolveExclusionTitles(
  db: PrismaClient,
  shop: string,
  rows: { resourceType: string; resourceId: string }[],
): Promise<Map<string, { title: string; handle: string }>> {
  const idsByType: Record<string, string[]> = { product: [], collection: [], page: [] };
  for (const r of rows) {
    if (idsByType[r.resourceType]) idsByType[r.resourceType].push(r.resourceId);
  }

  const [products, collections, pages] = await Promise.all([
    idsByType.product.length
      ? db.product.findMany({ where: { shop, id: { in: idsByType.product } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
    idsByType.collection.length
      ? db.collection.findMany({ where: { shop, id: { in: idsByType.collection } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
    idsByType.page.length
      ? db.page.findMany({ where: { shop, id: { in: idsByType.page } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
  ]);

  const map = new Map<string, { title: string; handle: string }>();
  for (const p of products as { id: string; title: string; handle: string }[]) map.set(`product::${p.id}`, { title: p.title, handle: p.handle });
  for (const c of collections as { id: string; title: string; handle: string }[]) map.set(`collection::${c.id}`, { title: c.title, handle: c.handle });
  for (const pg of pages as { id: string; title: string; handle: string }[]) map.set(`page::${pg.id}`, { title: pg.title, handle: pg.handle });
  return map;
}

/**
 * The section's read model: recomputes + upserts exclusion suggestions
 * (DB-cache-first), fetches the live sitemap (cached ~1h), and crossmatches
 * broken links when a crawl snapshot exists. Safe to call from a route
 * loader on every request — no Task needed (§6.3): all DB reads are capped,
 * and the live fetch is TTL-cached.
 */
export async function analyze(shop: string, deps: SitemapAnalyzeDeps): Promise<SitemapAnalysis> {
  const { db, primaryDomain, fetchImpl = fetch } = deps;

  const candidates = await computeExclusionSuggestions(shop, { db });
  await upsertExclusionSuggestions(db, shop, candidates);

  const [exclusionRows, latestSnapshot, sitemapInfo] = await Promise.all([
    db.seoSitemapExclusion.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 500 }),
    db.seoCrawlSnapshot.findFirst({
      where: { shop, status: { in: ["completed", "capped"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    }),
    getCachedSitemapInfo(fetchImpl, shop, primaryDomain),
  ]);

  const titleMap = await resolveExclusionTitles(db, shop, exclusionRows);
  const exclusions: SitemapExclusionRow[] = exclusionRows.map((r) => {
    const resolved = titleMap.get(`${r.resourceType}::${r.resourceId}`);
    const resourceType = r.resourceType as SitemapExclusionResourceType;
    const title = resolved?.title ?? r.resourceId;
    const handle = resolved?.handle ?? "";
    return {
      id: r.id,
      resourceType,
      resourceId: r.resourceId,
      reason: r.reason,
      status: r.status,
      appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
      title,
      handle,
      caution: isLikelyPolicyPage(resourceType, handle, title),
    };
  });

  let brokenInSitemap: CrawlPageStatusRow[] = [];
  if (latestSnapshot && sitemapInfo.ok) {
    const brokenPages = await db.seoCrawlPage.findMany({
      where: { shop, snapshotId: latestSnapshot.id, statusCode: { gte: 400 } },
      select: { url: true, statusCode: true },
    });
    brokenInSitemap = crossmatchBrokenSitemapLinks(sitemapInfo.urls, brokenPages);
  }

  return {
    sitemapUrl: sitemapInfo.ok ? sitemapInfo.sitemapUrl : null,
    entryCount: sitemapInfo.ok ? sitemapInfo.entryCount : null,
    sitemapFetchError: !sitemapInfo.ok,
    exclusions,
    hasCrawlSnapshot: !!latestSnapshot,
    brokenInSitemap,
  };
}

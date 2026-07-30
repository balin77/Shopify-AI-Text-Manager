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
 *
 * ── UNLISTED vs sitemap.xml (DOCUMENTED by Shopify + measured) ─────────────
 * Shopify documents both halves of this outright, so it is a platform
 * invariant and not a quirk of one shop —
 * https://shopify.dev/docs/apps/build/product-merchandising/unlisted-products
 * says an unlisted product "Won't be listed in `sitemap.xml`" and that
 * `<meta name="robots" content="noindex,nofollow">` "are added on the online
 * store product details page". The measurement below was run BEFORE that page
 * was found and independently agrees with it; both are kept because the
 * measurement is what proves the app's own cache lines up with the platform.
 *
 * Question: does an UNLISTED product need an `seo.hidden` exclusion, i.e. is
 * there an "unlistedProduct" suggestion reason worth adding? Answer: NO. It is
 * already out of the sitemap and already noindex, so the exclusion would be a
 * pure no-op.
 *
 * Method (a real shop with 3 unlisted products; storefront public, so the
 * `failureReason: "password"` / 404 pitfall that makes an absent sitemap
 * meaningless did not apply — the sitemap fetched with HTTP 200):
 *   - `sitemap_products_1.xml` held exactly 41 product `<loc>` entries, which
 *     matched the 41 cached ACTIVE products one-for-one. All 3 UNLISTED and all
 *     3 DRAFT products were absent. No cache drift in either direction (no
 *     sitemap URL missing from the cache, none of the cached ACTIVE set
 *     missing from the sitemap), so the comparison is not explained by a stale
 *     sync.
 *   - An unlisted product page answered HTTP 200 (publicly reachable by direct
 *     link, as the status intends) and carried
 *     `<meta name="robots" content="noindex,nofollow">` plus a self-referencing
 *     canonical. A control ACTIVE product page carried the canonical but NO
 *     robots meta. No `X-Robots-Tag` header on either.
 *   - Confounds excluded: this app emits no robots meta anywhere (nothing in
 *     extensions/), and no `seo.hidden` metafield exists on any cached product
 *     of that shop — so the noindex is Shopify's own behavior for the status,
 *     not a leftover exclusion. Consistent with Shopify's own documentation of
 *     UNLISTED ("doesn't show up in search, collections, or product
 *     recommendations").
 *
 * Consequences, both implemented:
 *   - No `unlistedProduct` reason was added to `SitemapExclusionReason`. A
 *     suggestion whose apply step provably changes nothing is worse than no
 *     suggestion: it spends the merchant's attention and a metafield write to
 *     reach the state they were already in.
 *   - The manual picker instead LABELS these products (see
 *     STATUSES_ALREADY_OUT_OF_SITEMAP / `ExclusionSearchHit.alreadyOutOfSitemap`).
 *
 * ── MEASURED 2026-07-30: ARCHIVED is absent too, so its rule was dropped ───
 * The earlier note here said ARCHIVED was unverified because no reachable shop
 * had both an archived product and a live storefront. That was settled by
 * archiving one ACTIVE product in a live shop and watching the sitemap:
 *
 *     before (ACTIVE)    sitemap_products_1.xml: 42 <loc>, handle present
 *     after  (ARCHIVED)  sitemap_products_1.xml: 41 <loc>, handle absent
 *                        product URL: 200 -> 404
 *
 * Roughly one minute apart — Shopify regenerates the sitemap in near-real-time
 * (its own sitemapindex comment says as much), so no cache caveat applies. The
 * before/after control matters: without proving the handle was IN the sitemap
 * while ACTIVE, its later absence would prove nothing.
 *
 * Consequence: the "archivedProduct" SUGGESTION was a no-op — it recommended
 * excluding something Shopify already excludes — and has been removed, along
 * with `findArchivedProducts`. Two rules remain: emptyCollection, thinContent.
 * ARCHIVED joined STATUSES_ALREADY_OUT_OF_SITEMAP, so the picker labels those
 * products instead of offering a button that would change nothing.
 *
 * `"archivedProduct"` is kept in RETIRED_EXCLUSION_REASONS rather than being
 * forgotten: rows created by the old rule still sit in shops' databases, and
 * `analyze()` must not keep showing suggestions for a rule that no longer
 * exists.
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

export type SitemapExclusionReason = "emptyCollection" | "thinContent" | "manual";

/** Reasons whose rule no longer exists. Rows carrying them were written by an
 *  earlier version and are still in merchants' databases; `analyze()` hides
 *  their SUGGESTED rows so the list can't recommend a rule we retired.
 *
 *  Rows that reached "applied"/"reverted" are NOT hidden: those record a real
 *  metafield write and the merchant must still be able to revert it. */
export const RETIRED_EXCLUSION_REASONS: readonly string[] = ["archivedProduct"];
/** `blog` is absent on purpose: the app caches no Blog model (Article carries a
 *  denormalized `blogTitle` only), so a blog can't be offered from the DB
 *  cache the way §3 requires. Products/collections/pages/articles cover what
 *  `seo.hidden` is actually used for. */
export type SitemapExclusionResourceType = "product" | "collection" | "page" | "article";
export const EXCLUDABLE_RESOURCE_TYPES: SitemapExclusionResourceType[] = ["product", "collection", "page", "article"];

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

// `findArchivedProducts` lived here. Removed 2026-07-30: measurement showed
// Shopify already keeps ARCHIVED products out of the sitemap, so the rule
// recommended an exclusion that could not change anything. See this file's
// header for the before/after figures.

/**
 * Handle/title fragments marking a Page that should normally STAY visible,
 * across the three UI languages. Two groups, one rule:
 *
 *  - legally required (Impressum, Datenschutz, AGB, Widerruf, Versand, …)
 *  - trust pages (Über uns, Team, FAQ, Hilfe, Kontakt)
 *
 * Both are short by nature, so both trip `findThinContentPages` on word count
 * alone, and both are worth more to a shop than their word count suggests —
 * "Über uns" in particular is an E-E-A-T signal that often carries backlinks.
 * The first version only covered the legal group, which left exactly those
 * trust pages sitting in the list with no warning at all.
 *
 * We do NOT filter these out of the suggestions (a merchant may genuinely want
 * an Impressum out of the index); the UI flags them so it's a conscious call
 * rather than a reflex click. Substring match on the lowercased handle+title,
 * so `datenschutzerklaerung` and `privacy-policy` both hit.
 *
 * Deliberately NOT included: a bare "über" — it would swallow "Übergrößen" and
 * similar. The joined/hyphenated forms below cover the real handles instead.
 */
const KEEP_VISIBLE_PAGE_FRAGMENTS = [
  // de — legal
  "impressum", "datenschutz", "agb", "widerruf", "versand", "zahlung",
  "liefer", "ruckgabe", "rückgabe", "kontakt", "haftung",
  // de — trust
  "über uns", "ueber uns", "über-uns", "ueber-uns", "uber-uns",
  "team", "hilfe", "häufige fragen", "haufige fragen",
  // en — legal
  "privacy", "terms", "legal", "imprint", "refund", "return", "shipping",
  "delivery", "payment", "contact", "disclaimer", "cookie", "policy", "policies",
  // en — trust
  "about", "faq", "help", "support",
  // es — legal
  "aviso-legal", "privacidad", "terminos", "términos", "envio", "envío",
  "contacto", "devolucion", "devolución", "pago",
  // es — trust
  "nosotros", "quienes somos", "quiénes somos", "ayuda", "preguntas",
];

/**
 * Heuristic: does this row look like a page whose shortness is expected rather
 * than a defect, and that a shop normally wants to keep indexable? Pages only
 * — a short product or collection carries no such expectation. Pure, so it is
 * unit-testable and usable from both `analyze()` and tests.
 */
export function isLikelyKeepVisiblePage(
  resourceType: SitemapExclusionResourceType,
  handle: string,
  title: string,
): boolean {
  if (resourceType !== "page") return false;
  const haystack = `${handle} ${title}`.toLowerCase();
  return KEEP_VISIBLE_PAGE_FRAGMENTS.some((f) => haystack.includes(f));
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
 * Page/Collection (capped at MAX_AUDIT_ITEMS_PER_TYPE, same cap
 * audit.service.ts uses) plus, for the empty-collection proxy, the latest
 * completed/capped crawl snapshot's SeoCrawlPage rows. No live Shopify call.
 *
 * Products are no longer read at all: the only product rule was
 * "archivedProduct", and it turned out to be a no-op (see the header).
 */
export async function computeExclusionSuggestions(
  shop: string,
  deps: ComputeSuggestionsDeps,
): Promise<SitemapExclusionCandidate[]> {
  const { db } = deps;

  const [pages, collections, latestSnapshot] = await Promise.all([
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true, body: true },
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

// ── Manual exclusion: search + create (DB-cache-first, §3) ─────────────────

/** Rows per picker page. Matches internal-links.tsx's PAGE_SIZE so the two
 *  paged lists in this section feel the same. */
export const MANUAL_PAGE_SIZE = 20;

export interface ExclusionSearchHit {
  resourceType: SitemapExclusionResourceType;
  resourceId: string;
  title: string;
  handle: string;
  /** An exclusion row already exists — the UI shows its state instead of an
   *  exclude button, so the same resource can't be queued twice. */
  existingStatus: string | null;
  /** `isLikelyKeepVisiblePage`. Computed here rather than in the route component so
   *  the client bundle never has to import this module (it pulls in cheerio). */
  caution: boolean;
  /** Featured image for the picker thumbnail, null when the model has none
   *  (Page carries no image at all). The column differs per model —
   *  `featuredImageUrl` on Product, `imageUrl` on Collection/Article — so it is
   *  normalized here rather than in the UI. */
  imageUrl: string | null;
  /** ACTIVE / DRAFT / ARCHIVED / UNLISTED. Products ONLY — no other cached model carries
   *  a status (verified against prisma/schema.prisma), so it is null for
   *  collections, pages and articles and the UI hides the column for them
   *  rather than inventing a value. */
  status: string | null;
  /** The product's status already keeps it out of `sitemap.xml`
   *  (STATUSES_ALREADY_OUT_OF_SITEMAP), so excluding it would be a no-op. The
   *  picker still allows it — the merchant may be pre-staging a product they
   *  intend to publish — but says so instead of implying an effect. Always
   *  false for non-product types, which carry no status. */
  alreadyOutOfSitemap: boolean;
}

/** Product statuses the picker can filter on. Anything else means "all". */
/** Shopify's ProductStatus as it actually reaches the cache. UNLISTED is real
 *  — verified against live data, not just the enum docs — and was missing from
 *  the first version of this filter, which made unlisted products unfilterable
 *  even though their badge rendered the raw value. */
export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUSES)[number] | "all";

/** Product statuses MEASURED to be absent from Shopify's `sitemap.xml`, so an
 *  `seo.hidden` exclusion on them would change nothing.
 *
 *  Measured (see the "unlisted" section of this file's header for the method):
 *  the products sub-sitemap held exactly the shop's 41 ACTIVE products — all 3
 *  UNLISTED and all 3 DRAFT products were absent.
 *
 *  ARCHIVED was added on 2026-07-30 after the same test was run for it
 *  directly — archive one ACTIVE product, watch its entry leave the sitemap.
 *  Figures in the header. It is no longer a guess. */
export const STATUSES_ALREADY_OUT_OF_SITEMAP: readonly string[] = ["DRAFT", "UNLISTED", "ARCHIVED"];

export interface ExclusionSearchResult {
  hits: ExclusionSearchHit[];
  /** Matches across ALL pages — a catalog can hold far more than one page. */
  total: number;
  /** 1-based, CLAMPED to the available range (see below). */
  page: number;
  pageSize: number;
}

/**
 * Type-ahead over the DB cache for the manual "exclude anything" picker. Reads
 * the same cached models the suggestion sweep uses — no live Admin API call
 * (SEO_SECTION_CONTRACT.md §3). An empty query returns the first page, so the
 * picker is useful before typing.
 *
 * Server-paged: the count and the slice come from the SAME where-clause, so
 * filtering never pages over a stale total. The requested page is clamped
 * rather than 404'd — narrowing the query while on page 7 is normal, and
 * should land on the last page instead of on an error (same treatment
 * internal-links.tsx gives its list).
 */
export async function searchExclusionCandidates(
  db: PrismaClient,
  shop: string,
  resourceType: SitemapExclusionResourceType,
  query: string,
  requestedPage = 1,
  statusFilter: string = "all",
): Promise<ExclusionSearchResult> {
  const q = query.trim();
  const filter = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" as const } },
          { handle: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  // Only Product has a status column, so the filter is silently ignored for
  // the other types instead of producing an invalid where-clause.
  const statusWhere =
    resourceType === "product" && (PRODUCT_STATUSES as readonly string[]).includes(statusFilter)
      ? { status: statusFilter }
      : {};
  const where = { shop, ...filter, ...statusWhere };

  const total = await countByType(db, resourceType, where);
  const totalPages = Math.max(1, Math.ceil(total / MANUAL_PAGE_SIZE));
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), totalPages);
  const empty = { hits: [], total, page, pageSize: MANUAL_PAGE_SIZE };
  if (total === 0) return empty;

  const common = {
    where,
    // Ties on title would otherwise be free to reorder between two queries and
    // let a row appear on both page 1 and page 2 (or on neither) — id is the
    // stable tie-breaker.
    orderBy: [{ title: "asc" as const }, { id: "asc" as const }],
    skip: (page - 1) * MANUAL_PAGE_SIZE,
    take: MANUAL_PAGE_SIZE,
  };

  let rows: { id: string; title: string; handle: string; imageUrl: string | null; status: string | null }[];
  switch (resourceType) {
    case "product": {
      const found = await db.product.findMany({
        ...common,
        select: { id: true, title: true, handle: true, featuredImageUrl: true, status: true },
      });
      rows = found.map((r) => ({ id: r.id, title: r.title, handle: r.handle, imageUrl: r.featuredImageUrl, status: r.status }));
      break;
    }
    case "collection": {
      const found = await db.collection.findMany({
        ...common,
        select: { id: true, title: true, handle: true, imageUrl: true },
      });
      rows = found.map((r) => ({ id: r.id, title: r.title, handle: r.handle, imageUrl: r.imageUrl, status: null }));
      break;
    }
    case "page": {
      const found = await db.page.findMany({
        ...common,
        select: { id: true, title: true, handle: true },
      });
      rows = found.map((r) => ({ id: r.id, title: r.title, handle: r.handle, imageUrl: null, status: null }));
      break;
    }
    case "article": {
      const found = await db.article.findMany({
        ...common,
        select: { id: true, title: true, handle: true, imageUrl: true },
      });
      rows = found.map((r) => ({ id: r.id, title: r.title, handle: r.handle, imageUrl: r.imageUrl, status: null }));
      break;
    }
    default:
      return empty;
  }
  if (rows.length === 0) return empty;

  const existing = await db.seoSitemapExclusion.findMany({
    where: { shop, resourceType, resourceId: { in: rows.map((r) => r.id) } },
    select: { resourceId: true, status: true },
  });
  const statusById = new Map(existing.map((e) => [e.resourceId, e.status]));

  return {
    hits: rows.map((r) => ({
      resourceType,
      resourceId: r.id,
      title: r.title,
      handle: r.handle,
      existingStatus: statusById.get(r.id) ?? null,
      caution: isLikelyKeepVisiblePage(resourceType, r.handle, r.title),
      imageUrl: r.imageUrl,
      status: r.status,
      alreadyOutOfSitemap: r.status !== null && STATUSES_ALREADY_OUT_OF_SITEMAP.includes(r.status),
    })),
    total,
    page,
    pageSize: MANUAL_PAGE_SIZE,
  };
}

async function countByType(
  db: PrismaClient,
  resourceType: SitemapExclusionResourceType,
  where: object,
): Promise<number> {
  switch (resourceType) {
    case "product":
      return db.product.count({ where });
    case "collection":
      return db.collection.count({ where });
    case "page":
      return db.page.count({ where });
    case "article":
      return db.article.count({ where });
    default:
      return 0;
  }
}

/**
 * Row for a manually chosen resource, ready for `applyExclusion`. Reuses an
 * existing row when there is one (the unique key forbids a second) — including
 * a previously reverted one, which is exactly the "exclude it again" case.
 * Returns null when the resource isn't in the DB cache, so a forged
 * `resourceId` from the client can never reach `metafieldsSet`.
 */
export async function ensureManualExclusion(
  db: PrismaClient,
  shop: string,
  resourceType: SitemapExclusionResourceType,
  resourceId: string,
): Promise<{ id: string; status: string } | null> {
  const exists = await resourceExistsInCache(db, shop, resourceType, resourceId);
  if (!exists) return null;

  const existing = await db.seoSitemapExclusion.findFirst({
    where: { shop, resourceType, resourceId },
    select: { id: true, status: true },
  });
  if (existing) return existing;

  const created = await db.seoSitemapExclusion.create({
    data: { shop, resourceType, resourceId, reason: "manual", status: "suggested" },
    select: { id: true, status: true },
  });
  return created;
}

async function resourceExistsInCache(
  db: PrismaClient,
  shop: string,
  resourceType: SitemapExclusionResourceType,
  resourceId: string,
): Promise<boolean> {
  const where = { shop, id: resourceId };
  switch (resourceType) {
    case "product":
      return !!(await db.product.findFirst({ where, select: { id: true } }));
    case "collection":
      return !!(await db.collection.findFirst({ where, select: { id: true } }));
    case "page":
      return !!(await db.page.findFirst({ where, select: { id: true } }));
    case "article":
      return !!(await db.article.findFirst({ where, select: { id: true } }));
    default:
      return false;
  }
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
  /** Why the fetch failed, so the UI can give an actionable hint instead of
   *  "please try again later" — which is wrong advice for the most common
   *  cause (a password-protected storefront never serves sitemap.xml at all).
   *  Undefined when `ok`. */
  failureReason?: SitemapFailureReason;
  /** HTTP status behind a `failureReason: "http"`, for the UI/logs. */
  httpStatus?: number;
}

/**
 * `password`  — storefront is password-protected; the fetch was redirected to
 *               /password. Shopify serves no sitemap in this state at all.
 * `http`      — reached the storefront, got a non-2xx (see `httpStatus`).
 * `timeout`   — no response within REQUEST_TIMEOUT_MS.
 * `network`   — DNS/TLS/connection failure — typically a domain that doesn't
 *               resolve, or a shop whose primary domain isn't live yet.
 * `notSitemap`— got a 200, but the body isn't a <urlset>/<sitemapindex> (an
 *               HTML error/parking page is the usual culprit).
 * `budget`    — a sitemap INDEX whose sub-sitemaps blew the fetch budget.
 */
export type SitemapFailureReason = "password" | "http" | "timeout" | "network" | "notSitemap" | "budget";

/** Identifies the app to the storefront. A UA-less request is a plausible
 *  trigger for bot protection; crawl.service.ts sends one for the same reason
 *  (`crawlUserAgent`) — kept as a local constant rather than an import so this
 *  section doesn't depend on the crawler module. */
const SITEMAP_USER_AGENT = "ContentPilotSEO/1.0 (+https://contentpilot.app/bot)";

interface XmlFetchOutcome {
  xml: string | null;
  /** 0 = network error, -1 = timeout. */
  status: number;
  /** Post-redirect URL — how the password redirect is detected. */
  finalUrl: string;
}

async function fetchXml(fetchImpl: typeof fetch, url: string): Promise<XmlFetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/xml, text/xml", "User-Agent": SITEMAP_USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    return { xml: null, status: controller.signal.aborted ? -1 : 0, finalUrl: url };
  } finally {
    clearTimeout(timer);
  }

  const finalUrl = res.url || url;
  if (!res.ok) return { xml: null, status: res.status, finalUrl };
  try {
    return { xml: await res.text(), status: res.status, finalUrl };
  } catch {
    return { xml: null, status: res.status, finalUrl };
  }
}

/** Did the storefront bounce us to its password gate? */
function isPasswordRedirect(finalUrl: string): boolean {
  try {
    return new URL(finalUrl).pathname.toLowerCase().startsWith("/password");
  } catch {
    return false;
  }
}

/** Map a failed root fetch to its reason. */
function classifyRootFailure(outcome: XmlFetchOutcome): SitemapFailureReason {
  if (isPasswordRedirect(outcome.finalUrl)) return "password";
  if (outcome.status === -1) return "timeout";
  if (outcome.status === 0) return "network";
  return "http";
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
  const root = await fetchXml(fetchImpl, sitemapUrl);
  if (!root.xml) {
    const failureReason = classifyRootFailure(root);
    return {
      sitemapUrl,
      entryCount: 0,
      urls: [],
      ok: false,
      failureReason,
      ...(failureReason === "http" ? { httpStatus: root.status } : {}),
    };
  }
  // A 200 that lands on /password is the password gate serving its HTML page —
  // status alone would look like success.
  if (isPasswordRedirect(root.finalUrl)) {
    return { sitemapUrl, entryCount: 0, urls: [], ok: false, failureReason: "password" };
  }

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(root.xml, { xmlMode: true });
  } catch {
    return { sitemapUrl, entryCount: 0, urls: [], ok: false, failureReason: "notSitemap" };
  }

  const subSitemapLocs: string[] = [];
  $("sitemap > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) subSitemapLocs.push(loc);
  });
  const isIndex = $("sitemapindex").length > 0 || subSitemapLocs.length > 0;

  // cheerio in xmlMode parses an HTML error/parking page happily and simply
  // finds no sitemap nodes — without this check that would report a valid but
  // empty sitemap ("Einträge: 0") instead of a fetch problem.
  if (!isIndex && $("urlset").length === 0) {
    return { sitemapUrl, entryCount: 0, urls: [], ok: false, failureReason: "notSitemap" };
  }

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
    return { sitemapUrl, entryCount: 0, urls: [], ok: false, failureReason: "budget" };
  }

  let entryCount = 0;
  const urls: string[] = [];
  for (const sub of raced) {
    if (!sub.xml) continue;
    let $sub: cheerio.CheerioAPI;
    try {
      $sub = cheerio.load(sub.xml, { xmlMode: true });
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
  /** `isLikelyKeepVisiblePage` — the UI shows a "check this first" warning instead
   *  of a plain apply button. Never hides the row. */
  caution: boolean;
}

export interface SitemapAnalysis {
  sitemapUrl: string | null;
  entryCount: number | null;
  sitemapFetchError: boolean;
  /** Set whenever `sitemapFetchError` — drives the actionable hint. */
  sitemapFailureReason: SitemapFailureReason | null;
  sitemapHttpStatus: number | null;
  /** Always present, even on a failed fetch, so the UI can link the URL it
   *  tried — half the diagnosis is seeing which domain was probed. */
  attemptedSitemapUrl: string;
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
  const idsByType: Record<string, string[]> = { product: [], collection: [], page: [], article: [] };
  for (const r of rows) {
    if (idsByType[r.resourceType]) idsByType[r.resourceType].push(r.resourceId);
  }
  const select = { id: true, title: true, handle: true };

  const [products, collections, pages, articles] = await Promise.all([
    idsByType.product.length
      ? db.product.findMany({ where: { shop, id: { in: idsByType.product } }, select })
      : Promise.resolve([]),
    idsByType.collection.length
      ? db.collection.findMany({ where: { shop, id: { in: idsByType.collection } }, select })
      : Promise.resolve([]),
    idsByType.page.length
      ? db.page.findMany({ where: { shop, id: { in: idsByType.page } }, select })
      : Promise.resolve([]),
    idsByType.article.length
      ? db.article.findMany({ where: { shop, id: { in: idsByType.article } }, select })
      : Promise.resolve([]),
  ]);

  const map = new Map<string, { title: string; handle: string }>();
  type Row = { id: string; title: string; handle: string };
  for (const p of products as Row[]) map.set(`product::${p.id}`, { title: p.title, handle: p.handle });
  for (const c of collections as Row[]) map.set(`collection::${c.id}`, { title: c.title, handle: c.handle });
  for (const pg of pages as Row[]) map.set(`page::${pg.id}`, { title: pg.title, handle: pg.handle });
  for (const a of articles as Row[]) map.set(`article::${a.id}`, { title: a.title, handle: a.handle });
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
    // A retired rule's leftover SUGGESTED rows are filtered out below rather
    // than deleted: this app never migrates merchant data for a UI-only
    // change, and a row that is merely hidden can be recovered if a rule ever
    // comes back.
    db.seoSitemapExclusion.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 500 }),
    db.seoCrawlSnapshot.findFirst({
      where: { shop, status: { in: ["completed", "capped"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    }),
    getCachedSitemapInfo(fetchImpl, shop, primaryDomain),
  ]);

  const titleMap = await resolveExclusionTitles(db, shop, exclusionRows);
  const exclusions: SitemapExclusionRow[] = exclusionRows
    .filter(
      (r) =>
        // Suggestions from a rule that no longer exists must not keep being
        // offered. Rows that were actually APPLIED stay visible regardless —
        // they hold a real metafield the merchant needs to be able to revert.
        r.status !== "suggested" || !RETIRED_EXCLUSION_REASONS.includes(r.reason ?? ""),
    )
    .map((r) => {
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
      caution: isLikelyKeepVisiblePage(resourceType, handle, title),
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
    sitemapFailureReason: sitemapInfo.ok ? null : sitemapInfo.failureReason ?? null,
    sitemapHttpStatus: sitemapInfo.httpStatus ?? null,
    attemptedSitemapUrl: sitemapInfo.sitemapUrl,
    exclusions,
    hasCrawlSnapshot: !!latestSnapshot,
    brokenInSitemap,
  };
}

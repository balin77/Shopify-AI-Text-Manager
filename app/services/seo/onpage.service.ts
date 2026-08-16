/**
 * On-page & indexability rules (PLAN_SEO_CRAWL_EXPANSION §3.1-§3.6).
 *
 * ONLY pure functions over rows the caller already loaded — no fetches, no
 * Prisma. The crawl is and stays the app's single live-fetch surface
 * (crawl.service.ts); `/app/seo/onpage` starts the SAME `seoCrawl` task and
 * reads the SAME latest snapshot, it never crawls on its own.
 *
 * Keeping the whole rule set pure is what makes it testable at all: every
 * category here is false-positive-prone in a way that only shows up on real
 * shop data (a `noindex` the merchant WANTED, a canonical Shopify set
 * correctly, a word count inflated by theme boilerplate), and each of those
 * rules is a unit test rather than an argument.
 */

import { normalizeCrawlUrl, classifyLinkStatus } from "./crawl.service";

// ── §3.1 Indexability ──────────────────────────────────────────────────────

export type IndexabilityVerdict =
  /** Nothing stops it from being indexed. */
  | "indexable"
  /** `noindex`/`none` in the meta tag OR the X-Robots-Tag header. */
  | "noindex"
  /** Indexable, but its links are not followed. */
  | "nofollow_only"
  /** The snapshot never looked (old row, or a page with no body). NOT "fine". */
  | "unknown";

export interface IndexabilityInput {
  metaRobots: string;
  xRobotsTag: string;
  indexabilityKnown: boolean;
  statusCode: number;
}

/**
 * Splits a robots directive string into bare directive tokens.
 *
 * Both sources are comma-separated lists. `X-Robots-Tag` may additionally
 * address a specific crawler (`googlebot: noindex, nosnippet`), and repeated
 * headers arrive comma-joined from `Headers.get()`, so a token can carry a
 * `<user-agent>:` prefix. The prefix is dropped rather than parsed: a
 * `noindex` aimed at Googlebot is exactly the finding this report exists for,
 * so narrowing by user-agent would hide the most valuable case.
 */
function robotsTokens(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const colon = trimmed.lastIndexOf(":");
      return (colon >= 0 ? trimmed.slice(colon + 1) : trimmed).trim().toLowerCase();
    })
    .filter(Boolean);
}

/**
 * The page's indexability, derived — never stored (§1.1): the raw strings are
 * persisted so this rule can be corrected without a re-crawl.
 *
 * `none` is shorthand for `noindex, nofollow`, so it counts as both.
 */
export function deriveIndexability(row: IndexabilityInput): IndexabilityVerdict {
  // The flag, not the emptiness of the strings, is the discriminator: "" means
  // "no directive served" OR "row written before the columns existed", and
  // those are indistinguishable (§1.1).
  if (!row.indexabilityKnown) return "unknown";
  // Defensive: a non-2xx page never had a body parsed, so there is nothing to
  // judge even if the flag somehow says otherwise.
  if (row.statusCode < 200 || row.statusCode >= 300) return "unknown";

  const tokens = [...robotsTokens(row.metaRobots), ...robotsTokens(row.xRobotsTag)];
  if (tokens.some((t) => t === "noindex" || t === "none")) return "noindex";
  if (tokens.some((t) => t === "nofollow")) return "nofollow_only";
  return "indexable";
}

// ── §3.2 The false-positive rule for `noindex` ─────────────────────────────

/**
 * Paths Shopify itself serves with `noindex`, or that are noindex by design.
 * Reporting these would bury the one finding that matters (a PRODUCT nobody
 * meant to hide) under a list of non-problems — the same failure mode the
 * 403 firewall blocks once produced in the broken-link list.
 *
 * Each entry says why it is expected, because "we filter this" is only
 * defensible if the reason survives the next person reading it.
 */
export const EXPECTED_NOINDEX_PATTERNS: Array<{ id: string; test: RegExp }> = [
  // Search results — noindex on every storefront, by Shopify's own template.
  { id: "search", test: /^\/search(\/|$|\?)/ },
  // Cart and checkout: transient state, never a landing page.
  { id: "cart", test: /^\/cart(\/|$|\?)/ },
  // Customer account area — PII-adjacent, noindex by Shopify.
  { id: "account", test: /^\/account(\/|$|\?)/ },
  // Legal policy pages. Shopify serves them noindex; they are linked in the
  // footer and are not meant to rank.
  { id: "policies", test: /^\/policies(\/|$|\?)/ },
  // Bot/anti-fraud interstitial.
  { id: "challenge", test: /^\/challenge(\/|$|\?)/ },
  // Filtered collections (`/collections/x/tagged/y`, and the bare
  // `/collections/x/<tag>` form): facet permutations Shopify deliberately keeps
  // out of the index. `/products/` is excluded from the match — a product
  // reached through a collection URL is a normal page, and excusing a `noindex`
  // there would swallow the single most valuable finding of this whole tab.
  { id: "taggedCollection", test: /^\/collections\/[^/]+\/(?!products(\/|$))[^/]+/ },
  // Market/price-constrained variants of an existing URL.
  { id: "constraint", test: /[?&]constraint=/ },
];

/** The id of the pattern explaining an expected `noindex`, or null. */
export function expectedNoindexReason(url: string): string | null {
  let pathAndQuery: string;
  try {
    const u = new URL(url);
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    pathAndQuery = url;
  }
  const lower = pathAndQuery.toLowerCase();
  // A locale prefix (/fr/search) must not defeat the match — strip a leading
  // two/five-letter language segment before testing.
  const withoutLocale = lower.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/, "");
  const hit = EXPECTED_NOINDEX_PATTERNS.find((p) => p.test.test(withoutLocale) || p.test.test(lower));
  return hit ? hit.id : null;
}

export interface OnPageRow {
  url: string;
  title: string | null;
  metaDesc: string | null;
  canonical: string | null;
  metaRobots: string;
  xRobotsTag: string;
  indexabilityKnown: boolean;
  h1Count: number;
  h1First: string | null;
  wordCount: number;
  imgCount: number;
  imgMissingAlt: number;
  statusCode: number;
  redirectHops: number;
  resourceType: string | null;
  resourceId: string | null;
  locale: string;
}

export interface IndexabilityFinding {
  url: string;
  verdict: IndexabilityVerdict;
  resourceType: string | null;
  resourceId: string | null;
  title: string | null;
  /** Set when the exclusion was deliberate — the pattern id, or "sitemapExclusion". */
  expectedReason: string | null;
  /** A non-primary locale prefix. MARKED, never judged (§3.2 nr. 3): whether a
   *  market should serve web search is a decision this report can't make. */
  localePrefixed: boolean;
}

export interface IndexabilityReport {
  /** Real findings — a page nobody meant to exclude. */
  problems: IndexabilityFinding[];
  /** Deliberately excluded, listed neutrally so the list stays trustworthy. */
  expected: IndexabilityFinding[];
  /** Pages whose links are not followed (indexable, but a weaker signal). */
  nofollowOnly: IndexabilityFinding[];
  /** 2xx pages the snapshot has no answer for — the reason the UI must not
   *  claim "everything is indexable" (§1.1). */
  unknownCount: number;
  /** Total 2xx pages considered. */
  consideredCount: number;
}

/**
 * Splits every `noindex` into "meant it" and "did not mean it".
 *
 * `excludedResourceKeys` holds `"<resourceType>:<resourceId>"` for
 * SeoSitemapExclusion rows with status **"applied"** — and only those. A
 * mere SUGGESTION explains nothing: `seo.hidden` was never written to Shopify,
 * so a page that is nevertheless `noindex` is noindex for some OTHER reason,
 * which is exactly the case counting suggestions would hide.
 */
export function analyzeIndexability(
  pages: OnPageRow[],
  excludedResourceKeys: Set<string>,
): IndexabilityReport {
  const problems: IndexabilityFinding[] = [];
  const expected: IndexabilityFinding[] = [];
  const nofollowOnly: IndexabilityFinding[] = [];
  let unknownCount = 0;
  let consideredCount = 0;

  for (const page of pages) {
    if (classifyLinkStatus(page.statusCode) !== "ok" || page.statusCode >= 300) continue;
    consideredCount += 1;
    const verdict = deriveIndexability(page);
    if (verdict === "unknown") {
      unknownCount += 1;
      continue;
    }
    if (verdict === "indexable") continue;

    const base = {
      url: page.url,
      verdict,
      resourceType: page.resourceType,
      resourceId: page.resourceId,
      title: page.title,
      localePrefixed: page.locale !== "",
    };

    if (verdict === "nofollow_only") {
      nofollowOnly.push({ ...base, expectedReason: null });
      continue;
    }

    const sitemapExcluded =
      page.resourceType && page.resourceId && excludedResourceKeys.has(`${page.resourceType}:${page.resourceId}`);
    const reason = sitemapExcluded ? "sitemapExclusion" : expectedNoindexReason(page.url);
    if (reason) expected.push({ ...base, expectedReason: reason });
    else problems.push({ ...base, expectedReason: null });
  }

  return { problems, expected, nofollowOnly, unknownCount, consideredCount };
}

// ── §3.3 Canonicals ────────────────────────────────────────────────────────

export type CanonicalIssue =
  | "missing"
  | "targetBroken"
  | "targetRedirects"
  | "crossHost"
  | "chain"
  | "targetNoindex";

export interface CanonicalFinding {
  url: string;
  issue: CanonicalIssue;
  /** The canonical as served (raw), so the merchant recognises it. */
  target: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

/**
 * Canonical defects — and ONLY defects.
 *
 * Shopify sets canonicals itself, and correctly:
 * `/collections/x/products/y` canonicalises to `/products/y`. A naive
 * "not self-referencing ⇒ error" reports hundreds of non-problems on every
 * shop, so the rule is inverted: a canonical pointing somewhere else is fine
 * unless that somewhere is demonstrably broken.
 *
 * Every case is computed from the snapshot table alone (the canonical is
 * joined against the OTHER crawled rows) — no extra fetch. A canonical whose
 * target was never crawled yields NO finding: we have nothing to say about it,
 * and guessing would be the false positive all over again.
 *
 * Comparison runs through `normalizeCrawlUrl`, the same normalization the
 * crawler used to build `url` — without it (trailing slash, myshopify vs.
 * primary host, query) every page reports a chain against itself.
 */
/**
 * The host to compare canonicals against, taken from the CRAWLED URLs
 * themselves.
 *
 * Not from `fetchPrimaryDomain`: that helper falls back to the
 * `.myshopify.com` host whenever the Admin call is throttled or fails, and
 * every crawled URL is normalized to the PRIMARY domain — so on a bad lookup
 * every single canonical would be "points at a foreign domain", critical, on
 * every page. The crawl's own URLs cannot be wrong about the host the crawl
 * used. Returns "" only when there are no parsable URLs at all, which the
 * caller must treat as "cannot judge canonicals".
 */
export function canonicalHostFromPages(pages: Array<{ url: string }>): string {
  for (const page of pages) {
    try {
      const host = new URL(page.url).hostname;
      if (host) return host;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

export function analyzeCanonicals(
  pages: OnPageRow[],
  canonicalHost: string,
  aliasHosts: string[] = [],
): CanonicalFinding[] {
  const norm = (raw: string, base: string): string | null =>
    normalizeCrawlUrl(raw, base, canonicalHost, aliasHosts);

  const byUrl = new Map<string, OnPageRow>();
  for (const p of pages) {
    const key = norm(p.url, p.url);
    if (key) byUrl.set(key, p);
  }

  const knowsParseState = snapshotKnowsParseState(pages);
  const findings: CanonicalFinding[] = [];
  for (const page of pages) {
    // Only pages that actually served content can have a canonical judged.
    if (page.statusCode < 200 || page.statusCode >= 300) continue;
    // A page whose body was never parsed has `canonical === null` for that
    // reason alone — reporting "missing" there is a crawl artifact, not a
    // theme defect. On a snapshot that predates the flag it is unknowable, and
    // `canonical` was captured back then too, so 2xx is the gate there (same
    // fallback as `judgeable`).
    if (knowsParseState && !page.indexabilityKnown) continue;

    const of = (issue: CanonicalIssue, target: string | null): CanonicalFinding => ({
      url: page.url,
      issue,
      target,
      resourceType: page.resourceType,
      resourceId: page.resourceId,
    });

    if (!page.canonical) {
      findings.push(of("missing", null));
      continue;
    }

    const normalized = norm(page.canonical, page.url);
    if (!normalized) {
      // Not same-origin (or not an http(s) URL at all) — the classic
      // migration/app accident: the canonical points at another shop.
      findings.push(of("crossHost", page.canonical));
      continue;
    }

    const self = norm(page.url, page.url);
    if (self && normalized === self) continue; // self-referencing: correct

    const target = byUrl.get(normalized);
    if (!target) continue; // never crawled — nothing verifiable, so nothing reported

    const targetClass = classifyLinkStatus(target.statusCode);
    if (targetClass === "broken" || targetClass === "server_error") {
      findings.push(of("targetBroken", page.canonical));
      continue;
    }
    if (deriveIndexability(target) === "noindex") {
      // A contradiction: the page hands its ranking to a page that refuses to
      // be indexed, so BOTH drop out.
      findings.push(of("targetNoindex", page.canonical));
      continue;
    }
    if (target.redirectHops > 0) {
      findings.push(of("targetRedirects", page.canonical));
      continue;
    }
    const targetCanonical = target.canonical ? norm(target.canonical, target.url) : null;
    if (targetCanonical && targetCanonical !== normalized) {
      // A → B, B → C. Google stops following at the first hop.
      findings.push(of("chain", page.canonical));
    }
  }
  return findings;
}

// ── §3.4 H1 / meta description ─────────────────────────────────────────────

export interface OnPageIssueRow {
  url: string;
  title: string | null;
  detail: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

/**
 * True when this snapshot records WHETHER a page's body was parsed.
 *
 * `indexabilityKnown` is that marker (§2.2), and it is false on every row of a
 * snapshot crawled before the column existed. Which of the two it is decides
 * how the rules below may read the data, so it is asked once per snapshot
 * rather than per row: a single 404 legitimately has no answer, and requiring
 * every row to know would declare a perfectly current snapshot unusable.
 */
export function snapshotKnowsParseState(pages: OnPageRow[]): boolean {
  return pages.some((p) => p.indexabilityKnown);
}

/**
 * Pages an on-page rule may judge.
 *
 * On a CURRENT snapshot: 2xx AND actually parsed. The parse flag matters
 * beyond old rows — a page found at the BFS depth limit is fetched but never
 * parsed, so its `canonical`/`title` are null for that reason alone, and
 * judging it would invent a "canonical missing" finding on every deep page.
 *
 * On an OLD snapshot (no row knows): 2xx only. `title`, `metaDesc`,
 * `canonical`, `h1Count` and `wordCount` are pre-existing columns and their
 * values are real, so gating them on a flag that did not exist yet would make
 * five categories claim "no problems found" — the loudest possible version of
 * the empty-column trap this plan exists to avoid. Rules that depend on the
 * NEW columns (`h1First`, `imgMissingAlt`) cannot fall back that way and are
 * marked unknown by their callers instead.
 */
function judgeable(pages: OnPageRow[]): OnPageRow[] {
  const knowsParseState = snapshotKnowsParseState(pages);
  return pages.filter(
    (p) => p.statusCode >= 200 && p.statusCode < 300 && (p.indexabilityKnown || !knowsParseState),
  );
}

function toIssueRow(page: OnPageRow, detail: string | null): OnPageIssueRow {
  return {
    url: page.url,
    title: page.title,
    detail,
    resourceType: page.resourceType,
    resourceId: page.resourceId,
  };
}

export interface HeadingReport {
  /** No H1 at all. */
  missing: OnPageIssueRow[];
  /** More than one. HTML5 allows it, Google still prefers one — a hint. */
  multiple: OnPageIssueRow[];
  /** H1 and <title> are the same text. Informational only. */
  sameAsTitle: OnPageIssueRow[];
  /**
   * False on a snapshot crawled before `h1First` existed. `sameAsTitle` is
   * then empty because the TEXT was never stored — not because no page matches
   * — so the UI must say "unknown" rather than "none found". `missing` and
   * `multiple` read `h1Count`, which is a pre-existing column and stays valid.
   */
  sameAsTitleKnown: boolean;
}

/** Comparison form for "H1 equals title" — entity decoding is unnecessary
 *  here (both sides come from cheerio's `.text()`), whitespace and case are
 *  not. Deliberately NOT the shop-name-stripping `normalizeHeadTitle`: a
 *  title of "Blue Shoe – Acme" vs. an H1 of "Blue Shoe" is the NORMAL,
 *  desirable shape, and flagging it would make the category noise. */
function compareText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function analyzeHeadings(pages: OnPageRow[]): HeadingReport {
  const rows = judgeable(pages);
  return {
    sameAsTitleKnown: snapshotKnowsParseState(pages),
    missing: rows.filter((p) => p.h1Count === 0).map((p) => toIssueRow(p, null)),
    multiple: rows.filter((p) => p.h1Count > 1).map((p) => toIssueRow(p, String(p.h1Count))),
    sameAsTitle: rows
      .filter((p) => {
        const h1 = compareText(p.h1First);
        return h1.length > 0 && h1 === compareText(p.title);
      })
      .map((p) => toIssueRow(p, p.h1First)),
  };
}

/**
 * Pages served WITHOUT a meta description.
 *
 * Deliberately different from the dashboard's `metaDescriptionMissing`: that
 * one reads the DB content cache (what the shop has stored), this one reads
 * what the storefront actually delivered. The two disagreeing is itself
 * information — a stored description that never reaches the HTML is a theme
 * problem the DB check can't see.
 */
export function findMissingMetaDescriptions(pages: OnPageRow[]): OnPageIssueRow[] {
  return judgeable(pages)
    .filter((p) => !(p.metaDesc || "").trim())
    .map((p) => toIssueRow(p, null));
}

/**
 * Pages serving images without alt text (§2.3). `alt=""` counts — which is why
 * this is "without alt text", never "error": a theme's decorative icons
 * legitimately land here.
 *
 * `imgCount`/`imgMissingAlt` are NEW columns, so on an older snapshot every
 * row reads 0 and this returns []. That is "not measured", not "all good" —
 * callers gate the category on `snapshotKnowsParseState` and say so.
 */
export function findImagesWithoutAlt(pages: OnPageRow[]): OnPageIssueRow[] {
  return judgeable(pages)
    .filter((p) => p.imgMissingAlt > 0)
    .sort((a, b) => b.imgMissingAlt - a.imgMissingAlt)
    .map((p) => toIssueRow(p, `${p.imgMissingAlt}/${p.imgCount}`));
}

// ── §3.5 Thin content ──────────────────────────────────────────────────────

/**
 * Pages of a type need to be this many before a percentile means anything.
 * A 10th percentile over six pages is noise with a number attached.
 */
export const THIN_MIN_SAMPLE = 20;

export interface ThinPageRow extends OnPageIssueRow {
  wordCount: number;
  /** The type this page was compared against — the whole point of the rule. */
  comparedType: string;
}

export interface ThinContentReport {
  pages: ThinPageRow[];
  /** Types skipped for lack of a sample — SAID, not silently dropped. */
  skippedTypes: Array<{ resourceType: string; pageCount: number }>;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * Thin pages — RELATIVE to their own resource type, never against a fixed
 * word count.
 *
 * `countWords` (crawl.service.ts) strips `nav, footer, script, style,
 * noscript` but not `header`, `aside`, cookie banners or any other theme
 * boilerplate, so 300-600 "words" is normal on a Shopify product template no
 * matter how empty the description is. Screaming Frog's absolute 200-word
 * threshold produces nonsense in both directions here: it flags nothing on a
 * chatty theme and everything on a minimal one.
 *
 * So: below the 10th percentile of the SAME resourceType **and** below half
 * that type's median. Both conditions, because the percentile alone would
 * always report 10% of the catalogue — including on a shop whose product texts
 * are uniformly short and perfectly fine.
 *
 * NOT reusing `findThinContentPages` (sitemap.service.ts) on purpose: that one
 * counts words in the DB `body` of a Page against an absolute threshold to
 * suggest a sitemap exclusion. Different input (stored body vs. delivered
 * HTML including boilerplate), different output, and an absolute threshold
 * this rule exists specifically to avoid. Two names, two questions — not two
 * definitions of one.
 */
export function findThinPages(pages: OnPageRow[]): ThinContentReport {
  const byType = new Map<string, OnPageRow[]>();
  for (const page of judgeable(pages)) {
    const type = page.resourceType || "unknown";
    const list = byType.get(type);
    if (list) list.push(page);
    else byType.set(type, [page]);
  }

  const out: ThinPageRow[] = [];
  const skippedTypes: ThinContentReport["skippedTypes"] = [];

  for (const [type, rows] of byType) {
    if (rows.length < THIN_MIN_SAMPLE) {
      skippedTypes.push({ resourceType: type, pageCount: rows.length });
      continue;
    }
    const counts = rows.map((r) => r.wordCount).sort((a, b) => a - b);
    const p10 = quantile(counts, 0.1);
    const median = quantile(counts, 0.5);
    const halfMedian = median / 2;
    for (const row of rows) {
      if (row.wordCount < p10 && row.wordCount < halfMedian) {
        out.push({ ...toIssueRow(row, null), wordCount: row.wordCount, comparedType: type });
      }
    }
  }

  out.sort((a, b) => a.wordCount - b.wordCount);
  skippedTypes.sort((a, b) => b.pageCount - a.pageCount);
  return { pages: out, skippedTypes };
}

/**
 * Storefront crawler / site audit (PLAN_SEO_SUITE_COMPLETION.md §3, Phase 1).
 *
 * The ONE live fetch allowed by the SEO section contract (§6 DB-cache-first):
 * everything else in this app reads the DB content cache, but broken links,
 * real response codes, rendered-head-vs-DB drift and orphan detection are
 * fundamentally blind without an actual crawl. Post-crawl ANALYSIS (broken
 * links, orphans, head-drift, duplicate titles) still joins against the DB
 * cache rather than making further live calls.
 *
 * Seeds `/` and `/sitemap.xml`, BFS same-origin (normalizing
 * `<shop>.myshopify.com` → the primary domain) to depth 5, respecting
 * robots.txt (via the shared `parseRobots`, aeo.service.ts). A `Semaphore`
 * (app/utils/semaphore.ts) caps 5 parallel requests with ~200ms spacing so
 * the crawl itself never becomes a self-inflicted load spike on the store.
 *
 * The link GRAPH is not persisted (§2 — would be ~200k rows on a 2000-page
 * crawl): inbound/outbound counts are aggregated in-memory, and only broken
 * edges are written to `SeoCrawlBrokenLink`.
 */

import * as cheerio from "cheerio";
import type { PrismaClient } from "@prisma/client";
import { Semaphore } from "../../utils/semaphore";
import { parseRobots, type RobotsGroup } from "./aeo.service";
import { resolveGscPagePath, resolvePathsToResources } from "./url-resolver.server";
import type { AuditType } from "./audit.service";

// ── Constants ────────────────────────────────────────────────────────────

/** Pagination whitelist (§3.2): `?page=1..5` survives the query-strip; anything
 *  else (facets, `?variant=`, `?sort_by=`, `page=6+`) is dropped entirely. */
export const CRAWL_PAGINATION_MAX = 5;

/** Hardcoded denylist (§3.2), in addition to robots.txt — paths we never crawl
 *  regardless of what robots.txt says (checkout/account are PII-adjacent and
 *  cart/challenge/password/cdn/apps are never useful SEO surface). */
export const CRAWL_DENYLIST_PATHS = [
  "/cart",
  "/checkout",
  "/account",
  "/challenge",
  "/password",
  "/cdn/",
  "/apps/",
];

/** Default page cap (§3.3), env-overridable up to (in practice) ~10 000. */
export const DEFAULT_MAX_CRAWL_PAGES = parseInt(process.env.SEO_CRAWL_MAX_PAGES || "2000", 10);

export const CRAWL_BFS_MAX_DEPTH = 5;
const REDIRECT_MAX_HOPS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB stream cap
const BOT_BLOCK_THRESHOLD = 3; // consecutive 403/429 -> abort
/** Safety bound on in-memory edges — a pathological site (or a crawl bug)
 *  must not grow unbounded memory; not in the plan text, defensive only. */
const MAX_EDGES_TRACKED = 100_000;
const MAX_BROKEN_LINKS_PERSISTED = 1000;
const MAX_SITEMAP_SEED_URLS = 5000;

export function crawlUserAgent(appUrl: string): string {
  return `ContentPilotSEO/1.0 (+${appUrl.replace(/\/+$/, "")}/bot)`;
}

// ── URL normalization (§3.2, pure + unit-tested) ────────────────────────────

function pathStartsWithSegment(pathname: string, seg: string): boolean {
  const clean = seg.endsWith("/") ? seg.slice(0, -1) : seg;
  return pathname === clean || pathname.startsWith(clean + "/");
}

/** True when `pathname` matches the hardcoded crawl denylist (§3.2). */
export function isDenylistedPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return CRAWL_DENYLIST_PATHS.some((d) => pathStartsWithSegment(p, d));
}

/**
 * Normalize a discovered link into the canonical crawl URL, or `null` when it
 * isn't a same-origin http(s) URL we can crawl. Same-origin includes the
 * shop's `.myshopify.com` domain, which is rewritten to `canonicalHost` (the
 * primary domain) so both hostnames collapse to one crawl identity.
 *
 * Rules (§3.2): query string stripped entirely except `page` (whitelisted,
 * clamped to 1..CRAWL_PAGINATION_MAX — out-of-range values are dropped, not
 * clamped, since a stripped page param collapses harmlessly with the
 * unpaginated URL); fragment stripped; trailing slash normalized (except
 * root); host lowercased.
 */
export function normalizeCrawlUrl(
  rawUrl: string,
  base: string,
  canonicalHost: string,
  aliasHosts: string[] = [],
): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase();
  const canon = canonicalHost.toLowerCase();
  const aliases = aliasHosts.map((h) => h.toLowerCase());
  if (host !== canon && !aliases.includes(host)) return null;

  u.protocol = "https:";
  u.hostname = canon; // collapse myshopify.com -> primary domain
  u.port = "";
  u.hash = "";
  u.username = "";
  u.password = "";

  const pageParam = u.searchParams.get("page");
  u.search = "";
  if (pageParam && /^[1-9][0-9]*$/.test(pageParam)) {
    const n = parseInt(pageParam, 10);
    if (n >= 1 && n <= CRAWL_PAGINATION_MAX) {
      u.searchParams.set("page", String(n));
    }
  }

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  if (u.pathname === "") u.pathname = "/";

  return u.toString();
}

// ── robots.txt matching (§3.3, pure + unit-tested) ──────────────────────────

/**
 * Longest-prefix-match robots.txt evaluation against the parsed groups
 * (`parseRobots`, aeo.service.ts) for our crawler's own user-agent, falling
 * back to the `*` group. No matching group at all = allow. Ties (equal
 * prefix length) resolve to Allow, matching the common REP implementation
 * convention.
 */
export function isAllowedByRobots(groups: RobotsGroup[], pathname: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const group = specific ?? groups.find((g) => g.agents.includes("*")) ?? null;
  if (!group) return true;

  let bestLen = -1;
  let allowed = true;
  for (const rule of group.rules) {
    if (rule.path === "") continue; // empty Disallow = allow-all, not a real rule
    if (pathname.startsWith(rule.path) && rule.path.length > bestLen) {
      bestLen = rule.path.length;
      allowed = rule.type === "allow";
    }
  }
  return allowed;
}

// ── Broken-link classification (§3.1, pure + unit-tested) ──────────────────

/** `statusCode` semantics: 0 = timeout/network error, -1 = redirect loop /
 *  chain longer than REDIRECT_MAX_HOPS, else the real HTTP status. */
export function classifyLinkStatus(statusCode: number): "ok" | "broken" {
  if (statusCode === 0 || statusCode === -1) return "broken";
  if (statusCode >= 400) return "broken";
  return "ok";
}

// ── Head-drift normalization (§3.1, pure + unit-tested) ─────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
};

/** Decode the small set of HTML entities that show up in <title> text —
 *  cheerio already decodes entities when reading `.text()`, but DB-authored
 *  titles occasionally contain literal entities (copy-pasted from HTML), so
 *  both sides of the head-drift comparison go through this. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a <title>/DB-title for head-drift comparison (§3.1): decode
 * entities, strip a trailing "– ShopName" / "- ShopName" / "| ShopName"
 * suffix (themes append this almost universally), collapse whitespace,
 * lowercase. Two titles that normalize equal are NOT a drift finding.
 */
export function normalizeHeadTitle(title: string | null | undefined, shopName: string): string {
  let t = decodeHtmlEntities(title || "").trim();
  const name = shopName.trim();
  if (name) {
    const suffixRe = new RegExp(`[\\s]*[-–—|][\\s]*${escapeRegExp(name)}\\s*$`, "i");
    t = t.replace(suffixRe, "");
  }
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

// ── Word count (§3.1) ───────────────────────────────────────────────────────

function countWords($: cheerio.CheerioAPI): number {
  const hasBody = $("body").length > 0;
  const root = (hasBody ? $("body") : $.root()) as cheerio.Cheerio<any>;
  const clone = root.clone();
  clone.find("nav, footer, script, style, noscript").remove();
  const text = clone.text().replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}

// ── Fetch layer (redirects, timeout, retry, stream cap) ────────────────────

interface FetchOutcome {
  /** Final HTTP status, 0 = timeout/network error, -1 = redirect loop/too-long chain. */
  status: number;
  finalUrl: string;
  contentType: string;
  body: string | null;
  responseMs: number;
  /** Every URL visited in the redirect chain, including the start URL — used
   *  for the password-redirect check on the root seed. */
  hops: string[];
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    try {
      const text = await res.text();
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } catch {
      return "";
    }
  }
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      break;
    }
  }
  return out;
}

async function fetchOnceWithRedirects(
  fetchImpl: typeof fetch,
  startUrl: string,
  userAgent: string,
): Promise<FetchOutcome> {
  const started = Date.now();
  let currentUrl = startUrl;
  const hops: string[] = [startUrl];

  for (let hop = 0; hop <= REDIRECT_MAX_HOPS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html", "User-Agent": userAgent },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return { status: 0, finalUrl: currentUrl, contentType: "", body: null, responseMs: Date.now() - started, hops };
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          status: res.status,
          finalUrl: currentUrl,
          contentType: res.headers.get("content-type") || "",
          body: null,
          responseMs: Date.now() - started,
          hops,
        };
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        return { status: -1, finalUrl: currentUrl, contentType: "", body: null, responseMs: Date.now() - started, hops };
      }
      if (hop === REDIRECT_MAX_HOPS) {
        hops.push(next);
        return { status: -1, finalUrl: next, contentType: "", body: null, responseMs: Date.now() - started, hops };
      }
      currentUrl = next;
      hops.push(next);
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    let body: string | null = null;
    // Discard non-HTML content types after the headers (§3.1) — never buffer
    // the body of an image/PDF/etc, and never traverse links out of it.
    if (contentType.toLowerCase().includes("text/html")) {
      body = await readBodyCapped(res, MAX_BODY_BYTES);
    }
    return { status: res.status, finalUrl: currentUrl, contentType, body, responseMs: Date.now() - started, hops };
  }
  // Unreachable (loop always returns), kept for type-completeness.
  return { status: -1, finalUrl: currentUrl, contentType: "", body: null, responseMs: Date.now() - started, hops };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** No retry on 4xx (§3.3); one retry with a small backoff on 5xx/timeout. */
async function fetchWithRetry(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<FetchOutcome> {
  const first = await fetchOnceWithRedirects(fetchImpl, url, userAgent);
  const shouldRetry = first.status === 0 || (first.status >= 500 && first.status < 600);
  if (!shouldRetry) return first;
  await sleep(500);
  return fetchOnceWithRedirects(fetchImpl, url, userAgent);
}

async function fetchSitemapUrls(fetchImpl: typeof fetch, sitemapUrl: string, userAgent: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(sitemapUrl, {
        headers: { Accept: "application/xml, text/xml", "User-Agent": userAgent },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return [];
    const text = await res.text();
    // Loose XML parse (cheerio in xmlMode) — covers both a plain urlset and a
    // sitemap index (nested <sitemap><loc>); nested sub-sitemaps are enqueued
    // like any other same-origin URL but not recursively expanded (documented
    // limitation, not required by §3.1 — the root `/` seed still finds
    // everything reachable by links).
    const $ = cheerio.load(text, { xmlMode: true });
    const locs: string[] = [];
    $("loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) locs.push(loc);
    });
    return locs.slice(0, MAX_SITEMAP_SEED_URLS);
  } catch {
    return [];
  }
}

// ── Crawl orchestration ─────────────────────────────────────────────────────

interface PageRecord {
  url: string;
  statusCode: number;
  redirectedTo: string | null;
  responseMs: number;
  title: string | null;
  metaDesc: string | null;
  canonical: string | null;
  h1Count: number;
  wordCount: number;
  locale: string;
}

export interface RunCrawlDeps {
  db: PrismaClient;
  shop: string;
  /** Storefront primary domain (no protocol), e.g. "shop.com". */
  primaryDomain: string;
  /** The shop's `*.myshopify.com` domain — normalized to primaryDomain. */
  myshopifyDomain: string;
  /** Used to strip the "– ShopName" suffix in head-drift comparisons. */
  shopName: string;
  /** Used to build the crawler's User-Agent (bot info URL). */
  appUrl: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  onProgress?: (pagesCrawled: number, totalDiscovered: number) => void | Promise<void>;
  /** Heartbeat cadence in pages (§3.5: every 25). */
  heartbeatEvery?: number;
}

export interface CrawlSummary {
  status: "completed" | "failed" | "capped";
  error?: string;
  pagesCrawled: number;
  totalDiscovered: number;
  pagesOk: number;
  pagesBroken: number;
  orphanCount: number;
  headDriftCount: number;
}

/** Lowercase resourceType, matching `SeoCrawlPage.resourceType` / `AuditType`
 *  plus "unknown" for same-origin HTML pages that don't map to a known
 *  content route (theme pages, metaobjects — §3.8). */
type CrawlResourceType = AuditType | "unknown";

const RESOLVED_TYPE_TO_AUDIT_TYPE: Record<string, AuditType> = {
  Product: "product",
  Collection: "collection",
  Page: "page",
  Article: "article",
};

/**
 * Runs the full crawl for `snapshotId` (already created by the caller with
 * status "running" — see seo-crawl.handler.ts) and persists SeoCrawlPage /
 * SeoCrawlBrokenLink rows, then returns the summary the caller writes back
 * onto the SeoCrawlSnapshot row. Everything is held in memory during the run
 * (bounded by the page cap, ~2000 by default) and written in two bulk
 * `createMany` calls at the end rather than per-page, keeping the DB
 * round-trips small.
 */
export async function runCrawl(snapshotId: string, deps: RunCrawlDeps): Promise<CrawlSummary> {
  const {
    db,
    shop,
    primaryDomain,
    myshopifyDomain,
    shopName,
    appUrl,
    fetchImpl = fetch,
    maxPages = DEFAULT_MAX_CRAWL_PAGES,
    onProgress,
    heartbeatEvery = 25,
  } = deps;

  const userAgent = crawlUserAgent(appUrl);
  const origin = `https://${primaryDomain}`;
  const rootUrl = normalizeCrawlUrl("/", origin, primaryDomain, [myshopifyDomain]);
  if (!rootUrl) {
    return {
      status: "failed",
      error: "invalid_domain",
      pagesCrawled: 0,
      totalDiscovered: 0,
      pagesOk: 0,
      pagesBroken: 0,
      orphanCount: 0,
      headDriftCount: 0,
    };
  }

  // robots.txt — best-effort; a fetch failure means "allow everything"
  // rather than blocking the whole crawl.
  let robotsGroups: RobotsGroup[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${origin}/robots.txt`, {
        headers: { "User-Agent": userAgent },
        signal: controller.signal,
      });
      if (res.ok) robotsGroups = parseRobots(await res.text());
    } finally {
      clearTimeout(timer);
    }
  } catch {
    robotsGroups = [];
  }

  const pages = new Map<string, PageRecord>();
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();
  const edgeSeen = new Set<string>();
  const edges: { from: string; to: string; anchor: string | null }[] = [];

  let pagesStarted = 0;
  let pagesCompleted = 0;
  let capped = false;
  let consecutiveBlocked = 0;
  let abortedError: string | null = null;
  let outstanding = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const semaphore = new Semaphore(5, 200);

  const recordEdge = (from: string, to: string, anchor: string | null) => {
    if (from === to) return; // self-links don't count as inbound (§3.1)
    outboundCounts.set(from, (outboundCounts.get(from) ?? 0) + 1);
    const key = `${from}::${to}`;
    if (edgeSeen.has(key)) return; // one increment per (from,to) pair, not per repeated <a>
    if (edges.length >= MAX_EDGES_TRACKED) return;
    edgeSeen.add(key);
    edges.push({ from, to, anchor });
    inboundCounts.set(to, (inboundCounts.get(to) ?? 0) + 1);
  };

  const maybeHeartbeat = async () => {
    if (onProgress && pagesCompleted % heartbeatEvery === 0) {
      await onProgress(pagesCompleted, discovered.size);
    }
  };

  const fetchAndProcess = async (url: string, depth: number): Promise<void> => {
    if (abortedError) return;
    const outcome = await fetchWithRetry(fetchImpl, url, userAgent);
    pagesCompleted += 1;

    if (outcome.status === 403 || outcome.status === 429) {
      consecutiveBlocked += 1;
      if (consecutiveBlocked >= BOT_BLOCK_THRESHOLD && !abortedError) {
        abortedError = "bot_blocked";
      }
    } else {
      consecutiveBlocked = 0;
    }

    if (url === rootUrl && !abortedError) {
      const hitPassword = outcome.hops.some((h) => {
        try {
          return new URL(h).pathname.toLowerCase().startsWith("/password");
        } catch {
          return false;
        }
      });
      if (hitPassword) abortedError = "storefront_password";
    }

    const record: PageRecord = {
      url,
      statusCode: outcome.status,
      redirectedTo: outcome.finalUrl !== url ? outcome.finalUrl : null,
      responseMs: outcome.responseMs,
      title: null,
      metaDesc: null,
      canonical: null,
      h1Count: 0,
      wordCount: 0,
      locale: resolveGscPagePath(url)?.locale ?? "",
    };
    pages.set(url, record);

    await maybeHeartbeat();

    if (abortedError) return;

    if (outcome.body && outcome.status >= 200 && outcome.status < 300 && depth < CRAWL_BFS_MAX_DEPTH) {
      let $: cheerio.CheerioAPI;
      try {
        $ = cheerio.load(outcome.body);
      } catch {
        return;
      }
      record.title = $("title").first().text().trim() || null;
      record.metaDesc = $('meta[name="description"]').attr("content")?.trim() || null;
      record.canonical = $('link[rel="canonical"]').attr("href")?.trim() || null;
      record.h1Count = $("h1").length;
      record.wordCount = countWords($);

      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200) || null;
        tryEnqueue(href, depth + 1, url, anchor);
      });
    }
  };

  const spawn = (url: string, depth: number) => {
    outstanding += 1;
    void semaphore
      .run(() => fetchAndProcess(url, depth))
      .finally(() => {
        outstanding -= 1;
        if (outstanding === 0) resolveDone();
      });
  };

  function tryEnqueue(rawUrl: string, depth: number, fromUrl: string | null, anchor: string | null): void {
    if (abortedError) return;
    if (depth > CRAWL_BFS_MAX_DEPTH) return;
    const norm = normalizeCrawlUrl(rawUrl, origin, primaryDomain, [myshopifyDomain]);
    if (!norm) return;

    let pathname: string;
    try {
      pathname = new URL(norm).pathname;
    } catch {
      return;
    }
    if (isDenylistedPath(pathname)) return;
    if (!isAllowedByRobots(robotsGroups, pathname, userAgent)) return;

    if (fromUrl) recordEdge(fromUrl, norm, anchor);

    if (visited.has(norm)) return;
    visited.add(norm);
    discovered.add(norm);

    if (pagesStarted >= maxPages) {
      capped = true;
      return;
    }
    pagesStarted += 1;
    spawn(norm, depth);
  }

  // Sitemap seed (§3.1) — fetched once up front, its <loc> entries become
  // additional BFS seeds at depth 0. Not itself persisted as a SeoCrawlPage
  // (it's a data feed, not a storefront page).
  const sitemapUrl = normalizeCrawlUrl("/sitemap.xml", origin, primaryDomain, [myshopifyDomain]);
  if (sitemapUrl && isAllowedByRobots(robotsGroups, "/sitemap.xml", userAgent)) {
    const sitemapLocs = await fetchSitemapUrls(fetchImpl, sitemapUrl, userAgent);
    for (const loc of sitemapLocs) tryEnqueue(loc, 0, null, null);
  }
  tryEnqueue(rootUrl, 0, null, null);

  if (outstanding > 0) {
    await done;
  }

  // ---- Post-crawl analysis (§3.1) ----------------------------------------
  const pageUrls = Array.from(pages.keys());
  const resolvedByUrl = await resolvePathsToResources(db, shop, pageUrls);

  let pagesOk = 0;
  let pagesBroken = 0;
  const persistablePages: {
    shop: string;
    snapshotId: string;
    url: string;
    statusCode: number;
    redirectedTo: string | null;
    responseMs: number;
    title: string | null;
    metaDesc: string | null;
    canonical: string | null;
    h1Count: number;
    wordCount: number;
    resourceType: CrawlResourceType | null;
    resourceId: string | null;
    locale: string;
    inboundCount: number;
    outboundCount: number;
  }[] = [];

  const headDriftCandidates: { resourceType: AuditType; resourceId: string; crawledTitle: string | null }[] = [];

  for (const [url, page] of pages) {
    const cls = classifyLinkStatus(page.statusCode);
    if (cls === "ok") pagesOk += 1;
    else pagesBroken += 1;

    const resolved = resolvedByUrl.get(url) ?? null;
    const resourceType: CrawlResourceType | null = resolved
      ? RESOLVED_TYPE_TO_AUDIT_TYPE[resolved.resourceType]
      : "unknown";
    const resourceId = resolved?.id ?? null;

    persistablePages.push({
      shop,
      snapshotId,
      url,
      statusCode: page.statusCode,
      redirectedTo: page.redirectedTo,
      responseMs: page.responseMs,
      title: page.title,
      metaDesc: page.metaDesc,
      canonical: page.canonical,
      h1Count: page.h1Count,
      wordCount: page.wordCount,
      resourceType,
      resourceId,
      locale: page.locale,
      inboundCount: inboundCounts.get(url) ?? 0,
      outboundCount: outboundCounts.get(url) ?? 0,
    });

    if (resourceId && resourceType && resourceType !== "unknown" && page.locale === "") {
      headDriftCandidates.push({ resourceType, resourceId, crawledTitle: page.title });
    }
  }

  const orphanCount = persistablePages.filter((p) => p.resourceId && p.inboundCount === 0).length;
  const headDrift = await computeHeadDrift(db, shop, headDriftCandidates, shopName, Infinity);

  const brokenLinkRows = edges
    .filter((e) => {
      const target = pages.get(e.to);
      return target ? classifyLinkStatus(target.statusCode) === "broken" : false;
    })
    .slice(0, MAX_BROKEN_LINKS_PERSISTED)
    .map((e) => ({
      shop,
      snapshotId,
      fromUrl: e.from,
      toUrl: e.to,
      statusCode: pages.get(e.to)!.statusCode,
      anchor: e.anchor,
    }));

  if (persistablePages.length > 0) {
    await db.seoCrawlPage.createMany({ data: persistablePages });
  }
  if (brokenLinkRows.length > 0) {
    await db.seoCrawlBrokenLink.createMany({ data: brokenLinkRows });
  }

  if (onProgress) await onProgress(pagesCompleted, discovered.size);

  const status: CrawlSummary["status"] = abortedError ? "failed" : capped ? "capped" : "completed";

  return {
    status,
    error: abortedError ?? undefined,
    pagesCrawled: pagesCompleted,
    totalDiscovered: discovered.size,
    pagesOk,
    pagesBroken,
    orphanCount,
    headDriftCount: headDrift.count,
  };
}

// ── Shared head-drift comparison (used by the crawl runner AND the dashboard
//    bucket builder, audit.service.ts — one comparison rule, not two) ───────

export interface HeadDriftCandidate {
  resourceType: AuditType;
  resourceId: string;
  crawledTitle: string | null;
}

export interface HeadDriftItem {
  type: AuditType;
  id: string;
  title: string;
  crawledTitle: string;
  dbTitle: string;
}

const AUDIT_TYPE_TO_DELEGATE: Record<AuditType, "product" | "collection" | "article" | "page"> = {
  product: "product",
  collection: "collection",
  article: "article",
  page: "page",
};

/**
 * Compares each candidate's crawled `<title>` against the DB's effective SEO
 * title (seoTitle, falling back to the item title) using the normalized
 * (§3.1) comparison, batching one `findMany` per resource type. Returns the
 * TRUE count (never capped) plus an `items` list capped at `capItems` — the
 * crawl runner calls this with `Infinity` (only needs the count for
 * SeoCrawlSnapshot.headDriftCount), the dashboard bucket builder calls it
 * with MAX_PROBLEM_BUCKET_ITEMS.
 */
export async function computeHeadDrift(
  db: PrismaClient,
  shop: string,
  candidates: HeadDriftCandidate[],
  shopName: string,
  capItems: number,
): Promise<{ count: number; items: HeadDriftItem[] }> {
  if (candidates.length === 0) return { count: 0, items: [] };

  const idsByType: Record<AuditType, string[]> = { product: [], collection: [], article: [], page: [] };
  for (const c of candidates) idsByType[c.resourceType].push(c.resourceId);

  const titleMaps: Record<AuditType, Map<string, { title: string; seoTitle: string }>> = {
    product: new Map(),
    collection: new Map(),
    article: new Map(),
    page: new Map(),
  };

  await Promise.all(
    (Object.keys(idsByType) as AuditType[]).map(async (type) => {
      const ids = idsByType[type];
      if (ids.length === 0) return;
      const delegate = (db as any)[AUDIT_TYPE_TO_DELEGATE[type]];
      const rows: { id: string; title: string; seoTitle: string | null }[] = await delegate.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, seoTitle: true },
      });
      for (const r of rows) titleMaps[type].set(r.id, { title: r.title, seoTitle: r.seoTitle || "" });
    }),
  );

  let count = 0;
  const items: HeadDriftItem[] = [];
  for (const c of candidates) {
    const dbRow = titleMaps[c.resourceType].get(c.resourceId);
    if (!dbRow) continue; // beyond the audit cap / not in cache — skip, not a finding
    const dbTitle = dbRow.seoTitle || dbRow.title;
    const crawled = normalizeHeadTitle(c.crawledTitle, shopName);
    const stored = normalizeHeadTitle(dbTitle, shopName);
    if (crawled === stored) continue;
    count += 1;
    if (items.length < capItems) {
      items.push({
        type: c.resourceType,
        id: c.resourceId,
        title: dbRow.title,
        crawledTitle: c.crawledTitle || "",
        dbTitle,
      });
    }
  }
  return { count, items };
}

// ── Duplicate titles (§3.1 — UI-only, not persisted to the snapshot) ───────

export interface DuplicateTitleGroup {
  title: string;
  urls: string[];
}

/** Groups crawled pages by normalized title (>=2 URLs sharing one). Pure —
 *  used by the crawl route loader against the persisted SeoCrawlPage rows;
 *  no dedicated count field exists on SeoCrawlSnapshot for this. */
export function groupDuplicateTitles(
  pagesForGrouping: { url: string; title: string | null }[],
  shopName: string,
): DuplicateTitleGroup[] {
  const groups = new Map<string, string[]>();
  for (const p of pagesForGrouping) {
    const norm = normalizeHeadTitle(p.title, shopName);
    if (!norm) continue;
    const list = groups.get(norm);
    if (list) list.push(p.url);
    else groups.set(norm, [p.url]);
  }
  return Array.from(groups.entries())
    .filter(([, urls]) => urls.length > 1)
    .map(([title, urls]) => ({ title, urls }))
    .sort((a, b) => b.urls.length - a.urls.length);
}

// ── Retention (§2) ──────────────────────────────────────────────────────────

/** Keep only the newest N snapshots per shop — cascade removes the pruned
 *  snapshots' pages/brokenLinks with them. Called before creating a new
 *  snapshot (seo-crawl.handler.ts), not on a cron. */
export async function pruneOldCrawlSnapshots(db: PrismaClient, shop: string, keep = 5): Promise<void> {
  const rows = await db.seoCrawlSnapshot.findMany({
    where: { shop },
    select: { id: true },
    orderBy: { startedAt: "desc" },
    skip: keep,
  });
  if (rows.length === 0) return;
  await db.seoCrawlSnapshot.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
}

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as cheerio from "cheerio";
import {
  normalizeCrawlUrl,
  isDenylistedPath,
  classifyLinkStatus,
  isBotBlockStatus,
  diagnoseBlock,
  detectMerchantCloudflare,
  attributeBlockSource,
  escalateSpacingMs,
  decaySpacingMs,
  SPACING_DECAY_AFTER_OK,
  BASE_SPACING_MS,
  MAX_SPACING_MS,
  parseRetryAfter,
  dominantBlockSource,
  parseCrawlError,
  rateLimitRetryDelayMs,
  extractJsonLdTypes,
  extractAppJsonLdTypes,
  extractMetaRobots,
  countImagesWithoutAlt,
  coolDownDurationMs,
  BLOCK_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  normalizeHeadTitle,
  decodeHtmlEntities,
  isAllowedByRobots,
  groupDuplicateTitles,
  runCrawl,
  pruneOldCrawlSnapshots,
  CRAWL_PAGINATION_MAX,
  CRAWL_DENYLIST_PATHS,
} from "~/services/seo/crawl.service";
import { parseRobots } from "~/services/seo/aeo.service";
import { resolveGscPagePath } from "~/services/seo/url-resolver.server";

/**
 * Phase 1 (PLAN_SEO_SUITE_COMPLETION.md §3, §9): URL normalization, robots
 * matching, broken-link classification, head-drift normalization — all pure —
 * plus an msw-mocked end-to-end run of the crawler against a small fixture
 * site (broken link, redirect chain, robots block, password redirect).
 */

// ── URL normalization (§3.2) ────────────────────────────────────────────────

describe("normalizeCrawlUrl", () => {
  const canon = "shop.example.com";
  const alias = ["shop.myshopify.com"];

  it("strips query params entirely by default", () => {
    expect(normalizeCrawlUrl("https://shop.example.com/products/foo?variant=123&sort_by=price", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/products/foo",
    );
  });

  it("keeps ?page=N within the whitelist (1..CRAWL_PAGINATION_MAX)", () => {
    expect(CRAWL_PAGINATION_MAX).toBe(5);
    expect(normalizeCrawlUrl("https://shop.example.com/collections/all?page=3", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/collections/all?page=3",
    );
  });

  it("drops ?page=N entirely once it exceeds the whitelist", () => {
    expect(normalizeCrawlUrl("https://shop.example.com/collections/all?page=6", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/collections/all",
    );
    expect(normalizeCrawlUrl("https://shop.example.com/collections/all?page=0", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/collections/all",
    );
  });

  it("drops the page param when other query params are also present (whole query stripped)", () => {
    expect(
      normalizeCrawlUrl("https://shop.example.com/collections/all?sort_by=price&page=2", "https://shop.example.com", canon, alias),
    ).toBe("https://shop.example.com/collections/all?page=2");
  });

  it("strips the fragment", () => {
    expect(normalizeCrawlUrl("https://shop.example.com/pages/about#team", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/pages/about",
    );
  });

  it("normalizes a trailing slash (except root)", () => {
    expect(normalizeCrawlUrl("https://shop.example.com/products/foo/", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/products/foo",
    );
    expect(normalizeCrawlUrl("https://shop.example.com/", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/",
    );
  });

  it("lowercases the host", () => {
    expect(normalizeCrawlUrl("https://SHOP.EXAMPLE.COM/products/foo", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/products/foo",
    );
  });

  it("collapses the myshopify.com alias host onto the canonical/primary domain", () => {
    expect(normalizeCrawlUrl("https://shop.myshopify.com/products/foo", "https://shop.example.com", canon, alias)).toBe(
      "https://shop.example.com/products/foo",
    );
  });

  it("rejects a different (non-alias) origin — not same-origin", () => {
    expect(normalizeCrawlUrl("https://evil.example.com/products/foo", "https://shop.example.com", canon, alias)).toBeNull();
  });

  it("resolves a relative href against the base", () => {
    expect(normalizeCrawlUrl("/products/foo", "https://shop.example.com/collections/all", canon, alias)).toBe(
      "https://shop.example.com/products/foo",
    );
  });

  it("rejects an unparsable URL", () => {
    // With a base URL, the WHATWG URL parser treats almost any string as a
    // relative path (very lenient) — a malformed absolute URL (bad IPv6
    // literal) is one of the few inputs that reliably throws either way.
    expect(normalizeCrawlUrl("http://[::1", "https://shop.example.com", canon, alias)).toBeNull();
  });

  it("rejects non-http(s) protocols", () => {
    expect(normalizeCrawlUrl("mailto:foo@shop.example.com", "https://shop.example.com", canon, alias)).toBeNull();
    expect(normalizeCrawlUrl("tel:+1234567890", "https://shop.example.com", canon, alias)).toBeNull();
  });
});

describe("isDenylistedPath", () => {
  it("blocks every hardcoded denylist path and its sub-paths", () => {
    expect(CRAWL_DENYLIST_PATHS).toEqual(
      expect.arrayContaining(["/cart", "/checkout", "/account", "/challenge", "/password", "/cdn/", "/apps/"]),
    );
    expect(isDenylistedPath("/cart")).toBe(true);
    expect(isDenylistedPath("/cart/add")).toBe(true);
    expect(isDenylistedPath("/checkout")).toBe(true);
    expect(isDenylistedPath("/account/login")).toBe(true);
    expect(isDenylistedPath("/challenge")).toBe(true);
    expect(isDenylistedPath("/password")).toBe(true);
    expect(isDenylistedPath("/cdn/shop/t/1/assets/x.js")).toBe(true);
    expect(isDenylistedPath("/apps/some-app")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDenylistedPath("/Cart")).toBe(true);
  });

  it("does not false-positive on a path that merely starts with a denylisted word", () => {
    expect(isDenylistedPath("/careters")).toBe(false); // not /cart
    expect(isDenylistedPath("/products/cart-bag")).toBe(false);
  });

  it("allows ordinary storefront paths", () => {
    expect(isDenylistedPath("/products/blue-shoe")).toBe(false);
    expect(isDenylistedPath("/collections/all")).toBe(false);
    expect(isDenylistedPath("/")).toBe(false);
  });
});

describe("locale-prefix detection (resolveGscPagePath, reused by the crawler)", () => {
  it("detects a locale prefix on a crawled URL", () => {
    expect(resolveGscPagePath("https://shop.example.com/fr/products/foo")).toEqual({
      resourceType: "Product",
      handle: "foo",
      locale: "fr",
    });
  });
  it("no locale prefix -> locale null", () => {
    expect(resolveGscPagePath("https://shop.example.com/products/foo")?.locale).toBeNull();
  });
});

// ── Broken-link classification (§3.1) ───────────────────────────────────────

describe("classifyLinkStatus", () => {
  it("classifies 4xx as broken", () => {
    expect(classifyLinkStatus(404)).toBe("broken");
    expect(classifyLinkStatus(410)).toBe("broken");
  });
  it("classifies 5xx as a server error, not a broken link", () => {
    // A 5xx means the merchant's own page failed — a different problem from a
    // link pointing at something that doesn't exist, and a different fix.
    expect(classifyLinkStatus(500)).toBe("server_error");
    expect(classifyLinkStatus(502)).toBe("server_error");
  });
  it("classifies 0 (timeout / unreachable) as a server error", () => {
    expect(classifyLinkStatus(0)).toBe("server_error");
  });
  it("classifies -1 (redirect loop / too many hops) as broken", () => {
    // A redirect loop is a link/redirect configuration fault, not the page
    // failing to render.
    expect(classifyLinkStatus(-1)).toBe("broken");
  });
  it("classifies 2xx/3xx as ok", () => {
    expect(classifyLinkStatus(200)).toBe("ok");
    expect(classifyLinkStatus(301)).toBe("ok");
    expect(classifyLinkStatus(304)).toBe("ok");
  });
  it("classifies 403/429 as blocked, not broken (bot firewall, page is fine)", () => {
    expect(classifyLinkStatus(403)).toBe("blocked");
    expect(classifyLinkStatus(429)).toBe("blocked");
    expect(isBotBlockStatus(403)).toBe(true);
    expect(isBotBlockStatus(429)).toBe(true);
    expect(isBotBlockStatus(404)).toBe(false);
    expect(isBotBlockStatus(200)).toBe(false);
  });
});

// ── Block diagnosis: who refused the crawler ────────────────────────────────

/** Minimal case-insensitive Headers stand-in. */
function hdrs(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("  5 ", now)).toBe(5);
  });
  it("parses an HTTP-date into seconds from now", () => {
    expect(parseRetryAfter("Thu, 30 Jul 2026 12:00:30 GMT", now)).toBe(30);
  });
  it("clamps a past HTTP-date to 0 rather than going negative", () => {
    expect(parseRetryAfter("Thu, 30 Jul 2026 11:59:00 GMT", now)).toBe(0);
  });
  it("returns null for a missing or unparsable value", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

describe("diagnoseBlock", () => {
  it("returns null for a status that isn't a block", () => {
    expect(diagnoseBlock(200, hdrs({}), null)).toBeNull();
    expect(diagnoseBlock(404, hdrs({}), null)).toBeNull();
  });

  it("names a Cloudflare challenge from cf-mitigated (owner resolved separately)", () => {
    expect(diagnoseBlock(403, hdrs({ "cf-mitigated": "challenge", "cf-ray": "abc" }), null)?.source).toBe(
      "cloudflare_challenge",
    );
  });

  it("does NOT blame Cloudflare on cf-ray alone — Shopify itself sits behind Cloudflare", () => {
    const d = diagnoseBlock(429, hdrs({ "cf-ray": "abc", server: "cloudflare", "x-shopid": "123" }), null);
    expect(d?.source).toBe("shopify_rate_limit");
  });

  it("recognises the headers current Shopify storefronts actually send", () => {
    // Regression: the original list only had x-shopid / x-sorting-hat-*, which
    // live storefronts no longer send — so every block fell through to
    // Cloudflare and merchants were told to open a dashboard they don't have.
    expect(diagnoseBlock(429, hdrs({ "x-dc": "gcp-europe-west1" }), null)?.source).toBe("shopify_rate_limit");
    expect(diagnoseBlock(403, hdrs({ "shopify-complexity-score": "926" }), null)?.source).toBe(
      "shopify_security",
    );
  });

  it("lets Shopify origin markers win over a Cloudflare signal — the request reached the origin", () => {
    const d = diagnoseBlock(403, hdrs({ "cf-mitigated": "challenge", "x-dc": "gcp-europe-west1" }), null);
    expect(d?.source).toBe("shopify_security");
  });

  it("distinguishes Shopify's rate limit (429) from its bot protection (403)", () => {
    expect(diagnoseBlock(429, hdrs({ "x-sorting-hat-shopid": "9" }), null)?.source).toBe("shopify_rate_limit");
    expect(diagnoseBlock(403, hdrs({ "x-storefront-renderer-rendered": "1" }), null)?.source).toBe(
      "shopify_security",
    );
  });

  it("detects a Cloudflare block page from the body when no Shopify markers are present", () => {
    const body = "<html><head><title>Attention Required! | Cloudflare</title></head></html>";
    expect(diagnoseBlock(403, hdrs({ "cf-ray": "abc" }), body)?.source).toBe("cloudflare_waf");
  });

  it("falls back to plain rate_limit when only Retry-After identifies the response", () => {
    const d = diagnoseBlock(429, hdrs({ "retry-after": "30", server: "nginx" }), null);
    expect(d?.source).toBe("rate_limit");
    expect(d?.retryAfterSec).toBe(30);
    expect(d?.server).toBe("nginx");
  });

  it("reports unknown when nothing identifies the blocker", () => {
    expect(diagnoseBlock(403, hdrs({}), null)?.source).toBe("unknown");
  });
});

describe("detectMerchantCloudflare / attributeBlockSource", () => {
  it("recognises a merchant-owned Cloudflare from the nameservers", async () => {
    const ns = async () => ["kim.ns.cloudflare.com", "walt.ns.cloudflare.com"];
    expect(await detectMerchantCloudflare("shop.example.com", ns)).toBe(true);
  });

  it("reports false for a Shopify store on ordinary nameservers", async () => {
    // The real patis-universe.com case: Cloudflare answers the request, but it
    // is Shopify's Cloudflare — the merchant has no dashboard to configure.
    const ns = async () => ["ns-cloud-a1.googledomains.com", "ns-cloud-a2.googledomains.com"];
    expect(await detectMerchantCloudflare("patis-universe.com", ns)).toBe(false);
  });

  it("walks up to the registrable domain when the subdomain has no NS records", async () => {
    const seen: string[] = [];
    const ns = async (host: string) => {
      seen.push(host);
      if (host !== "example.com") throw new Error("NODATA");
      return ["kim.ns.cloudflare.com"];
    };
    expect(await detectMerchantCloudflare("shop.eu.example.com", ns)).toBe(true);
    expect(seen).toEqual(["shop.eu.example.com", "eu.example.com", "example.com"]);
  });

  it("returns null when the lookup fails, never a confident answer", async () => {
    const ns = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await detectMerchantCloudflare("example.com", ns)).toBeNull();
  });

  it("gives up on a stalled resolver instead of hanging the crawl", async () => {
    // Regression: this lookup runs after the progress heartbeat has stopped,
    // so an unbounded resolver stall showed up as a frozen crawl.
    const started = Date.now();
    const ns = () => new Promise<string[]>(() => {}); // never settles
    expect(await detectMerchantCloudflare("shop.example.com", ns, 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("attributes a Cloudflare verdict by ownership", () => {
    expect(attributeBlockSource("cloudflare_challenge", true)).toBe("cloudflare_challenge");
    expect(attributeBlockSource("cloudflare_challenge", false)).toBe("shopify_security");
    expect(attributeBlockSource("cloudflare_waf", false)).toBe("shopify_security");
    expect(attributeBlockSource("cloudflare_challenge", null)).toBe("cloudflare_unattributed");
  });

  it("leaves non-Cloudflare verdicts untouched", () => {
    expect(attributeBlockSource("shopify_rate_limit", true)).toBe("shopify_rate_limit");
    expect(attributeBlockSource("rate_limit", null)).toBe("rate_limit");
    expect(attributeBlockSource("unknown", false)).toBe("unknown");
  });
});

describe("adaptive request spacing", () => {
  it("escalates toward the ceiling and saturates there", () => {
    let s = BASE_SPACING_MS;
    for (let i = 0; i < 10; i++) s = escalateSpacingMs(s);
    // Regression guard: unbounded growth would throttle the crawl to a halt.
    expect(s).toBe(MAX_SPACING_MS);
    expect(escalateSpacingMs(s)).toBe(MAX_SPACING_MS);
  });

  it("actually widens the spacing on the way up", () => {
    expect(escalateSpacingMs(BASE_SPACING_MS)).toBeGreaterThan(BASE_SPACING_MS);
    expect(escalateSpacingMs(BASE_SPACING_MS)).toBeLessThanOrEqual(MAX_SPACING_MS);
  });

  it("decays back to the base floor after a clean streak", () => {
    // Regression: the backoff had no decay, so one early 429 burst left every
    // remaining request spaced out for the whole run — the crawl looked hung.
    let s = MAX_SPACING_MS;
    for (let i = 0; i < 10; i++) s = decaySpacingMs(s);
    expect(s).toBe(BASE_SPACING_MS);
    expect(decaySpacingMs(s)).toBe(BASE_SPACING_MS);
  });

  it("keeps the crawler gentle by default — the storefront edge counts per IP", () => {
    // Shopify's protection tripped after ~12 requests from one address, so the
    // defaults must stay conservative.
    expect(BASE_SPACING_MS).toBeGreaterThanOrEqual(500);
  });

  it("keeps the decay threshold small enough to recover within a normal crawl", () => {
    expect(SPACING_DECAY_AFTER_OK).toBeLessThanOrEqual(50);
  });
});

describe("rateLimitRetryDelayMs", () => {
  it("uses the default backoff when no Retry-After was sent", () => {
    expect(rateLimitRetryDelayMs(null)).toBe(2000);
    expect(rateLimitRetryDelayMs({ source: "rate_limit", retryAfterSec: null, server: null })).toBe(2000);
  });
  it("honours a short Retry-After", () => {
    expect(rateLimitRetryDelayMs({ source: "rate_limit", retryAfterSec: 3, server: null })).toBe(3000);
  });
  it("gives up instead of waiting out a long Retry-After", () => {
    expect(rateLimitRetryDelayMs({ source: "rate_limit", retryAfterSec: 300, server: null })).toBeNull();
    // The wait holds a concurrency slot, so the cap has to stay tight —
    // 5 slots × a long wait idles the crawler completely.
    expect(rateLimitRetryDelayMs({ source: "rate_limit", retryAfterSec: 10, server: null })).toBeNull();
    expect(rateLimitRetryDelayMs({ source: "rate_limit", retryAfterSec: 5, server: null })).toBe(5000);
  });
});

describe("coolDownDurationMs", () => {
  it("falls back to the base cool-down when the host asked for nothing", () => {
    expect(coolDownDurationMs(BLOCK_COOLDOWN_MS, null)).toBe(BLOCK_COOLDOWN_MS);
    expect(coolDownDurationMs(BLOCK_COOLDOWN_MS, 0)).toBe(BLOCK_COOLDOWN_MS);
  });

  it("waits out a Retry-After the per-request retry had to give up on", () => {
    // The whole point: pausing 60s when the host said 120 walks straight back
    // into the same 429 and burns a cool-down for nothing.
    expect(coolDownDurationMs(BLOCK_COOLDOWN_MS, 120)).toBe(120_000);
  });

  it("never lets a Retry-After shorten the base cool-down", () => {
    expect(coolDownDurationMs(BLOCK_COOLDOWN_MS, 5)).toBe(BLOCK_COOLDOWN_MS);
  });

  it("caps an absurd Retry-After — that is a new crawl, not a pause", () => {
    expect(coolDownDurationMs(BLOCK_COOLDOWN_MS, 3600)).toBe(MAX_COOLDOWN_MS);
  });

  it("keeps the worst case inside the stuck-task threshold", () => {
    // task-recovery.service.js reaps a seoCrawl task after 45 min without a
    // heartbeat; the cool-downs must not add up to anywhere near that.
    expect(MAX_COOLDOWN_MS * 3).toBeLessThan(45 * 60_000);
  });
});

describe("dominantBlockSource / parseCrawlError", () => {
  it("picks the most frequent blocker", () => {
    const counts = new Map<any, number>([
      ["rate_limit", 1],
      ["shopify_rate_limit", 4],
      ["unknown", 2],
    ]);
    expect(dominantBlockSource(counts)).toBe("shopify_rate_limit");
  });
  it("returns null for an empty tally", () => {
    expect(dominantBlockSource(new Map())).toBeNull();
  });
  it("round-trips the attributed error code", () => {
    expect(parseCrawlError("bot_blocked:cloudflare_waf")).toEqual({
      code: "bot_blocked",
      blockedBy: "cloudflare_waf",
    });
  });
  it("still parses a legacy error written before attribution existed", () => {
    expect(parseCrawlError("bot_blocked")).toEqual({ code: "bot_blocked", blockedBy: null });
    expect(parseCrawlError("storefront_password").code).toBe("storefront_password");
    expect(parseCrawlError(null)).toEqual({ code: null, blockedBy: null });
  });
});

// ── Head-drift normalization (§3.1) ─────────────────────────────────────────

describe("normalizeHeadTitle", () => {
  it("strips a trailing '– ShopName' suffix", () => {
    expect(normalizeHeadTitle("Blue Shoe – Acme Shop", "Acme Shop")).toBe("blue shoe");
  });
  it("strips a trailing '- ShopName' (hyphen) suffix", () => {
    expect(normalizeHeadTitle("Blue Shoe - Acme Shop", "Acme Shop")).toBe("blue shoe");
  });
  it("strips a trailing '| ShopName' suffix", () => {
    expect(normalizeHeadTitle("Blue Shoe | Acme Shop", "Acme Shop")).toBe("blue shoe");
  });
  it("collapses/whitespace-normalizes both sides the same way", () => {
    expect(normalizeHeadTitle("  Blue   Shoe  ", "Acme")).toBe("blue shoe");
  });
  it("decodes umlaut HTML entities before comparing", () => {
    expect(normalizeHeadTitle("Bl&auml;ue Sch&uuml;he", "Acme")).toBe(normalizeHeadTitle("Bläue Schühe", "Acme"));
    expect(normalizeHeadTitle("Gr&ouml;&szlig;e M", "Acme")).toBe("größe m");
  });
  it("two titles that only differ by suffix/whitespace/entities normalize equal", () => {
    const a = normalizeHeadTitle("Bl&auml;ue Vase  – Acme Shop", "Acme Shop");
    const b = normalizeHeadTitle("Bläue Vase - Acme Shop", "Acme Shop");
    expect(a).toBe(b);
  });
  it("a real difference still differs after normalization", () => {
    expect(normalizeHeadTitle("Blue Shoe – Acme Shop", "Acme Shop")).not.toBe(
      normalizeHeadTitle("Red Shoe – Acme Shop", "Acme Shop"),
    );
  });
  it("handles an empty/missing title", () => {
    expect(normalizeHeadTitle(null, "Acme")).toBe("");
    expect(normalizeHeadTitle("", "Acme")).toBe("");
  });
  it("handles an empty shop name (no suffix stripped)", () => {
    expect(normalizeHeadTitle("Blue Shoe", "")).toBe("blue shoe");
  });
});

// ── decodeHtmlEntities (out-of-range numeric entity guard) ─────────────────

describe("decodeHtmlEntities", () => {
  it("does not throw on an out-of-range hex numeric entity (> 0x10FFFF)", () => {
    expect(() => decodeHtmlEntities("Title &#x110000; here")).not.toThrow();
    expect(decodeHtmlEntities("Title &#x110000; here")).toBe("Title &#x110000; here");
  });

  it("does not throw on an out-of-range decimal numeric entity", () => {
    expect(() => decodeHtmlEntities("Title &#9999999999; here")).not.toThrow();
    expect(decodeHtmlEntities("Title &#9999999999; here")).toBe("Title &#9999999999; here");
  });

  it("does not throw on a surrogate-range numeric entity", () => {
    expect(() => decodeHtmlEntities("Title &#xD800; here")).not.toThrow();
    expect(decodeHtmlEntities("Title &#xD800; here")).toBe("Title &#xD800; here");
  });

  it("still decodes an in-range numeric entity normally", () => {
    expect(decodeHtmlEntities("Caf&#233;")).toBe("Café");
  });

  it("normalizeHeadTitle does not throw on a title with an out-of-range entity", () => {
    expect(() => normalizeHeadTitle("Broken &#x110000; Title", "Shop")).not.toThrow();
  });
});

// ── groupDuplicateTitles (§3.1) ─────────────────────────────────────────────

describe("groupDuplicateTitles", () => {
  it("groups >=2 URLs sharing a normalized title", () => {
    const groups = groupDuplicateTitles(
      [
        { url: "/a", title: "Same Title – Shop" },
        { url: "/b", title: "Same Title - Shop" },
        { url: "/c", title: "Different" },
      ],
      "Shop",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].urls.sort()).toEqual(["/a", "/b"]);
  });
  it("does not report a unique title as a group", () => {
    const groups = groupDuplicateTitles([{ url: "/a", title: "Only one" }], "Shop");
    expect(groups).toHaveLength(0);
  });
  it("ignores pages with no title", () => {
    const groups = groupDuplicateTitles(
      [
        { url: "/a", title: null },
        { url: "/b", title: null },
      ],
      "Shop",
    );
    expect(groups).toHaveLength(0);
  });
});

// ── robots.txt matching (§3.3) ──────────────────────────────────────────────

describe("isAllowedByRobots", () => {
  const UA = "ContentPilotSEO/1.0 (+https://app.example.com/bot)";

  it("allows everything when there are no groups at all", () => {
    expect(isAllowedByRobots(parseRobots(""), "/products/foo", UA)).toBe(true);
  });

  it("blocks a path disallowed under the wildcard group", () => {
    const groups = parseRobots("User-agent: *\nDisallow: /admin\n");
    expect(isAllowedByRobots(groups, "/admin/orders", UA)).toBe(false);
    expect(isAllowedByRobots(groups, "/products/foo", UA)).toBe(true);
  });

  it("a crawler-specific group takes precedence over the wildcard", () => {
    const groups = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: contentpilotseo\nAllow: /\n",
    );
    expect(isAllowedByRobots(groups, "/products/foo", UA)).toBe(true);
  });

  it("longest-prefix match wins (a more specific Allow overrides a shorter Disallow)", () => {
    const groups = parseRobots("User-agent: *\nDisallow: /products\nAllow: /products/featured\n");
    expect(isAllowedByRobots(groups, "/products/featured/x", UA)).toBe(true);
    expect(isAllowedByRobots(groups, "/products/other", UA)).toBe(false);
  });

  it("an empty Disallow value means allow-all (no-op rule)", () => {
    const groups = parseRobots("User-agent: *\nDisallow:\n");
    expect(isAllowedByRobots(groups, "/anything", UA)).toBe(true);
  });

  it("falls back to the wildcard group when no crawler-specific group matches", () => {
    const groups = parseRobots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n");
    expect(isAllowedByRobots(groups, "/private/x", UA)).toBe(false);
    expect(isAllowedByRobots(groups, "/public", UA)).toBe(true);
  });
});

describe("extractJsonLdTypes", () => {
  const load = (html: string) => cheerio.load(html);
  const script = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it("reads the top-level @type of every block", () => {
    const $ = load(
      script('{"@context":"https://schema.org","@type":"Organization","name":"Acme"}') +
        script('{"@type":"Product","name":"Shoe"}'),
    );
    expect(extractJsonLdTypes($)).toEqual(["Organization", "Product"]);
  });

  it("keeps repeats — two Product blocks is the duplicate-markup signal", () => {
    const $ = load(script('{"@type":"Product"}') + script('{"@type":"Product"}'));
    expect(extractJsonLdTypes($)).toEqual(["Product", "Product"]);
  });

  it("follows @graph, the shape Shopify's own filter emits", () => {
    const $ = load(
      script('{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization"}]}'),
    );
    expect(extractJsonLdTypes($)).toEqual(["WebSite", "Organization"]);
  });

  it("handles a top-level array and a multi-typed node", () => {
    const $ = load(script('[{"@type":"BreadcrumbList"},{"@type":["Product","Thing"]}]'));
    expect(extractJsonLdTypes($)).toEqual(["BreadcrumbList", "Product", "Thing"]);
  });

  it("does NOT descend into nested nodes", () => {
    // An Offer inside a Product is part of that node, not markup of its own —
    // counting it would make every coverage number meaningless.
    const $ = load(
      script('{"@type":"Product","offers":{"@type":"Offer","price":"9.99"},"brand":{"@type":"Brand"}}'),
    );
    expect(extractJsonLdTypes($)).toEqual(["Product"]);
  });

  it("skips unparseable and empty blocks without throwing", () => {
    const $ = load(script("{not json") + script("") + script('{"@type":"Product"}'));
    expect(extractJsonLdTypes($)).toEqual(["Product"]);
  });

  it("separates this app's own blocks from everyone else's", () => {
    const $ = load(
      '<script type="application/ld+json">{"@type":"Product"}</script>' +
        '<script type="application/ld+json" data-contentpilot="product">{"@type":"Product"}</script>' +
        '<script type="application/ld+json" data-contentpilot="organization">{"@type":"Organization"}</script>',
    );
    expect(extractJsonLdTypes($)).toEqual(["Product", "Product", "Organization"]);
    expect(extractAppJsonLdTypes($)).toEqual(["Product", "Organization"]);
  });

  it("reports no app blocks when nothing carries the marker", () => {
    const $ = load(script('{"@type":"Product"}'));
    expect(extractAppJsonLdTypes($)).toEqual([]);
  });

  it("ignores scripts that are not ld+json", () => {
    const $ = load('<script type="application/json">{"@type":"Product"}</script><script>var x=1;</script>');
    expect(extractJsonLdTypes($)).toEqual([]);
  });
});

// ── PLAN_SEO_CRAWL_EXPANSION §2.2 / §2.3 — indexability + on-page capture ───

describe("extractMetaRobots", () => {
  const load = (html: string) => cheerio.load(html);

  it("reads the generic robots tag", () => {
    expect(extractMetaRobots(load('<meta name="robots" content="noindex, nofollow">'))).toBe(
      "noindex, nofollow",
    );
  });

  it("matches the name attribute case-insensitively", () => {
    expect(extractMetaRobots(load('<meta name="ROBOTS" content="noindex">'))).toBe("noindex");
  });

  it("appends a googlebot-specific tag instead of dropping it — it overrides the generic one for Google", () => {
    const $ = load('<meta name="robots" content="index"><meta name="googlebot" content="noindex">');
    expect(extractMetaRobots($)).toBe("index,noindex");
  });

  it("returns '' when nothing was served — which is NOT the same as 'indexable'", () => {
    expect(extractMetaRobots(load("<p>no meta here</p>"))).toBe("");
  });
});

describe("countImagesWithoutAlt", () => {
  it('counts alt="" and a missing alt the same — both are "without alt text"', () => {
    const $ = cheerio.load(
      '<img src="a.jpg" alt="A cat"><img src="b.jpg" alt=""><img src="c.jpg"><img src="d.jpg" alt="   ">',
    );
    expect(countImagesWithoutAlt($)).toEqual({ imgCount: 4, imgMissingAlt: 3 });
  });

  it("is zero on a page without images", () => {
    expect(countImagesWithoutAlt(cheerio.load("<p>text</p>"))).toEqual({ imgCount: 0, imgMissingAlt: 0 });
  });
});

// ── msw-mocked end-to-end crawl (§9 integration) ────────────────────────────

const HOST = "shop-fixture.example.com";
const BASE = `https://${HOST}`;

function html(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

/** msw v2's HttpResponse has no `.redirect()` helper — build the 3xx + Location
 *  response manually so `fetch(..., { redirect: "manual" })` sees it as-is. */
function redirectTo(url: string, status = 301): HttpResponse<any> {
  return new HttpResponse(null, { status, headers: { Location: url } });
}

describe("runCrawl — end-to-end against an msw-mocked fixture site", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  function makeDb(overrides: { products?: { id: string; handle: string }[] } = {}) {
    const products = overrides.products ?? [];
    const created: { pages: any[]; brokenLinks: any[]; externalLinks: any[] } = {
      pages: [],
      brokenLinks: [],
      externalLinks: [],
    };
    return {
      __created: created,
      product: {
        // Serves both callers: resolvePathsToResources (url-resolver.server.ts,
        // `where.handle.in`) and computeHeadDrift (crawl.service.ts, `where.id.in`).
        findMany: async ({ where }: any) => {
          if (where.handle) return products.filter((p) => where.handle.in.includes(p.handle));
          if (where.id) return products.filter((p) => where.id.in.includes(p.id));
          return [];
        },
      },
      collection: { findMany: async () => [] },
      page: { findMany: async () => [] },
      article: { findMany: async () => [] },
      seoCrawlPage: {
        createMany: async ({ data }: any) => {
          created.pages.push(...data);
          return { count: data.length };
        },
      },
      seoCrawlBrokenLink: {
        createMany: async ({ data }: any) => {
          created.brokenLinks.push(...data);
          return { count: data.length };
        },
      },
      // PLAN_SEO_CRAWL_EXPANSION §6 — written by the external-link pass.
      seoCrawlExternalLink: {
        createMany: async ({ data }: any) => {
          created.externalLinks.push(...data);
          return { count: data.length };
        },
      },
    } as any;
  }

  it("crawls a small site: finds a broken link, follows a redirect chain, and respects robots.txt", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () =>
        HttpResponse.text("User-agent: *\nDisallow: /secret\n"),
      ),
      http.get(`${BASE}/sitemap.xml`, () =>
        HttpResponse.xml(
          `<?xml version="1.0"?><urlset><url><loc>${BASE}/</loc></url><url><loc>${BASE}/products/blue-shoe</loc></url></urlset>`,
        ),
      ),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html(
            "Home – Acme",
            `<a href="/products/blue-shoe">Blue Shoe</a> <a href="/products/broken-link">Missing</a> <a href="/old-page">Old page</a> <a href="/secret">Secret</a>`,
          ),
        ),
      ),
      http.get(`${BASE}/products/blue-shoe`, () =>
        HttpResponse.html(html("Blue Shoe – Acme", `<h1>Blue Shoe</h1><p>${"word ".repeat(20)}</p>`)),
      ),
      http.get(`${BASE}/products/broken-link`, () => HttpResponse.text("Not found", { status: 404 })),
      // Redirect chain: /old-page -> /old-page-2 -> /new-page (2 hops, within the 3-hop budget)
      http.get(`${BASE}/old-page`, () => redirectTo(`${BASE}/old-page-2`)),
      http.get(`${BASE}/old-page-2`, () => redirectTo(`${BASE}/new-page`)),
      http.get(`${BASE}/new-page`, () => HttpResponse.html(html("New Page – Acme", "<p>hi</p>"))),
      http.get(`${BASE}/secret`, () => HttpResponse.html(html("Secret – Acme", "<p>hidden</p>"))),
    );

    const db = makeDb({ products: [{ id: "gid://shopify/Product/1", handle: "blue-shoe" }] });

    const summary = await runCrawl("snap-1", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("completed");
    expect(summary.pagesBroken).toBeGreaterThanOrEqual(1);

    // robots.txt Disallow: /secret must have kept us from ever fetching it.
    const crawledUrls = db.__created.pages.map((p: any) => p.url);
    expect(crawledUrls.some((u: string) => u.includes("/secret"))).toBe(false);

    // The broken link was discovered and recorded.
    expect(db.__created.brokenLinks.length).toBeGreaterThanOrEqual(1);
    expect(db.__created.brokenLinks[0].toUrl).toContain("/products/broken-link");
    expect(db.__created.brokenLinks[0].statusCode).toBe(404);

    // The redirect chain (2 hops <= the 3-hop budget) resolved to /new-page —
    // recorded as `redirectedTo` on the originally-linked /old-page row, with
    // the FINAL page's content (title), not as a second, separately-crawled URL.
    const oldPage = db.__created.pages.find((p: any) => p.url.endsWith("/old-page"));
    expect(oldPage?.redirectedTo).toContain("/new-page");
    expect(oldPage?.title).toContain("New Page");

    // The resolvable product page got its DB id attached.
    const blueShoePage = db.__created.pages.find((p: any) => p.url.includes("/products/blue-shoe"));
    expect(blueShoePage?.resourceType).toBe("product");
    expect(blueShoePage?.resourceId).toBe("gid://shopify/Product/1");
  });

  it("persists the JSON-LD types each page served", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html(
            "Home – Acme",
            `<script type="application/ld+json">{"@type":"Organization"}</script>
             <a href="/products/blue-shoe">Blue Shoe</a>`,
          ),
        ),
      ),
      http.get(`${BASE}/products/blue-shoe`, () =>
        HttpResponse.html(
          html(
            "Blue Shoe – Acme",
            `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer"}}</script>
             <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`,
          ),
        ),
      ),
    );

    const db = makeDb();
    await runCrawl("snap-jsonld", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    const product = db.__created.pages.find((p: any) => p.url.includes("/products/blue-shoe"));
    // Nested Offer must NOT be recorded — only the two top-level blocks.
    expect(product?.jsonLdTypes).toBe("Product,BreadcrumbList");
    // Neither block carries our marker, so none is attributed to this app.
    expect(product?.jsonLdAppTypes).toBe("");
    const home = db.__created.pages.find((p: any) => p.url.endsWith("/"));
    expect(home?.jsonLdTypes).toBe("Organization");
  });

  it("expands a sitemap INDEX into pages instead of crawling the sub-sitemaps as pages", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      // Shopify's /sitemap.xml is always an index. Collecting every <loc>
      // seeded these XML files as if they were pages: nothing was discovered
      // from them (no <a href>), and the 404 one was reported as a broken page
      // of the shop.
      http.get(`${BASE}/sitemap.xml`, () =>
        HttpResponse.xml(
          `<?xml version="1.0"?><sitemapindex>
             <sitemap><loc>${BASE}/sitemap_products_1.xml</loc></sitemap>
             <sitemap><loc>${BASE}/en/sitemap_collections_1.xml</loc></sitemap>
           </sitemapindex>`,
        ),
      ),
      http.get(`${BASE}/sitemap_products_1.xml`, () =>
        HttpResponse.xml(
          `<?xml version="1.0"?><urlset><url><loc>${BASE}/products/only-in-sitemap</loc></url></urlset>`,
        ),
      ),
      // The locale-prefixed sub-sitemap the index advertises but the storefront
      // does not serve — the exact 404 that showed up as a "broken page".
      http.get(`${BASE}/en/sitemap_collections_1.xml`, () =>
        HttpResponse.text("Not found", { status: 404 }),
      ),
      // The home page links to nothing, so the sitemap seed is the ONLY way
      // /products/only-in-sitemap can be found.
      http.get(`${BASE}/`, () => HttpResponse.html(html("Home – Acme", "<p>hi</p>"))),
      http.get(`${BASE}/products/only-in-sitemap`, () =>
        HttpResponse.html(html("Only in sitemap – Acme", "<h1>Only in sitemap</h1>")),
      ),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-sitemap-index", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("completed");

    const crawledUrls = db.__created.pages.map((p: any) => p.url);
    // The page listed in the sub-sitemap was seeded and crawled…
    expect(crawledUrls).toContain(`${BASE}/products/only-in-sitemap`);
    // …and no sitemap file became a page row of its own.
    expect(crawledUrls.some((u: string) => u.endsWith(".xml"))).toBe(false);
    // The 404 sub-sitemap must not be reported as a broken page of the shop.
    expect(summary.pagesBroken).toBe(0);
  });

  it("detects a password-redirect on the root seed and aborts with storefront_password", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () => redirectTo(`${BASE}/password`, 302)),
      http.get(`${BASE}/password`, () => HttpResponse.html(html("Password – Acme", "<p>enter password</p>"))),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-2", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("storefront_password");
  });

  /** Enough blocked links to exhaust every cool-down and reach the abort. */
  const BLOCKED_PATHS = Array.from({ length: 20 }, (_, i) => `b${i}`);
  /** The in-service threshold isn't exported; 3 is its documented value and
   *  this assertion only needs "more than one run of blocks was tolerated". */
  const BOT_BLOCK_THRESHOLD_FOR_TEST = 3;

  it("exhausts its cool-downs against a persistent bot shield, then aborts with bot_blocked", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", BLOCKED_PATHS.map((p) => `<a href="/${p}">${p}</a>`).join(""))),
      ),
      // Every response blocked (not mixed with an "ok"): completion order isn't
      // guaranteed to match discovery order, so mixing in a 200 would make the
      // "N CONSECUTIVE" threshold non-deterministic. retry-after: 0 keeps the
      // single 429 retry from adding real wall-clock time.
      ...BLOCKED_PATHS.map((p, i) =>
        http.get(`${BASE}/${p}`, () =>
          i % 2 === 0
            ? new HttpResponse("blocked", { status: 403 })
            : new HttpResponse("blocked", { status: 429, headers: { "retry-after": "0" } }),
        ),
      ),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-3", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      coolDownMs: 5,
    });

    expect(summary.status).toBe("failed");
    expect(parseCrawlError(summary.error ?? null).code).toBe("bot_blocked");
    // msw sends no identifying headers, so the blocker stays unattributed.
    expect(summary.blockedBy).toBe("unknown");
    // It must have paused and retried rather than giving up on the first run
    // of blocks — the shield lapses on its own, so aborting immediately loses
    // crawls that a pause would have rescued.
    expect(summary.pagesBlocked).toBeGreaterThan(BOT_BLOCK_THRESHOLD_FOR_TEST);

    // The firewall-refused pages must NOT be reported as broken links — that
    // was the false-positive report merchants saw behind a Cloudflare-style
    // bot shield.
    expect(summary.pagesBroken).toBe(0);
    expect(summary.pagesBlocked).toBeGreaterThanOrEqual(1);
    expect(db.__created.brokenLinks).toHaveLength(0);
  });

  it("survives a burst of blocks by cooling down, and finishes the crawl", async () => {
    // The real failure this models: Shopify's storefront shield trips after a
    // handful of requests from one IP, then lapses. Aborting on the first run
    // of blocks threw away crawls that a short pause would have completed.
    // Budget the shield by PAGE, not by request: a 429 costs two server hits
    // because `fetchWithRetry` retries it once. Counting requests here meant
    // only two pages were ever blocked, `consecutiveBlocked` peaked at 2, and
    // this test passed without executing a single line of the cool-down branch.
    const blockedPaths = new Set(BLOCKED_PATHS.slice(0, BOT_BLOCK_THRESHOLD_FOR_TEST + 1));
    let coolDownObserved = false;
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", BLOCKED_PATHS.map((p) => `<a href="/${p}">${p}</a>`).join(""))),
      ),
      ...BLOCKED_PATHS.map((p) =>
        http.get(`${BASE}/${p}`, () => {
          // The shield covers the first few pages, then lapses — the real
          // behaviour a cool-down is meant to ride out.
          if (blockedPaths.has(p)) {
            return new HttpResponse("Verifying your connection...", {
              status: 429,
              headers: { "retry-after": "0", "cf-mitigated": "challenge" },
            });
          }
          coolDownObserved = true; // reached only after the blocked run
          return HttpResponse.html(html(`${p} – Acme`, `<h1>${p}</h1><p>hello</p>`));
        }),
      ),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-cooldown", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      coolDownMs: 5,
    });

    expect(summary.status).toBe("completed");
    expect(summary.error).toBeUndefined();
    // The blocked run must have been long enough to actually enter the
    // cool-down branch, otherwise this test proves nothing about it.
    expect(summary.pagesBlocked).toBeGreaterThanOrEqual(BOT_BLOCK_THRESHOLD_FOR_TEST);
    expect(coolDownObserved).toBe(true);
    // The pages that were blocked early are still counted as blocked, but the
    // rest of the site got crawled instead of the whole run being discarded.
    expect(summary.pagesBlocked).toBeGreaterThan(0);
    expect(summary.pagesOk).toBeGreaterThan(summary.pagesBlocked);
    // "Verifying your connection" is Shopify's interstitial, not a merchant's
    // Cloudflare rule — no DNS lookup needed to tell them apart.
    expect(summary.blockedBy).toBe("shopify_security");
  });

  it("stops promptly on abort instead of draining the queue at the throttled rate", async () => {
    // Regression: the abort check lived inside the semaphore callback, so it
    // only ran AFTER the slot and the spacing floor had been waited out. Every
    // URL discovered before the abort — up to the 2000-page cap — still had to
    // trickle through as a no-op at the spacing the last cool-down had just
    // pinned to its maximum, adding tens of minutes of silence with no
    // heartbeat. This is the one test that uses a real spacing floor.
    const MANY = Array.from({ length: 60 }, (_, i) => `q${i}`);
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", MANY.map((p) => `<a href="/${p}">${p}</a>`).join(""))),
      ),
      // 403 rather than 429: never retried, so each page costs exactly one hit.
      ...MANY.map((p) => http.get(`${BASE}/${p}`, () => new HttpResponse("blocked", { status: 403 }))),
    );

    const db = makeDb();
    const started = Date.now();
    const summary = await runCrawl("snap-abort-drain", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      coolDownMs: 1,
      spacingMs: 100,
    });
    const elapsed = Date.now() - started;

    expect(summary.status).toBe("failed");
    expect(parseCrawlError(summary.error ?? null).code).toBe("bot_blocked");
    // ~12 blocked pages reach the abort (~1.2s at the 100ms floor). The ~48
    // still queued must NOT each cost another 100ms — that alone would be
    // ~4.8s on top.
    expect(elapsed).toBeLessThan(3000);
    expect(summary.pagesCrawled).toBeLessThan(MANY.length);
  });

  it("attributes a Cloudflare challenge to Shopify when the domain isn't on Cloudflare nameservers", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", BLOCKED_PATHS.map((p) => `<a href="/${p}">${p}</a>`).join(""))),
      ),
      ...BLOCKED_PATHS.map((p) =>
        http.get(
          `${BASE}/${p}`,
          () => new HttpResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
        ),
      ),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-attr", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      coolDownMs: 5,
      // Google Cloud DNS, like the real store that surfaced this: Cloudflare
      // answered, but it is Shopify's Cloudflare, not the merchant's.
      resolveNsImpl: async () => ["ns-cloud-a1.googledomains.com"],
    });

    expect(summary.status).toBe("failed");
    expect(summary.blockedBy).toBe("shopify_security");
    expect(summary.error).toBe("bot_blocked:shopify_security");
    expect(parseCrawlError(summary.error ?? null)).toEqual({
      code: "bot_blocked",
      blockedBy: "shopify_security",
    });
  });

  it("keeps the Cloudflare attribution when the merchant really is on Cloudflare", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", BLOCKED_PATHS.map((p) => `<a href="/${p}">${p}</a>`).join(""))),
      ),
      ...BLOCKED_PATHS.map((p) =>
        http.get(
          `${BASE}/${p}`,
          () => new HttpResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
        ),
      ),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-attr-cf", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      coolDownMs: 5,
      resolveNsImpl: async () => ["kim.ns.cloudflare.com", "walt.ns.cloudflare.com"],
    });

    expect(summary.blockedBy).toBe("cloudflare_challenge");
    expect(summary.error).toBe("bot_blocked:cloudflare_challenge");
  });

  it("reports a 5xx page as a server error, separate from broken links", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () =>
        // Sitemap-only: nothing links to /orphan-500, so an edge-based report
        // could never surface it.
        HttpResponse.xml(
          `<?xml version="1.0"?><urlset><url><loc>${BASE}/</loc></url><url><loc>${BASE}/orphan-500</loc></url></urlset>`,
        ),
      ),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", `<a href="/gone">Gone</a><a href="/boom">Boom</a>`)),
      ),
      http.get(`${BASE}/gone`, () => new HttpResponse("not found", { status: 404 })),
      http.get(`${BASE}/boom`, () => new HttpResponse("kaboom", { status: 500 })),
      http.get(`${BASE}/orphan-500`, () => new HttpResponse("kaboom", { status: 503 })),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-5xx", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("completed");
    expect(summary.pagesServerError).toBe(2); // /boom + /orphan-500
    expect(summary.pagesBroken).toBe(1); // only the 404

    // Only the 404 becomes a broken-link row; the 500 is the page's own
    // failure, reported per page rather than per link.
    expect(db.__created.brokenLinks).toHaveLength(1);
    expect(db.__created.brokenLinks[0].toUrl).toContain("/gone");

    // Both failing pages are persisted, including the one nothing links to.
    const boom = db.__created.pages.find((p: any) => p.url.includes("/boom"));
    const orphan = db.__created.pages.find((p: any) => p.url.includes("/orphan-500"));
    expect(boom?.statusCode).toBe(500);
    expect(orphan?.statusCode).toBe(503);
  });

  it("counts a single 403/429 target as blocked, not as a broken link", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", `<a href="/rate-limited">Limited</a><a href="/gone">Gone</a>`)),
      ),
      http.get(
        `${BASE}/rate-limited`,
        () => new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } }),
      ),
      http.get(`${BASE}/gone`, () => new HttpResponse("not found", { status: 404 })),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-blocked", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    // Below the 3-consecutive threshold, so the crawl completes normally.
    expect(summary.status).toBe("completed");
    expect(summary.pagesBlocked).toBe(1);
    expect(summary.pagesBroken).toBe(1);

    // Only the genuine 404 became a broken-link row.
    expect(db.__created.brokenLinks).toHaveLength(1);
    expect(db.__created.brokenLinks[0].toUrl).toContain("/gone");
    expect(db.__created.brokenLinks[0].statusCode).toBe(404);

    // The blocked page is still recorded as a crawled page, with its status.
    const limited = db.__created.pages.find((p: any) => p.url.includes("/rate-limited"));
    expect(limited?.statusCode).toBe(429);
  });

  it("retries a 429 once (honouring Retry-After) and keeps the page when the retry succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () => HttpResponse.html(html("Home", `<a href="/flaky">Flaky</a>`))),
      http.get(`${BASE}/flaky`, () => {
        attempts += 1;
        // Rate-limited on the first hit, fine on the retry — the common shape
        // of "our crawl was briefly too fast", not "this page is unreachable".
        if (attempts === 1) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.html(html("Flaky – Acme", "<h1>Flaky</h1><p>hello</p>"));
      }),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-retry", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(attempts).toBe(2);
    expect(summary.status).toBe("completed");
    expect(summary.pagesBlocked).toBe(0);
    expect(summary.pagesBroken).toBe(0);

    const flaky = db.__created.pages.find((p: any) => p.url.includes("/flaky"));
    expect(flaky?.statusCode).toBe(200);
    expect(flaky?.title).toContain("Flaky");
  });

  it("does not follow a redirect to a cross-origin or private/link-local host (redirect-SSRF guard)", async () => {
    let externalFetchCount = 0;
    let metadataFetchCount = 0;
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html("Home", `<a href="/go-external">External</a> <a href="/go-metadata">Metadata</a>`),
        ),
      ),
      // 301s to an arbitrary external host and to the cloud metadata IP.
      http.get(`${BASE}/go-external`, () => redirectTo("http://evil.example.com/")),
      http.get(`${BASE}/go-metadata`, () => redirectTo("http://169.254.169.254/")),
      // If the crawler ever fetches these (it must not), count it.
      http.get("http://evil.example.com/", () => {
        externalFetchCount += 1;
        return HttpResponse.html(html("Evil", "<p>evil</p>"));
      }),
      http.get("http://169.254.169.254/", () => {
        metadataFetchCount += 1;
        return HttpResponse.html(html("Metadata", "<p>metadata</p>"));
      }),
    );

    const db = makeDb();
    const summary = await runCrawl("snap-4", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("completed");

    // Neither cross-origin target was ever fetched.
    expect(externalFetchCount).toBe(0);
    expect(metadataFetchCount).toBe(0);

    // No SeoCrawlPage row exists for either external target — the chain
    // terminated at the redirect, it was not crawled as its own page.
    const crawledUrls = db.__created.pages.map((p: any) => p.url);
    expect(crawledUrls.some((u: string) => u.includes("evil.example.com"))).toBe(false);
    expect(crawledUrls.some((u: string) => u.includes("169.254.169.254"))).toBe(false);

    // The redirect source pages are recorded with the (unfetched) external
    // target as `redirectedTo`, not as a followed/crawled hop.
    const externalPage = db.__created.pages.find((p: any) => p.url.endsWith("/go-external"));
    expect(externalPage?.redirectedTo).toBe("http://evil.example.com/");
    expect(externalPage?.title).toBeNull();

    const metadataPage = db.__created.pages.find((p: any) => p.url.endsWith("/go-metadata"));
    expect(metadataPage?.redirectedTo).toBe("http://169.254.169.254/");
    expect(metadataPage?.title).toBeNull();
  });

  it("excludes a resolved page with a broken (non-2xx) status from head-drift (null title vs DB title is not a real drift)", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(html("Home", `<a href="/products/broken-product">Broken</a>`)),
      ),
      // Resolves to a known product, but 404s — body/title are never parsed.
      http.get(`${BASE}/products/broken-product`, () => HttpResponse.text("Not found", { status: 404 })),
    );

    const db = makeDb({
      products: [{ id: "gid://shopify/Product/9", handle: "broken-product" }],
    });
    // computeHeadDrift's title lookup needs `title`/`seoTitle` too — patch
    // the stub's product.findMany(by id) to return a title that would
    // mismatch the (null) crawled title, so a pre-fix run WOULD have
    // counted this as drift.
    const baseFindMany = db.product.findMany;
    db.product.findMany = async (args: any) => {
      const rows = await baseFindMany(args);
      return rows.map((r: any) => ({ ...r, title: "Broken Product", seoTitle: null }));
    };

    const summary = await runCrawl("snap-5", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    expect(summary.status).toBe("completed");
    expect(summary.headDriftCount).toBe(0);
  });

  // ── PLAN_SEO_CRAWL_EXPANSION §2.1-§2.4 ───────────────────────────────────
  it("captures indexability, on-page and redirect-hop fields per page", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html(
            "Home – Acme",
            `<meta name="robots" content="index,follow">
             <h1>  Welcome   home </h1>
             <img src="a.jpg" alt="A cat"><img src="b.jpg" alt=""><img src="c.jpg">
             <a href="/hidden">Hidden</a>
             <a href="/via-redirect">Via redirect</a>
             <a href="/gone">Gone</a>`,
          ),
        ),
      ),
      // googlebot-specific noindex — the finding the generic tag alone misses.
      http.get(`${BASE}/hidden`, () =>
        HttpResponse.html(
          html("Hidden – Acme", `<meta name="googlebot" content="noindex"><h1>Hidden</h1>`),
        ),
      ),
      // The X-Robots-Tag on the 301 governs the REDIRECT, not the target: only
      // the final response's header may be stored.
      http.get(`${BASE}/via-redirect`, () =>
        new HttpResponse(null, {
          status: 301,
          headers: { Location: `${BASE}/final`, "X-Robots-Tag": "noindex" },
        }),
      ),
      http.get(`${BASE}/final`, () =>
        HttpResponse.html(html("Final – Acme", "<h1>Final</h1>"), {
          headers: { "X-Robots-Tag": "noarchive" },
        }),
      ),
      http.get(`${BASE}/gone`, () => HttpResponse.text("Not found", { status: 404 })),
    );

    const db = makeDb();
    await runCrawl("snap-onpage", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
    });

    const byUrl = (suffix: string) =>
      db.__created.pages.find((p: any) => p.url.endsWith(suffix));

    const home = byUrl("/");
    expect(home.metaRobots).toBe("index,follow");
    expect(home.indexabilityKnown).toBe(true);
    // Whitespace collapsed, so "H1 equals the title" stays comparable.
    expect(home.h1First).toBe("Welcome home");
    // alt="" and a missing alt count the same.
    expect(home.imgCount).toBe(3);
    expect(home.imgMissingAlt).toBe(2);
    expect(home.redirectHops).toBe(0);

    expect(byUrl("/hidden").metaRobots).toBe("noindex");

    const viaRedirect = byUrl("/via-redirect");
    expect(viaRedirect.xRobotsTag).toBe("noarchive"); // NOT the 301's "noindex"
    expect(viaRedirect.redirectHops).toBe(1);

    // No body was ever parsed on a 404 — "is this indexable" has no answer
    // there, and `indexabilityKnown: false` is what says so.
    const gone = byUrl("/gone");
    expect(gone.indexabilityKnown).toBe(false);
    expect(gone.metaRobots).toBe("");
  });
});

describe("runCrawl — external links (PLAN_SEO_CRAWL_EXPANSION §6)", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  function makeDb() {
    const created: { pages: any[]; brokenLinks: any[]; externalLinks: any[] } = {
      pages: [],
      brokenLinks: [],
      externalLinks: [],
    };
    return {
      __created: created,
      product: { findMany: async () => [] },
      collection: { findMany: async () => [] },
      page: { findMany: async () => [] },
      article: { findMany: async () => [] },
      seoCrawlPage: {
        createMany: async ({ data }: any) => {
          created.pages.push(...data);
          return { count: data.length };
        },
      },
      seoCrawlBrokenLink: {
        createMany: async ({ data }: any) => {
          created.brokenLinks.push(...data);
          return { count: data.length };
        },
      },
      seoCrawlExternalLink: {
        createMany: async ({ data }: any) => {
          created.externalLinks.push(...data);
          return { count: data.length };
        },
      },
    } as any;
  }

  const siteWithExternalLinks = () =>
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html(
            "Home – Acme",
            `<a href="https://partner.example/ok">Partner</a>
             <a href="https://partner.example/gone">Dead partner</a>
             <a href="mailto:hi@acme.test">Mail us</a>
             <a href="https://cdn.shopify.com/s/files/1/x.png">Asset</a>
             <a href="/page-2">Internal</a>`,
          ),
        ),
      ),
      // The footer link repeats on every page — it must stay ONE row.
      http.get(`${BASE}/page-2`, () =>
        HttpResponse.html(html("Page 2 – Acme", `<a href="https://partner.example/ok">Partner</a>`)),
      ),
      http.all("https://partner.example/ok", () => new HttpResponse(null, { status: 200 })),
      http.all("https://partner.example/gone", () => new HttpResponse(null, { status: 404 })),
    );

  it("records one row per unique target, counts the pages linking there, and checks it", async () => {
    siteWithExternalLinks();
    const db = makeDb();

    const summary = await runCrawl("snap-ext", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      externalTimeoutMs: 2000,
      // msw intercepts fetch, so `partner.example` never resolves for real and
      // the SSRF guard — which fails closed — would refuse every fixture host.
      externalLookupImpl: async () => ["93.184.216.34"],
    });

    // mailto: and the Shopify CDN asset are not links to check.
    expect(summary.externalFound).toBe(2);
    expect(summary.externalChecked).toBe(2);
    expect(summary.externalBroken).toBe(1);
    expect(summary.externalTruncated).toBe(false);

    const rows = db.__created.externalLinks;
    expect(rows).toHaveLength(2);
    const ok = rows.find((r: any) => r.url.endsWith("/ok"));
    // Linked from both pages, but exactly one row.
    expect(ok.statusCode).toBe(200);
    expect(ok.sourceCount).toBe(2);
    expect(ok.sampleSources.split("\n")).toHaveLength(2);
    expect(rows.find((r: any) => r.url.endsWith("/gone")).statusCode).toBe(404);
  });

  it("collects and checks nothing when the merchant switched the pass off (§6.5)", async () => {
    siteWithExternalLinks();
    const db = makeDb();

    const summary = await runCrawl("snap-ext-off", {
      db,
      shop: "shop.myshopify.com",
      primaryDomain: HOST,
      myshopifyDomain: "shop.myshopify.com",
      shopName: "Acme",
      appUrl: "https://app.example.com",
      maxPages: 100,
      spacingMs: 0,
      checkExternalLinks: false,
    });

    expect(summary.externalFound).toBe(0);
    expect(db.__created.externalLinks).toHaveLength(0);
    // The crawl itself is unaffected.
    expect(summary.status).toBe("completed");
    expect(db.__created.pages.length).toBeGreaterThan(0);
  });
});

describe("pruneOldCrawlSnapshots", () => {
  it("deletes everything beyond the newest `keep` snapshots", async () => {
    const deleted: any[] = [];
    const db = {
      seoCrawlSnapshot: {
        findMany: async () => [{ id: "old-1" }, { id: "old-2" }],
        deleteMany: async (args: any) => {
          deleted.push(args);
          return { count: 2 };
        },
      },
    } as any;
    await pruneOldCrawlSnapshots(db, "shop.myshopify.com", 5);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].where.id.in).toEqual(["old-1", "old-2"]);
  });

  it("does nothing when within the retention limit", async () => {
    let deleteCalled = false;
    const db = {
      seoCrawlSnapshot: {
        findMany: async () => [],
        deleteMany: async () => {
          deleteCalled = true;
          return { count: 0 };
        },
      },
    } as any;
    await pruneOldCrawlSnapshots(db, "shop.myshopify.com", 5);
    expect(deleteCalled).toBe(false);
  });
});

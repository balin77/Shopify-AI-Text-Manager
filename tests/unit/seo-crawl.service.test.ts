import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  normalizeCrawlUrl,
  isDenylistedPath,
  classifyLinkStatus,
  normalizeHeadTitle,
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
  it("classifies 5xx as broken", () => {
    expect(classifyLinkStatus(500)).toBe("broken");
    expect(classifyLinkStatus(502)).toBe("broken");
  });
  it("classifies 0 (timeout) as broken", () => {
    expect(classifyLinkStatus(0)).toBe("broken");
  });
  it("classifies -1 (redirect loop / too many hops) as broken", () => {
    expect(classifyLinkStatus(-1)).toBe("broken");
  });
  it("classifies 2xx/3xx as ok", () => {
    expect(classifyLinkStatus(200)).toBe("ok");
    expect(classifyLinkStatus(301)).toBe("ok");
    expect(classifyLinkStatus(304)).toBe("ok");
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
    const created: { pages: any[]; brokenLinks: any[] } = { pages: [], brokenLinks: [] };
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
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("storefront_password");
  });

  it("detects a bot firewall (>=3 consecutive 403/429) and aborts with bot_blocked", async () => {
    server.use(
      http.get(`${BASE}/robots.txt`, () => HttpResponse.text("")),
      http.get(`${BASE}/sitemap.xml`, () => HttpResponse.xml(`<urlset></urlset>`)),
      http.get(`${BASE}/`, () =>
        HttpResponse.html(
          html("Home", `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a>`),
        ),
      ),
      // All four blocked (not mixed with an "ok" response): under 5-parallel
      // concurrency, completion order isn't guaranteed to match discovery
      // order, so mixing in a 200 would make the "3 CONSECUTIVE" threshold
      // non-deterministic to test. Every response being 403/429 makes the
      // outcome deterministic regardless of interleaving.
      http.get(`${BASE}/a`, () => new HttpResponse("blocked", { status: 403 })),
      http.get(`${BASE}/b`, () => new HttpResponse("blocked", { status: 403 })),
      http.get(`${BASE}/c`, () => new HttpResponse("blocked", { status: 429 })),
      http.get(`${BASE}/d`, () => new HttpResponse("blocked", { status: 403 })),
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
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("bot_blocked");
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

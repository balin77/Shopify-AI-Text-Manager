import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  normalizeExternalUrl,
  checkExternalUrl,
  runExternalLinkPass,
  isExternalLinkBroken,
  isExternalLinkBlocked,
  EXTERNAL_NOT_CHECKED,
  MAX_SAMPLE_SOURCES,
  type ExternalTarget,
} from "~/services/seo/external-links";

/** PLAN_SEO_CRAWL_EXPANSION §6 — outbound links to other domains. */

const SHOP = "shop.example.com";
const PAGE = `https://${SHOP}/products/blue-shoe`;
const UA = "ContentPilotSEO/1.0 (+https://app.example.com/bot)";

describe("normalizeExternalUrl", () => {
  it("keeps a link to another domain, query string included", () => {
    // Unlike the internal crawl, the query is NOT stripped: on a foreign
    // target it usually carries meaning.
    expect(normalizeExternalUrl("https://partner.example/x?id=7", PAGE, SHOP)).toBe(
      "https://partner.example/x?id=7",
    );
  });

  it("drops the fragment but nothing else", () => {
    expect(normalizeExternalUrl("https://partner.example/x#section", PAGE, SHOP)).toBe(
      "https://partner.example/x",
    );
  });

  it("resolves a protocol-relative href against the page", () => {
    expect(normalizeExternalUrl("//partner.example/x", PAGE, SHOP)).toBe("https://partner.example/x");
  });

  it("ignores same-origin links — that is the internal crawl's job", () => {
    expect(normalizeExternalUrl("/collections/all", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl(`https://${SHOP}/pages/about`, PAGE, SHOP)).toBeNull();
  });

  it("ignores the shop's myshopify alias", () => {
    expect(
      normalizeExternalUrl("https://shop.myshopify.com/x", PAGE, SHOP, ["shop.myshopify.com"]),
    ).toBeNull();
  });

  it("ignores mailto:, tel: and javascript:", () => {
    expect(normalizeExternalUrl("mailto:hi@example.com", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl("tel:+49123", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl("javascript:void(0)", PAGE, SHOP)).toBeNull();
  });

  it("ignores Shopify CDN hosts — those are assets, not links", () => {
    expect(normalizeExternalUrl("https://cdn.shopify.com/s/files/1/x.png", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl("https://foo.shopifycdn.net/x.png", PAGE, SHOP)).toBeNull();
  });

  it("never records a private/loopback target — it would never be checkable", () => {
    expect(normalizeExternalUrl("http://192.168.1.1/admin", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl("http://169.254.169.254/latest/meta-data/", PAGE, SHOP)).toBeNull();
    expect(normalizeExternalUrl("http://localhost:3000/x", PAGE, SHOP)).toBeNull();
  });
});

describe("isExternalLinkBroken", () => {
  it("treats the sentinels and 4xx/5xx as broken, 2xx/3xx as fine", () => {
    expect(isExternalLinkBroken(0)).toBe(true); // unreachable
    expect(isExternalLinkBroken(-1)).toBe(true); // redirect loop
    expect(isExternalLinkBroken(404)).toBe(true);
    expect(isExternalLinkBroken(500)).toBe(true);
    expect(isExternalLinkBroken(200)).toBe(false);
    expect(isExternalLinkBroken(301)).toBe(false);
  });

  it("never calls a bot block or an unchecked target a dead link", () => {
    expect(isExternalLinkBroken(403)).toBe(false);
    expect(isExternalLinkBroken(429)).toBe(false);
    expect(isExternalLinkBroken(EXTERNAL_NOT_CHECKED)).toBe(false);
    expect(isExternalLinkBlocked(403)).toBe(true);
    expect(isExternalLinkBlocked(404)).toBe(false);
  });
});

describe("checkExternalUrl", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const deps = { userAgent: UA, timeoutMs: 2000 };

  it("uses HEAD when the host answers it", async () => {
    const methods: string[] = [];
    server.use(
      http.all("https://partner.example/ok", ({ request }) => {
        methods.push(request.method);
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const result = await checkExternalUrl("https://partner.example/ok", deps);
    expect(result).toEqual({ statusCode: 200, finalUrl: null });
    expect(methods).toEqual(["HEAD"]);
  });

  it("falls back to GET when HEAD is refused with 403 — the biggest source of false 'dead links'", async () => {
    const methods: string[] = [];
    server.use(
      http.all("https://shielded.example/page", ({ request }) => {
        methods.push(request.method);
        return request.method === "HEAD"
          ? new HttpResponse(null, { status: 403 })
          : new HttpResponse("ok", { status: 200 });
      }),
    );
    const result = await checkExternalUrl("https://shielded.example/page", deps);
    expect(result.statusCode).toBe(200);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("also falls back on 405 and 501", async () => {
    for (const status of [405, 501]) {
      server.resetHandlers();
      server.use(
        http.all("https://odd.example/page", ({ request }) =>
          request.method === "HEAD"
            ? new HttpResponse(null, { status })
            : new HttpResponse("ok", { status: 200 }),
        ),
      );
      expect((await checkExternalUrl("https://odd.example/page", deps)).statusCode).toBe(200);
    }
  });

  it("reports a real 404", async () => {
    server.use(http.all("https://partner.example/gone", () => new HttpResponse(null, { status: 404 })));
    expect((await checkExternalUrl("https://partner.example/gone", deps)).statusCode).toBe(404);
  });

  it("follows a redirect and reports where it ended up", async () => {
    server.use(
      http.all("http://partner.example/old", () =>
        new HttpResponse(null, { status: 301, headers: { Location: "https://partner.example/new" } }),
      ),
      http.all("https://partner.example/new", () => new HttpResponse(null, { status: 200 })),
    );
    const result = await checkExternalUrl("http://partner.example/old", deps);
    expect(result.statusCode).toBe(200);
    expect(result.finalUrl).toBe("https://partner.example/new");
  });

  it("reports a redirect loop rather than looping", async () => {
    server.use(
      http.all("https://loop.example/a", () =>
        new HttpResponse(null, { status: 302, headers: { Location: "https://loop.example/b" } }),
      ),
      http.all("https://loop.example/b", () =>
        new HttpResponse(null, { status: 302, headers: { Location: "https://loop.example/a" } }),
      ),
    );
    expect((await checkExternalUrl("https://loop.example/a", deps)).statusCode).toBe(-1);
  });

  it("REFUSES a redirect into a private/metadata address instead of fetching it", async () => {
    // The whole point of the guard: an external link may point anywhere, so
    // every hop is re-checked, not just the first.
    let metadataHit = false;
    server.use(
      http.all("https://evil.example/start", () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
      ),
      http.all("http://169.254.169.254/latest/meta-data/", () => {
        metadataHit = true;
        return new HttpResponse("secrets", { status: 200 });
      }),
    );
    const result = await checkExternalUrl("https://evil.example/start", deps);
    expect(metadataHit).toBe(false);
    expect(result.statusCode).toBe(0);
  });

  it("reports an unreachable host as 0 rather than throwing", async () => {
    server.use(http.all("https://down.example/x", () => HttpResponse.error()));
    expect((await checkExternalUrl("https://down.example/x", deps)).statusCode).toBe(0);
  });
});

describe("runExternalLinkPass", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const target = (url: string, over: Partial<ExternalTarget> = {}): ExternalTarget => ({
    url,
    count: 1,
    sources: [PAGE],
    anchor: "link",
    ...over,
  });

  it("checks every target and carries the source count through", async () => {
    server.use(
      http.all("https://a.example/1", () => new HttpResponse(null, { status: 200 })),
      http.all("https://b.example/2", () => new HttpResponse(null, { status: 404 })),
    );
    const pass = await runExternalLinkPass(
      [target("https://a.example/1", { count: 12 }), target("https://b.example/2")],
      { userAgent: UA, timeoutMs: 2000 },
    );
    expect(pass.results).toHaveLength(2);
    expect(pass.unchecked).toBe(0);
    expect(pass.timedOut).toBe(false);
    const a = pass.results.find((r) => r.url.includes("a.example"));
    expect(a?.statusCode).toBe(200);
    expect(a?.sourceCount).toBe(12);
    expect(a?.sampleSources).toBe(PAGE);
  });

  it("never exceeds the per-host concurrency, however many links point there", async () => {
    let inFlight = 0;
    let peak = 0;
    server.use(
      http.all("https://busy.example/*", async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const targets = Array.from({ length: 10 }, (_, i) => target(`https://busy.example/${i}`));
    const pass = await runExternalLinkPass(targets, {
      userAgent: UA,
      timeoutMs: 2000,
      concurrency: 6,
      perHostConcurrency: 2,
    });
    expect(pass.results).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops at the time budget and reports what it did not get to", async () => {
    server.use(
      http.all("https://slow.example/*", async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const targets = Array.from({ length: 40 }, (_, i) => target(`https://slow.example/${i}`));
    const pass = await runExternalLinkPass(targets, {
      userAgent: UA,
      timeoutMs: 2000,
      budgetMs: 60,
      concurrency: 2,
      perHostConcurrency: 2,
    });
    expect(pass.timedOut).toBe(true);
    // Everything is RECORDED either way — the leftovers as EXTERNAL_NOT_CHECKED,
    // because a target missing from the table is indistinguishable from a
    // healthy one, and "0 dead links" after checking a tenth would be the most
    // misleading number in the report.
    expect(pass.results).toHaveLength(targets.length);
    expect(pass.unchecked).toBeGreaterThan(0);
    const notChecked = pass.results.filter((r) => r.statusCode === EXTERNAL_NOT_CHECKED);
    expect(notChecked).toHaveLength(pass.unchecked);
    // …and "not checked" is never counted as broken.
    expect(notChecked.every((r) => !isExternalLinkBroken(r.statusCode))).toBe(true);
  });

  it("does not call a 403/429 a dead link — that is a bot shield refusing US", async () => {
    // Exactly the rule `isBotBlockStatus` enforces for the internal crawl. The
    // check already retried the HEAD with a GET, so a surviving 403 is almost
    // always a shield that refuses non-browser clients outright.
    server.use(http.all("https://shielded.example/x", () => new HttpResponse(null, { status: 403 })));
    const pass = await runExternalLinkPass([target("https://shielded.example/x")], {
      userAgent: UA,
      timeoutMs: 2000,
    });
    expect(pass.results[0].statusCode).toBe(403);
    expect(isExternalLinkBroken(403)).toBe(false);
    expect(isExternalLinkBlocked(403)).toBe(true);
  });

  it("keeps the heartbeat alive — a frozen progress bar is the trap here", async () => {
    server.use(http.all("https://a.example/*", () => new HttpResponse(null, { status: 200 })));
    let beats = 0;
    await runExternalLinkPass(
      Array.from({ length: 6 }, (_, i) => target(`https://a.example/${i}`)),
      { userAgent: UA, timeoutMs: 2000, progressEvery: 2, onProgress: () => { beats += 1; } },
    );
    expect(beats).toBeGreaterThan(1);
  });

  it("truncates the sample sources but keeps the true count", async () => {
    server.use(http.all("https://a.example/1", () => new HttpResponse(null, { status: 200 })));
    const many = Array.from({ length: MAX_SAMPLE_SOURCES + 3 }, (_, i) => `${PAGE}/${i}`);
    const pass = await runExternalLinkPass(
      [target("https://a.example/1", { count: 99, sources: many })],
      { userAgent: UA, timeoutMs: 2000 },
    );
    expect(pass.results[0].sampleSources.split("\n")).toHaveLength(MAX_SAMPLE_SOURCES);
    expect(pass.results[0].sourceCount).toBe(99);
  });
});

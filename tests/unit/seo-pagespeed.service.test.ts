import { describe, it, expect, vi } from "vitest";
import {
  isAllowedAuditUrl,
  parsePageSpeedResponse,
  runPageSpeedAudit,
  countPageSpeedRunsToday,
  PageSpeedDailyLimitError,
} from "~/services/seo/pagespeed.service";
import { getDailyPageSpeedRunsLimit } from "~/utils/planUtils";
import { mockPsiResponse } from "../mocks/pagespeed-psi-response.mock";

/**
 * PSI v5 response parsing (Performance section, SEO tab) — pure/offline. No
 * network access: mockPsiResponse is a trimmed-but-realistic fixture (see
 * tests/mocks/pagespeed-psi-response.mock.ts) covering the performance
 * category score, the 5 metric audits, full-page-screenshot with a nodes map,
 * an LCP element audit, a layout-shift audit, an image opportunity with lhId
 * node refs, and loadingExperience field data.
 */

describe("parsePageSpeedResponse", () => {
  it("rounds the performance score from the 0..1 category score", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "2026-07-21T00:00:00.000Z");
    expect(r.performanceScore).toBe(67);
  });

  it("carries url/strategy/fetchedAt through untouched", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "desktop", "2026-07-21T00:00:00.000Z");
    expect(r.url).toBe("https://example.com/");
    expect(r.strategy).toBe("desktop");
    expect(r.fetchedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("extracts all five metrics with id/displayValue/numericValue/score", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "2026-07-21T00:00:00.000Z");
    expect(r.metrics).toHaveLength(5);
    const byId = Object.fromEntries(r.metrics.map((m) => [m.id, m]));
    expect(byId.lcp).toEqual({ id: "lcp", displayValue: "2.4 s", numericValue: 2400, score: 0.55 });
    expect(byId.cls).toEqual({ id: "cls", displayValue: "0.08", numericValue: 0.08, score: 0.82 });
    expect(byId.tbt.numericValue).toBe(230);
    expect(byId.fcp.numericValue).toBe(1100);
    expect(byId.si.numericValue).toBe(2900);
  });

  it("skips metric audits missing from the response", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.audits["speed-index"];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.metrics.map((m) => m.id)).toEqual(["lcp", "cls", "tbt", "fcp"]);
  });

  it("builds the full-page screenshot from the full-page-screenshot audit", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    expect(r.screenshot).toEqual({
      data: "data:image/webp;base64,AAAA",
      width: 1350,
      height: 8200,
      fullPage: true,
    });
  });

  it("reads the full-page screenshot from the modern top-level lighthouseResult.fullPageScreenshot", () => {
    // Lighthouse >= 10 (what PSI runs today) moved it out of `audits`.
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.fullPageScreenshot = raw.lighthouseResult.audits["full-page-screenshot"].details;
    delete raw.lighthouseResult.audits["full-page-screenshot"];

    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.screenshot?.fullPage).toBe(true);
    // Nodes map came along, so rects still resolve — that's what the element
    // thumbnails in the findings list are cropped from.
    expect(r.annotations.find((a) => a.kind === "lcp")?.rect).toEqual({
      left: 20,
      top: 100,
      width: 680,
      height: 400,
    });
  });

  it("normalizes an opportunity details table incl. node rects, sub-items and metric labels", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");

    const images = r.opportunities.find((o) => o.id === "modern-image-formats");
    expect(images?.displayValue).toBe("Potential savings of 125 KiB");
    expect(images?.metricLabels).toEqual(["LCP", "FCP"]);
    expect(images?.table?.columns.map((c) => c.type)).toEqual(["node", "url", "bytes", "bytes"]);
    const cells = images?.table?.rows[0].cells;
    expect(cells?.[0]?.node?.rect).toEqual({ left: 40, top: 1200, width: 400, height: 200 });
    expect(cells?.[1]).toEqual({ type: "url", text: "https://example.com/product.png" });
    expect(cells?.[2]).toEqual({ type: "bytes", value: 200_000 });

    const blocking = r.opportunities.find((o) => o.id === "render-blocking-resources");
    expect(blocking?.table?.rows[0].subRows?.[0].cells[0]).toEqual({
      type: "url",
      text: "https://example.com/assets/base.css",
    });
  });

  it("leaves the table off findings whose details carry no headings", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.audits["modern-image-formats"].details.headings;
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.opportunities.find((o) => o.id === "modern-image-formats")?.table).toBeUndefined();
  });

  it("resolves annotation rects via the nodes map by lhId, and skips zero-size rects", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");

    const lcp = r.annotations.find((a) => a.kind === "lcp");
    expect(lcp?.rect).toEqual({ left: 20, top: 100, width: 680, height: 400 });
    // 80 chars + the truncation ellipsis character.
    expect(lcp?.label.length).toBeLessThanOrEqual(81);

    const cls = r.annotations.find((a) => a.kind === "cls");
    expect(cls?.rect).toEqual({ left: 20, top: 900, width: 280, height: 50 });
    expect(cls?.detail).toBe("0.043");

    const image = r.annotations.find((a) => a.kind === "image");
    expect(image?.rect).toEqual({ left: 40, top: 1200, width: 400, height: 200 });
    expect(image?.detail).toBe("125 KB"); // 128000 / 1024 rounded

    // node "1-4" is zero-size and must never surface as an annotation.
    expect(r.annotations.every((a) => a.rect.width > 0 && a.rect.height > 0)).toBe(true);
  });

  it("links image opportunities to their annotations via annotationIds", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const opp = r.opportunities.find((o) => o.id === "modern-image-formats");
    expect(opp).toBeDefined();
    const imgAnnotationIds = r.annotations.filter((a) => a.kind === "image").map((a) => a.id);
    expect(opp!.annotationIds).toEqual(imgAnnotationIds);

    // lcp/cls annotations are never linked to opportunities.
    const lcpOpp = r.opportunities.find((o) => o.id === "largest-contentful-paint-element");
    expect(lcpOpp).toBeUndefined();
  });

  it("strips markdown links from opportunity descriptions", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const opp = r.opportunities.find((o) => o.id === "modern-image-formats");
    expect(opp?.description).toBe("Learn more at web.dev.");
  });

  it("caps opportunities at 8 and sorts by savingsMs desc (undefined last), excludes passing audits", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    expect(r.opportunities.length).toBeLessThanOrEqual(8);
    // "uses-optimized-images" has score 1 (passing) → excluded.
    expect(r.opportunities.some((o) => o.id === "uses-optimized-images")).toBe(false);
    const ms = r.opportunities.map((o) => o.savingsMs);
    const defined = ms.filter((m): m is number => m !== undefined);
    expect(defined).toEqual([...defined].sort((a, b) => b - a));
  });

  it("maps loadingExperience field data for lcp/cls/inp", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    expect(r.fieldData).toEqual({
      lcp: { percentile: 2600, category: "AVERAGE" },
      cls: { percentile: 9, category: "FAST" },
      inp: { percentile: 210, category: "AVERAGE" },
      originFallback: false,
    });
  });

  it("falls back to originLoadingExperience and sets originFallback", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.loadingExperience;
    raw.originLoadingExperience = {
      metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3000, category: "SLOW" } },
    };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.fieldData).toEqual({
      lcp: { percentile: 3000, category: "SLOW" },
      cls: undefined,
      inp: undefined,
      originFallback: true,
    });
  });

  it("carries the CrUX histogram through as distributions (bar segments in the UI)", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.loadingExperience.metrics.LARGEST_CONTENTFUL_PAINT_MS.distributions = [
      { min: 0, max: 2500, proportion: 0.7 },
      { min: 2500, max: 4000, proportion: 0.2 },
      { min: 4000, proportion: 0.1 },
    ];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.fieldData?.lcp?.distributions).toEqual([
      { min: 0, max: 2500, proportion: 0.7 },
      { min: 2500, max: 4000, proportion: 0.2 },
      { min: 4000, proportion: 0.1 },
    ]);
    // Metrics without a histogram must not grow an empty array — the UI keys
    // its fallback bands off `distributions` being absent.
    expect(r.fieldData?.cls?.distributions).toBeUndefined();
  });

  it("returns null field data when neither loadingExperience source has metrics", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.loadingExperience;
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.fieldData).toBeNull();
  });

  it("falls back to the viewport final-screenshot with no annotations when full-page-screenshot is absent", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.audits["full-page-screenshot"];
    raw.lighthouseResult.audits["final-screenshot"] = {
      id: "final-screenshot",
      details: { data: "data:image/jpeg;base64,BBBB" },
    };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.screenshot).toEqual({ data: "data:image/jpeg;base64,BBBB", width: 0, height: 0, fullPage: false });
    expect(r.annotations).toEqual([]);
  });

  it("degrades gracefully on garbage/empty input — no throw, all nulls/empty arrays", () => {
    expect(() => parsePageSpeedResponse(null, "https://example.com/", "mobile", "now")).not.toThrow();
    expect(() => parsePageSpeedResponse(undefined, "https://example.com/", "mobile", "now")).not.toThrow();
    expect(() => parsePageSpeedResponse("not an object", "https://example.com/", "mobile", "now")).not.toThrow();
    expect(() => parsePageSpeedResponse(42, "https://example.com/", "mobile", "now")).not.toThrow();
    expect(() => parsePageSpeedResponse({ lighthouseResult: { audits: "nope" } }, "https://example.com/", "mobile", "now")).not.toThrow();

    const r = parsePageSpeedResponse({}, "https://example.com/", "mobile", "now");
    expect(r).toEqual({
      url: "https://example.com/",
      strategy: "mobile",
      fetchedAt: "now",
      performanceScore: null,
      metrics: [],
      screenshot: null,
      annotations: [],
      opportunities: [],
      fieldData: null,
      annotationTotal: 0,
      opportunityTotal: 0,
    });
  });

  // ── Fields PSI reports that the UI would otherwise drop ────────────────────

  it("falls back to metricSavings for table-type diagnostics without overallSavingsMs", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["server-response-time"] = {
      id: "server-response-time",
      title: "Reduce initial server response time",
      score: 0.2,
      // Table-type diagnostic: savings live in metricSavings, not in details.
      metricSavings: { FCP: 620, LCP: 840, CLS: 0.01 },
      details: { type: "table", items: [{ url: "https://example.com/" }] },
    };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const found = r.opportunities.find((o) => o.id === "server-response-time");
    // Largest time-based entry wins; the unitless CLS delta must not be used.
    expect(found?.savingsMs).toBe(840);
  });

  it("prefers details.overallSavingsMs over metricSavings when both are present", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["render-blocking-resources"].metricSavings = { LCP: 9999 };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.opportunities.find((o) => o.id === "render-blocking-resources")?.savingsMs).toBe(300);
  });

  it("reports totals so the UI can disclose the opportunity/annotation caps", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    expect(r.opportunityTotal).toBe(r.opportunities.length);
    expect(r.annotationTotal).toBe(r.annotations.length);
  });

  it("counts capped image annotations in annotationTotal but not in the list", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    const nodes = raw.lighthouseResult.audits["full-page-screenshot"].details.nodes;
    const items = [];
    for (let i = 0; i < 8; i += 1) {
      nodes[`img-${i}`] = { top: i * 100, bottom: i * 100 + 50, left: 0, right: 50, width: 50, height: 50 };
      items.push({ url: `https://example.com/${i}.png`, wastedBytes: 1000, node: { lhId: `img-${i}` } });
    }
    raw.lighthouseResult.audits["modern-image-formats"].details.items = items;
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    // 1 LCP + 1 CLS + 5 of 8 images shown; all 8 images counted.
    expect(r.annotations.filter((a) => a.kind === "image")).toHaveLength(5);
    expect(r.annotationTotal).toBe(10);
  });

  it("surfaces a Lighthouse runtimeError but ignores the NO_ERROR all-clear", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.runtimeError = { code: "NO_ERROR" };
    expect(parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now").runtimeError).toBeUndefined();

    raw.lighthouseResult.runtimeError = {
      code: "ERRORED_DOCUMENT_REQUEST",
      message: "Lighthouse was unable to reliably load the page you requested.",
    };
    expect(parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now").runtimeError).toBe(
      "Lighthouse was unable to reliably load the page you requested.",
    );
  });

  it("keeps runWarnings", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.runWarnings = ["The page may not be loading as expected.", "", 42];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.runWarnings).toEqual(["The page may not be loading as expected."]);
  });

  it("reports finalUrl only when the page actually redirected", () => {
    const raw = structuredClone(mockPsiResponse) as any;

    // Same URL, and a bare trailing-slash difference, are not redirects.
    raw.lighthouseResult.finalDisplayedUrl = "https://example.com/";
    expect(parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now").finalUrl).toBeUndefined();
    expect(parsePageSpeedResponse(raw, "https://example.com", "mobile", "now").finalUrl).toBeUndefined();

    raw.lighthouseResult.finalDisplayedUrl = "https://example.com/password";
    expect(parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now").finalUrl).toBe(
      "https://example.com/password",
    );
  });

  it("extracts CrUX FCP, TTFB and the overall Core Web Vitals verdict", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.loadingExperience.overall_category = "SLOW";
    raw.loadingExperience.metrics.FIRST_CONTENTFUL_PAINT_MS = { percentile: 1800, category: "AVERAGE" };
    raw.loadingExperience.metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE = { percentile: 900, category: "SLOW" };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.fieldData?.fcp).toEqual({ percentile: 1800, category: "AVERAGE" });
    expect(r.fieldData?.ttfb).toEqual({ percentile: 900, category: "SLOW" });
    expect(r.fieldData?.overallCategory).toBe("SLOW");
  });

  it("ignores an unknown overall_category value", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.loadingExperience.overall_category = "NONE";
    expect(parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now").fieldData?.overallCategory)
      .toBeUndefined();
  });
});

describe("isAllowedAuditUrl", () => {
  const allowed = ["example.com", "shop.example.com"];

  it("accepts a matching https host", () => {
    expect(isAllowedAuditUrl("https://example.com/products/foo", allowed)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isAllowedAuditUrl("https://EXAMPLE.COM/", allowed)).toBe(true);
    expect(isAllowedAuditUrl("https://example.com/", ["EXAMPLE.COM"])).toBe(true);
  });

  it("rejects http (non-https)", () => {
    expect(isAllowedAuditUrl("http://example.com/", allowed)).toBe(false);
  });

  it("rejects a foreign host", () => {
    expect(isAllowedAuditUrl("https://evil.com/", allowed)).toBe(false);
  });

  it("rejects a subdomain that isn't an exact allowlist match", () => {
    expect(isAllowedAuditUrl("https://other.example.com/", allowed)).toBe(false);
  });

  it("rejects an invalid URL", () => {
    expect(isAllowedAuditUrl("not-a-url", allowed)).toBe(false);
    expect(isAllowedAuditUrl("", allowed)).toBe(false);
  });
});

/**
 * Per-shop daily budget on real PSI runs. `SeoPageSpeedAudit` rows double as
 * the usage counter (a row is written only after a run that reached Google),
 * so these tests drive a stubbed Prisma delegate rather than a counter model.
 */
describe("daily run budget", () => {
  const RESULT_ROW = { createdAt: new Date(), result: { url: "https://example.com/", cached: true } };
  const FREE_LIMIT = getDailyPageSpeedRunsLimit("free");

  function makeDb(overrides: Record<string, any> = {}) {
    return {
      seoPageSpeedAudit: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
        ...overrides,
      },
    };
  }

  it("counts only rows created since midnight UTC", async () => {
    const count = vi.fn().mockResolvedValue(3);
    const db = makeDb({ count });
    await expect(countPageSpeedRunsToday(db, "s.myshopify.com")).resolves.toBe(3);

    const where = count.mock.calls[0][0].where;
    expect(where.shop).toBe("s.myshopify.com");
    const since: Date = where.createdAt.gte;
    expect(since.getUTCHours()).toBe(0);
    expect(since.getUTCMinutes()).toBe(0);
    expect(since.getUTCSeconds()).toBe(0);
    expect(since.getUTCMilliseconds()).toBe(0);
  });

  it("throws PageSpeedDailyLimitError once the budget is used up", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = makeDb({ count: vi.fn().mockResolvedValue(FREE_LIMIT) });

    await expect(
      runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", force: true, plan: "free" }),
    ).rejects.toBeInstanceOf(PageSpeedDailyLimitError);

    // The budget must be refused BEFORE any request reaches Google, otherwise
    // it would not protect the quota it exists to protect.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("serves a fresh cache hit without consuming budget", async () => {
    // Cache hits cost no Google quota, so they must not be counted or refused.
    const count = vi.fn().mockResolvedValue(FREE_LIMIT);
    const db = makeDb({ count, findFirst: vi.fn().mockResolvedValue(RESULT_ROW) });

    const r = await runPageSpeedAudit({
      db,
      shop: "s.myshopify.com",
      url: "https://example.com/",
      strategy: "mobile",
      plan: "free",
    });

    expect((r as any).cached).toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it("scales the budget with the plan — free's ceiling is not pro's", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = makeDb({ count: vi.fn().mockResolvedValue(FREE_LIMIT) });

    // Same usage, higher plan: still under budget, so it proceeds to the fetch
    // (which we let fail — reaching the network at all is what is asserted).
    fetchSpy.mockRejectedValue(new Error("network disabled in tests"));
    await expect(
      runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", force: true, plan: "pro" }),
    ).rejects.not.toBeInstanceOf(PageSpeedDailyLimitError);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("still refuses when the cached row is too old to serve", async () => {
    const stale = { createdAt: new Date(Date.now() - 60 * 60 * 1000), result: {} }; // 1h > 30min TTL
    const db = makeDb({
      count: vi.fn().mockResolvedValue(FREE_LIMIT),
      findFirst: vi.fn().mockResolvedValue(stale),
    });

    await expect(
      runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", plan: "free" }),
    ).rejects.toBeInstanceOf(PageSpeedDailyLimitError);
  });
});

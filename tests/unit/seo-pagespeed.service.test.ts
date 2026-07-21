import { describe, it, expect } from "vitest";
import { isAllowedAuditUrl, parsePageSpeedResponse } from "~/services/seo/pagespeed.service";
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
    });
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

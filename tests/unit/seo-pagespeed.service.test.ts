import { describe, it, expect, vi } from "vitest";
import {
  isAllowedAuditUrl,
  parsePageSpeedResponse,
  runPageSpeedAudit,
  listPageSpeedHistory,
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

  it("collects passed audits, excluding metrics, screenshots and unverified modes", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["uses-text-compression"] = {
      id: "uses-text-compression",
      title: "Enable text compression",
      score: 1,
      displayValue: "0 resources",
    };
    raw.lighthouseResult.audits["no-document-write"] = { id: "no-document-write", title: "Avoids document.write()", score: 1 };
    // Verified nothing → must not be sold as "passed".
    raw.lighthouseResult.audits["viewport"] = {
      id: "viewport",
      title: "Has a viewport meta tag",
      score: 1,
      scoreDisplayMode: "notApplicable",
    };

    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const ids = r.passedAudits?.map((a) => a.id) ?? [];
    expect(ids).toContain("uses-text-compression");
    expect(ids).toContain("no-document-write");
    expect(ids).not.toContain("viewport");
    // uses-optimized-images scores 1 but is a real check — it belongs here.
    expect(ids).toContain("uses-optimized-images");
    // The metric audits are their own section, not checks.
    expect(ids).not.toContain("largest-contentful-paint");
    expect(r.passedAudits?.find((a) => a.id === "uses-text-compression")?.displayValue).toBe("0 resources");
  });

  it("scopes passed audits to the performance category when auditRefs are present", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["uses-text-compression"] = {
      id: "uses-text-compression",
      title: "Enable text compression",
      score: 1,
    };
    // With three requested categories, `audits` also carries passed a11y/bp
    // checks (aria-allowed-attr and deprecations pass in the mock). Once the
    // performance category names its own audits, only those may count as the
    // speed tab's passed checks — the quality tabs own the rest.
    raw.lighthouseResult.categories.performance.auditRefs = [
      { id: "uses-text-compression" },
      { id: "uses-optimized-images" },
    ];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const ids = r.passedAudits?.map((a) => a.id) ?? [];
    expect(ids).toContain("uses-text-compression");
    expect(ids).toContain("uses-optimized-images");
    expect(ids).not.toContain("aria-allowed-attr");
    expect(ids).not.toContain("deprecations");
  });

  it("no longer truncates the findings list", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    for (let i = 0; i < 12; i++) {
      raw.lighthouseResult.audits[`synthetic-${i}`] = {
        id: `synthetic-${i}`,
        title: `Synthetic ${i}`,
        score: 0.2,
        details: { type: "opportunity", overallSavingsMs: 10 + i, items: [{ url: "https://example.com/x" }] },
      };
    }
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.opportunities.length).toBe(r.opportunityTotal);
    expect(r.opportunities.length).toBeGreaterThan(8);
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

  it("sorts opportunities by savingsMs desc (undefined last) and excludes passing audits", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    // "uses-optimized-images" has score 1 (passing) → excluded here, and listed
    // under passedAudits instead.
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
    // It already IS `screenshot` — duplicating it as the preview would double
    // the stored payload for nothing.
    expect(r.previewScreenshot).toBeUndefined();
  });

  it("keeps the viewport shot as previewScreenshot alongside the full-page one", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["final-screenshot"] = {
      id: "final-screenshot",
      details: { data: "data:image/jpeg;base64,BBBB" },
    };
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.screenshot?.fullPage).toBe(true);
    expect(r.previewScreenshot).toEqual({
      data: "data:image/jpeg;base64,BBBB",
      width: 0,
      height: 0,
      fullPage: false,
    });
  });

  it("does not count unrenderable items as hidden table rows", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    // Two extra items whose only keys are unknown to the headings → nothing to
    // render. Reporting them as "2 more rows" would promise data we never had.
    raw.lighthouseResult.audits["render-blocking-resources"].details.items.push({ somethingElse: 1 }, {});
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const table = r.opportunities.find((o) => o.id === "render-blocking-resources")?.table;
    expect(table?.rows).toHaveLength(1);
    expect(table?.rowTotal).toBe(1);
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

  // ── quality (accessibility / best-practices categories) ────────────────────

  it("extracts the a11y and best-practices category scores, rounded to 0-100", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    expect(r.quality?.a11yScore).toBe(82);
    expect(r.quality?.bestPracticesScore).toBe(93);
  });

  it("keeps failing and manual audits, drops passed and notApplicable, manual last", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const a11y = r.quality?.accessibility ?? [];
    expect(a11y.map((i) => i.id)).toEqual(["image-alt", "color-contrast", "focus-traps"]);
    expect(a11y.map((i) => i.manual)).toEqual([false, false, true]);
    // Manual checks are not findings — the total counts failing audits only.
    expect(r.quality?.accessibilityTotal).toBe(2);
    // Passed / notApplicable never surface, in either list.
    const allIds = [...a11y, ...(r.quality?.bestPractices ?? [])].map((i) => i.id);
    expect(allIds).not.toContain("aria-allowed-attr");
    expect(allIds).not.toContain("video-caption");
    expect(allIds).not.toContain("deprecations");
  });

  it("collects the passed checks per quality category, title-only, excluding manual/notApplicable", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    // aria-allowed-attr (score 1) is the only passed a11y audit in the mock;
    // focus-traps (manual) and video-caption (notApplicable) are not "passed".
    expect(r.quality?.accessibilityPassed?.map((a) => a.id)).toEqual(["aria-allowed-attr"]);
    // deprecations (score 1) is the passed best-practices audit; the failing
    // and informative ones stay out of the passed list.
    expect(r.quality?.bestPracticesPassed?.map((a) => a.id)).toEqual(["deprecations"]);
    // Passed checks must never also appear as findings.
    const findingIds = [
      ...(r.quality?.accessibility ?? []),
      ...(r.quality?.bestPractices ?? []),
    ].map((i) => i.id);
    expect(findingIds).not.toContain("aria-allowed-attr");
    expect(findingIds).not.toContain("deprecations");
  });

  it("collects informative advisory checks (gray-circle) and resolves their group heading", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    // csp-xss is informative with NO items → advisory, not a finding.
    const advisory = r.quality?.bestPracticesAdvisory ?? [];
    expect(advisory.map((a) => a.id)).toEqual(["csp-xss"]);
    expect(advisory[0].score).toBeNull();
    expect(advisory[0].group).toBe("Trust and Safety");
    // It must not leak into the findings list.
    expect((r.quality?.bestPractices ?? []).map((i) => i.id)).not.toContain("csp-xss");
    // Findings carry their group heading too (from categoryGroups).
    const errors = r.quality?.bestPractices.find((i) => i.id === "errors-in-console");
    expect(errors?.group).toBe("General");
  });

  it("collects the not-applicable audits per category, title-only", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    // video-caption is notApplicable in the mock's accessibility category.
    expect(r.quality?.accessibilityNotApplicable?.map((a) => a.id)).toEqual(["video-caption"]);
    // It appears in neither findings nor passed.
    expect((r.quality?.accessibility ?? []).map((i) => i.id)).not.toContain("video-caption");
    expect((r.quality?.accessibilityPassed ?? []).map((a) => a.id)).not.toContain("video-caption");
  });

  it("normalizes the failing best-practices finding's details into a table when Lighthouse gives headings", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    // Real PSI ships errors-in-console with headings; the base mock omits them.
    raw.lighthouseResult.audits["errors-in-console"].details.headings = [
      { key: "url", valueType: "url", label: "URL" },
      { key: "description", valueType: "text", label: "Description" },
    ];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const finding = r.quality?.bestPractices.find((i) => i.id === "errors-in-console");
    expect(finding?.table?.columns.map((c) => c.label)).toEqual(["URL", "Description"]);
    expect(finding?.table?.rows).toHaveLength(1);
  });

  it("includes informative audits only when they carry items, and never smooths null scores to 0", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const bp = r.quality?.bestPractices ?? [];
    // Failing scored audit first, informative (score null) after it.
    expect(bp.map((i) => i.id)).toEqual(["errors-in-console", "js-libraries"]);
    expect(bp.find((i) => i.id === "js-libraries")?.score).toBeNull();
    expect(r.quality?.bestPracticesTotal).toBe(2);

    // Same informative audit without items → not a finding.
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["js-libraries"].details.items = [];
    const r2 = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r2.quality?.bestPractices.map((i) => i.id)).toEqual(["errors-in-console"]);
    expect(r2.quality?.bestPracticesTotal).toBe(1);
  });

  it("extracts selector/snippet per affected element and strips markdown links from descriptions", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const imageAlt = r.quality?.accessibility.find((i) => i.id === "image-alt");
    expect(imageAlt?.description).toBe(
      "Informative elements should aim for short, descriptive alternate text. Learn more.",
    );
    expect(imageAlt?.items[0].selector).toBe("img.product-hero");
    expect(imageAlt?.items[0].snippet).toContain("product-hero");
    expect(imageAlt?.itemTotal).toBe(2);
  });

  it("resolves the item url from item.url, falling back to src=… in the snippet (image-alt bridge)", () => {
    const r = parsePageSpeedResponse(mockPsiResponse, "https://example.com/", "mobile", "now");
    const items = r.quality?.accessibility.find((i) => i.id === "image-alt")?.items ?? [];
    // First item has no url of its own → src pulled from the snippet.
    expect(items[0].url).toBe(
      "https://cdn.shopify.com/s/files/1/0001/2345/products/hero_1024x1024.jpg?v=1699999999",
    );
    // Second item carries a direct url, which wins over the snippet.
    expect(items[1].url).toBe("https://cdn.shopify.com/s/files/1/0001/2345/products/badge_600x.png");
  });

  it("truncates long snippets to the cell cap", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    const longSnippet = `<img class="${"x".repeat(300)}">`;
    raw.lighthouseResult.audits["color-contrast"].details.items = [
      { node: { selector: "p", snippet: longSnippet } },
    ];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const snippet = r.quality?.accessibility.find((i) => i.id === "color-contrast")?.items[0].snippet ?? "";
    expect(snippet.length).toBe(161); // 160 chars + ellipsis
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("caps issues at 15 per category and items at 5 per issue, keeping the pre-cap totals", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    for (let i = 0; i < 20; i += 1) {
      const id = `synthetic-a11y-${i}`;
      raw.lighthouseResult.categories.accessibility.auditRefs.push({ id });
      raw.lighthouseResult.audits[id] = {
        id,
        title: `Synthetic ${i}`,
        score: 0,
        scoreDisplayMode: "binary",
        details: { type: "table", items: [] },
      };
    }
    raw.lighthouseResult.audits["image-alt"].details.items = Array.from({ length: 8 }, (_, i) => ({
      node: { selector: `img.n${i}`, snippet: `<img class="n${i}">` },
    }));

    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    // 15 capped findings + the mock's manual audit: manual checks have their
    // own cap and must never be squeezed out by a page with many findings.
    expect(r.quality?.accessibility).toHaveLength(16);
    expect(r.quality?.accessibility.filter((i) => !i.manual)).toHaveLength(15);
    expect(r.quality?.accessibility.some((i) => i.id === "focus-traps")).toBe(true);
    // 2 failing from the base mock + 20 synthetic; manual audits not counted.
    expect(r.quality?.accessibilityTotal).toBe(22);
    const imageAlt = r.quality?.accessibility.find((i) => i.id === "image-alt");
    expect(imageAlt?.items).toHaveLength(5);
    expect(imageAlt?.itemTotal).toBe(8);
  });

  it("prefers src over data-src in lazy-load snippets and drops blank element rows", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.audits["image-alt"].details.items = [
      {
        node: {
          selector: "img.lazy",
          snippet: '<img class="lazy" data-src="https://cdn.shopify.com/s/files/1/1/products/real.jpg" src="https://cdn.shopify.com/s/files/1/1/products/placeholder.gif">',
        },
      },
    ];
    // errors-in-console style rows: description only, nothing renderable.
    raw.lighthouseResult.audits["errors-in-console"].details.items = [
      { description: "TypeError: x is undefined" },
      { url: "https://example.com/app.js", description: "ReferenceError" },
    ];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    const lazy = r.quality?.accessibility.find((i) => i.id === "image-alt")?.items[0];
    expect(lazy?.url).toBe("https://cdn.shopify.com/s/files/1/1/products/placeholder.gif");
    const consoleIssue = r.quality?.bestPractices.find((i) => i.id === "errors-in-console");
    // The description-only row is dropped; the url-carrying row survives and
    // the total counts renderable rows only.
    expect(consoleIssue?.items).toHaveLength(1);
    expect(consoleIssue?.items[0].url).toBe("https://example.com/app.js");
    expect(consoleIssue?.itemTotal).toBe(1);
  });

  it("leaves quality undefined when neither quality category is in the response (legacy runs)", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.categories.accessibility;
    delete raw.lighthouseResult.categories["best-practices"];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.quality).toBeUndefined();
    // Performance parsing is unaffected.
    expect(r.performanceScore).toBe(67);
    expect(r.metrics).toHaveLength(5);
    expect(r.opportunities.length).toBeGreaterThan(0);
  });

  it("keeps quality when only one category is present, with a null score for the other", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.categories["best-practices"];
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.quality?.a11yScore).toBe(82);
    expect(r.quality?.bestPracticesScore).toBeNull();
    expect(r.quality?.bestPractices).toEqual([]);
    expect(r.quality?.bestPracticesTotal).toBe(0);
  });

  it("does not throw on garbage quality shapes", () => {
    const raw = structuredClone(mockPsiResponse) as any;
    raw.lighthouseResult.categories.accessibility = { score: "nope", auditRefs: "garbage" };
    raw.lighthouseResult.categories["best-practices"] = { auditRefs: [{ id: 42 }, null, { id: "js-libraries" }] };
    expect(() => parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now")).not.toThrow();
    const r = parsePageSpeedResponse(raw, "https://example.com/", "mobile", "now");
    expect(r.quality?.a11yScore).toBeNull();
    expect(r.quality?.accessibility).toEqual([]);
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
    const stale = { createdAt: new Date(Date.now() - 60 * 60 * 1000), result: {} }; // 1h, well past the reuse window
    const db = makeDb({
      count: vi.fn().mockResolvedValue(FREE_LIMIT),
      findFirst: vi.fn().mockResolvedValue(stale),
    });

    await expect(
      runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", plan: "free" }),
    ).rejects.toBeInstanceOf(PageSpeedDailyLimitError);
  });

  it("denormalizes a11y/best-practices scores into their own columns on create", async () => {
    const create = vi.fn().mockResolvedValue({});
    const db = makeDb({ create });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => structuredClone(mockPsiResponse),
    } as any);

    await runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", force: true, plan: "free" });

    const data = create.mock.calls[0][0].data;
    expect(data.score).toBe(67);
    expect(data.a11yScore).toBe(82);
    expect(data.bestPracticesScore).toBe(93);
    fetchSpy.mockRestore();
  });

  it("writes null quality columns when the response has no quality categories", async () => {
    const raw = structuredClone(mockPsiResponse) as any;
    delete raw.lighthouseResult.categories.accessibility;
    delete raw.lighthouseResult.categories["best-practices"];
    const create = vi.fn().mockResolvedValue({});
    const db = makeDb({ create });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => raw,
    } as any);

    await runPageSpeedAudit({ db, shop: "s.myshopify.com", url: "https://example.com/", strategy: "mobile", force: true, plan: "free" });

    const data = create.mock.calls[0][0].data;
    expect(data.a11yScore).toBeNull();
    expect(data.bestPracticesScore).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("listPageSpeedHistory", () => {
  it("selects and returns a11yScore, null for rows stored before the column existed", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "new", url: "u", strategy: "mobile", score: 67, a11yScore: 82, createdAt: new Date("2026-07-22T10:00:00Z") },
      { id: "old", url: "u", strategy: "mobile", score: 51, a11yScore: null, createdAt: "2026-07-21T10:00:00Z" },
    ]);
    const db = { seoPageSpeedAudit: { findMany } };

    const entries = await listPageSpeedHistory({ db, shop: "s.myshopify.com" });

    // The column must be selected — otherwise Prisma never returns it.
    expect(findMany.mock.calls[0][0].select.a11yScore).toBe(true);
    expect(entries[0]).toMatchObject({ id: "new", performanceScore: 67, a11yScore: 82 });
    expect(entries[1]).toMatchObject({ id: "old", performanceScore: 51, a11yScore: null });
  });
});

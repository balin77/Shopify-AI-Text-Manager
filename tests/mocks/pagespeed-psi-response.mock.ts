/**
 * Trimmed-but-realistic PageSpeed Insights v5 response fixture, used by
 * pagespeed.service.test.ts to exercise parsePageSpeedResponse without any
 * network access. Shapes mirror the real PSI v5 API (lighthouseResult.audits
 * keyed by audit id, full-page-screenshot nodes map, loadingExperience CrUX
 * data, accessibility/best-practices categories with auditRefs) but only
 * carry the fields the parser reads.
 */

export const mockPsiResponse = {
  lighthouseResult: {
    categories: {
      performance: { score: 0.67 },
      accessibility: {
        score: 0.82,
        auditRefs: [
          { id: "image-alt" },
          { id: "color-contrast" },
          { id: "focus-traps" }, // manual — listed, flagged, not counted
          { id: "aria-allowed-attr" }, // passed — must NOT surface
          { id: "video-caption" }, // notApplicable — must NOT surface
        ],
      },
      "best-practices": {
        score: 0.93,
        auditRefs: [
          { id: "errors-in-console" },
          { id: "js-libraries" }, // informative with items — surfaces
          { id: "deprecations" }, // passed — must NOT surface
        ],
      },
    },
    audits: {
      "largest-contentful-paint": {
        id: "largest-contentful-paint",
        displayValue: "2.4 s",
        numericValue: 2400,
        score: 0.55,
      },
      "cumulative-layout-shift": {
        id: "cumulative-layout-shift",
        displayValue: "0.08",
        numericValue: 0.08,
        score: 0.82,
      },
      "total-blocking-time": {
        id: "total-blocking-time",
        displayValue: "230 ms",
        numericValue: 230,
        score: 0.7,
      },
      "first-contentful-paint": {
        id: "first-contentful-paint",
        displayValue: "1.1 s",
        numericValue: 1100,
        score: 0.9,
      },
      "speed-index": {
        id: "speed-index",
        displayValue: "2.9 s",
        numericValue: 2900,
        score: 0.75,
      },
      "full-page-screenshot": {
        id: "full-page-screenshot",
        details: {
          type: "full-page-screenshot",
          screenshot: {
            data: "data:image/webp;base64,AAAA",
            width: 1350,
            height: 8200,
          },
          nodes: {
            "1-1": { top: 100, bottom: 500, left: 20, right: 700, width: 680, height: 400 },
            "1-2": { top: 900, bottom: 950, left: 20, right: 300, width: 280, height: 50 },
            "1-3": { top: 1200, bottom: 1400, left: 40, right: 440, width: 400, height: 200 },
            "1-4": { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }, // zero-size → must be skipped
          },
        },
      },
      "largest-contentful-paint-element": {
        id: "largest-contentful-paint-element",
        details: {
          type: "table",
          items: [
            {
              node: {
                lhId: "1-1",
                snippet: "<img src=\"hero.jpg\" class=\"hero-image-really-long-class-name-that-should-be-truncated-eventually\">",
                boundingRect: { top: 100, bottom: 500, left: 20, right: 700, width: 680, height: 400 },
              },
            },
          ],
        },
      },
      "layout-shift-elements": {
        id: "layout-shift-elements",
        details: {
          type: "table",
          items: [
            {
              node: { lhId: "1-2", snippet: "<div class=\"banner\">" },
              score: 0.043,
            },
          ],
        },
      },
      "modern-image-formats": {
        id: "modern-image-formats",
        title: "Serve images in next-gen formats",
        description: "Learn more at [web.dev](https://web.dev/uses-webp-images/).",
        score: 0.3,
        displayValue: "Potential savings of 125 KiB",
        metricSavings: { LCP: 450, FCP: 120 },
        details: {
          type: "opportunity",
          overallSavingsMs: 450,
          overallSavingsBytes: 128_000,
          headings: [
            { key: "node", valueType: "node", label: "" },
            { key: "url", valueType: "url", label: "URL" },
            { key: "totalBytes", valueType: "bytes", label: "Transfer size" },
            { key: "wastedBytes", valueType: "bytes", label: "Potential savings" },
          ],
          items: [
            {
              url: "https://example.com/product.png",
              totalBytes: 200_000,
              wastedBytes: 128_000,
              node: { lhId: "1-3", snippet: "<img src=\"product.png\">" },
            },
          ],
        },
      },
      "render-blocking-resources": {
        id: "render-blocking-resources",
        title: "Eliminate render-blocking resources",
        description: "Resources are blocking the first paint.",
        score: 0.4,
        details: {
          type: "opportunity",
          overallSavingsMs: 300,
          headings: [
            { key: "url", valueType: "url", label: "URL", subItemsHeading: { key: "url", valueType: "url" } },
            { key: "totalBytes", valueType: "bytes", label: "Transfer size" },
            { key: "wastedMs", valueType: "timespanMs", label: "Duration" },
          ],
          items: [
            {
              url: "https://example.com/style.css",
              totalBytes: 23_000,
              wastedMs: 480,
              subItems: { type: "subitems", items: [{ url: "https://example.com/assets/base.css" }] },
            },
          ],
        },
      },
      "uses-optimized-images": {
        id: "uses-optimized-images",
        title: "Efficiently encode images",
        score: 1,
        details: { type: "opportunity", items: [] },
      },
      // ── accessibility / best-practices audits (quality categories) ──
      "image-alt": {
        id: "image-alt",
        title: "Image elements do not have [alt] attributes",
        description:
          "Informative elements should aim for short, descriptive alternate text. [Learn more](https://web.dev/image-alt/).",
        score: 0,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: [
            {
              node: {
                selector: "img.product-hero",
                snippet:
                  '<img class="product-hero" src="https://cdn.shopify.com/s/files/1/0001/2345/products/hero_1024x1024.jpg?v=1699999999">',
              },
            },
            {
              url: "https://cdn.shopify.com/s/files/1/0001/2345/products/badge_600x.png",
              node: { selector: "img.badge", snippet: '<img class="badge">' },
            },
          ],
        },
      },
      "color-contrast": {
        id: "color-contrast",
        title: "Background and foreground colors do not have a sufficient contrast ratio.",
        description: "Low-contrast text is difficult to read. [Learn more](https://web.dev/color-contrast/).",
        score: 0,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: [{ node: { selector: "p.subdued", snippet: '<p class="subdued">Fine print</p>' } }],
        },
      },
      "focus-traps": {
        id: "focus-traps",
        title: "User focus is not accidentally trapped in a region",
        description: "A user can tab into and out of any control. [Learn more](https://web.dev/focus-traps/).",
        score: null,
        scoreDisplayMode: "manual",
      },
      "aria-allowed-attr": {
        id: "aria-allowed-attr",
        title: "[aria-*] attributes match their roles",
        score: 1,
        scoreDisplayMode: "binary",
        details: { type: "table", items: [] },
      },
      "video-caption": {
        id: "video-caption",
        title: "<video> elements contain a <track> element with [kind=\"captions\"]",
        score: null,
        scoreDisplayMode: "notApplicable",
      },
      "errors-in-console": {
        id: "errors-in-console",
        title: "Browser errors were logged to the console",
        description: "Errors logged to the console indicate unresolved problems.",
        score: 0,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: [{ description: "Failed to load resource", url: "https://example.com/missing.js" }],
        },
      },
      "js-libraries": {
        id: "js-libraries",
        title: "Detected JavaScript libraries",
        score: null,
        scoreDisplayMode: "informative",
        details: { type: "table", items: [{ name: "jQuery", version: "3.7.1" }] },
      },
      deprecations: {
        id: "deprecations",
        title: "Avoids deprecated APIs",
        score: 1,
        scoreDisplayMode: "binary",
        details: { type: "table", items: [] },
      },
    },
  },
  loadingExperience: {
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2600, category: "AVERAGE" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 9, category: "FAST" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 210, category: "AVERAGE" },
    },
  },
};

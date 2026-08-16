import { describe, it, expect } from "vitest";
import {
  deriveIndexability,
  expectedNoindexReason,
  EXPECTED_NOINDEX_PATTERNS,
  analyzeIndexability,
  analyzeCanonicals,
  analyzeHeadings,
  findMissingMetaDescriptions,
  findImagesWithoutAlt,
  findThinPages,
  snapshotKnowsParseState,
  canonicalHostFromPages,
  THIN_MIN_SAMPLE,
  type OnPageRow,
} from "~/services/seo/onpage.service";
import {
  groupDuplicateValues,
  groupDuplicateTitles,
  normalizeHeadTitle,
  normalizeMetaDescription,
} from "~/services/seo/crawl.service";

/**
 * PLAN_SEO_CRAWL_EXPANSION §3.10. Nearly every rule in the on-page tab is
 * false-positive-prone in a way that only real shop data reveals, so the rules
 * are pure functions and this file is where they get argued out.
 */

const HOST = "shop.example.com";
const BASE = `https://${HOST}`;

function row(overrides: Partial<OnPageRow> & { url: string }): OnPageRow {
  return {
    title: null,
    metaDesc: "a description",
    canonical: null,
    metaRobots: "",
    xRobotsTag: "",
    indexabilityKnown: true,
    h1Count: 1,
    h1First: "Heading",
    wordCount: 500,
    imgCount: 0,
    imgMissingAlt: 0,
    statusCode: 200,
    redirectHops: 0,
    resourceType: "product",
    resourceId: "gid://shopify/Product/1",
    locale: "",
    ...overrides,
  };
}

describe("deriveIndexability", () => {
  const base = { metaRobots: "", xRobotsTag: "", indexabilityKnown: true, statusCode: 200 };

  it("is indexable when nothing says otherwise", () => {
    expect(deriveIndexability(base)).toBe("indexable");
    expect(deriveIndexability({ ...base, metaRobots: "index, follow" })).toBe("indexable");
  });

  it("reads noindex from the meta tag and from the header alike", () => {
    expect(deriveIndexability({ ...base, metaRobots: "noindex" })).toBe("noindex");
    expect(deriveIndexability({ ...base, xRobotsTag: "noindex" })).toBe("noindex");
  });

  it("is case-insensitive", () => {
    expect(deriveIndexability({ ...base, metaRobots: "NOINDEX" })).toBe("noindex");
  });

  it("treats `none` as noindex — it is shorthand for noindex,nofollow", () => {
    expect(deriveIndexability({ ...base, metaRobots: "none" })).toBe("noindex");
  });

  it("catches a googlebot-specific noindex appended to the generic tag", () => {
    // extractMetaRobots stores "index,noindex" for
    // <meta name=robots content=index> + <meta name=googlebot content=noindex>.
    expect(deriveIndexability({ ...base, metaRobots: "index,noindex" })).toBe("noindex");
  });

  it("strips a user-agent prefix in X-Robots-Tag", () => {
    expect(deriveIndexability({ ...base, xRobotsTag: "googlebot: noindex, nosnippet" })).toBe("noindex");
  });

  it("reports nofollow-only separately — the page IS indexable", () => {
    expect(deriveIndexability({ ...base, metaRobots: "nofollow" })).toBe("nofollow_only");
  });

  it("is `unknown` when the crawl never looked — never `indexable`", () => {
    expect(deriveIndexability({ ...base, indexabilityKnown: false })).toBe("unknown");
    expect(deriveIndexability({ ...base, indexabilityKnown: false, metaRobots: "" })).toBe("unknown");
  });

  it("does NOT read `max-image-preview:none` as a noindex", () => {
    // The value-carrying directives are the reason a token cannot simply be
    // "everything after the colon": `none` alone is shorthand for
    // noindex,nofollow, and this page is perfectly indexable.
    expect(
      deriveIndexability({ ...base, metaRobots: "index, follow, max-image-preview:none" }),
    ).toBe("indexable");
    expect(deriveIndexability({ ...base, xRobotsTag: "max-snippet:-1, max-video-preview:0" })).toBe(
      "indexable",
    );
    expect(deriveIndexability({ ...base, metaRobots: "unavailable_after: 2026-01-01" })).toBe(
      "indexable",
    );
  });

  it("still catches a user-agent-prefixed noindex alongside a value directive", () => {
    expect(
      deriveIndexability({ ...base, xRobotsTag: "googlebot: noindex, max-image-preview:large" }),
    ).toBe("noindex");
    expect(
      deriveIndexability({ ...base, xRobotsTag: "googlebot: max-image-preview:none" }),
    ).toBe("indexable");
  });

  it("is `unknown` for a page that did not serve content", () => {
    expect(deriveIndexability({ ...base, statusCode: 404 })).toBe("unknown");
  });
});

describe("EXPECTED_NOINDEX_PATTERNS / expectedNoindexReason", () => {
  it("matches Shopify's own noindex paths", () => {
    expect(expectedNoindexReason(`${BASE}/search`)).toBe("search");
    expect(expectedNoindexReason(`${BASE}/search?q=shoe`)).toBe("search");
    expect(expectedNoindexReason(`${BASE}/policies/agb`)).toBe("policies");
    expect(expectedNoindexReason(`${BASE}/cart`)).toBe("cart");
    expect(expectedNoindexReason(`${BASE}/account/login`)).toBe("account");
    expect(expectedNoindexReason(`${BASE}/collections/x/tagged/y`)).toBe("taggedCollection");
  });

  it("survives a locale prefix", () => {
    expect(expectedNoindexReason(`${BASE}/fr/search`)).toBe("search");
    expect(expectedNoindexReason(`${BASE}/pt-br/policies/x`)).toBe("policies");
  });

  it("does NOT excuse a product reached through a collection URL", () => {
    // The single most valuable finding of the whole tab must not be swallowed
    // by the filtered-collection pattern.
    expect(expectedNoindexReason(`${BASE}/collections/summer/products/blue-shoe`)).toBeNull();
  });

  it("does not excuse an ordinary product or collection", () => {
    expect(expectedNoindexReason(`${BASE}/products/blue-shoe`)).toBeNull();
    expect(expectedNoindexReason(`${BASE}/collections/summer`)).toBeNull();
  });

  it("every pattern carries an id — the reason is what makes the filter defensible", () => {
    expect(EXPECTED_NOINDEX_PATTERNS.every((p) => p.id.length > 0)).toBe(true);
  });
});

describe("analyzeIndexability", () => {
  it("reports a noindex product that is NOT in the sitemap exclusions", () => {
    const report = analyzeIndexability(
      [row({ url: `${BASE}/products/blue-shoe`, metaRobots: "noindex" })],
      new Map(),
    );
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].url).toContain("/products/blue-shoe");
    expect(report.expected).toHaveLength(0);
  });

  it("does NOT report it when an APPLIED sitemap exclusion explains it", () => {
    const report = analyzeIndexability(
      [row({ url: `${BASE}/products/blue-shoe`, metaRobots: "noindex" })],
      new Map([["product:gid://shopify/Product/1", "sitemapExclusion"]]),
    );
    expect(report.problems).toHaveLength(0);
    expect(report.expected).toHaveLength(1);
    expect(report.expected[0].expectedReason).toBe("sitemapExclusion");
  });

  it("lists Shopify's own noindex paths neutrally, not as problems", () => {
    const report = analyzeIndexability(
      [row({ url: `${BASE}/search`, metaRobots: "noindex", resourceType: null, resourceId: null })],
      new Map(),
    );
    expect(report.problems).toHaveLength(0);
    expect(report.expected[0].expectedReason).toBe("search");
  });

  it("marks a locale-prefixed page but does not judge it", () => {
    const report = analyzeIndexability(
      [row({ url: `${BASE}/fr/products/blue-shoe`, metaRobots: "noindex", locale: "fr" })],
      new Map(),
    );
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].localePrefixed).toBe(true);
  });

  it("does not report an UNLISTED product — Shopify itself serves it noindex", () => {
    // Documented by Shopify and measured on a live shop (sitemap.service.ts's
    // header). Without this filter every unlisted product lands at the top of
    // the report and of the SEO dashboard as a critical, unexplained exclusion.
    const report = analyzeIndexability(
      [row({ url: `${BASE}/products/staging-copy`, metaRobots: "noindex,nofollow" })],
      new Map([["product:gid://shopify/Product/1", "unlistedProduct"]]),
    );
    expect(report.problems).toHaveLength(0);
    expect(report.expected[0].expectedReason).toBe("unlistedProduct");
  });

  it("counts unknowns instead of calling them indexable", () => {
    const report = analyzeIndexability(
      [row({ url: `${BASE}/a`, indexabilityKnown: false })],
      new Map(),
    );
    expect(report.problems).toHaveLength(0);
    expect(report.unknownCount).toBe(1);
    expect(report.consideredCount).toBe(1);
  });
});

describe("canonicalHostFromPages", () => {
  it("takes the host from the crawled URLs — never from a lookup that can fail", () => {
    // fetchPrimaryDomain falls back to the myshopify host on a throttled Admin
    // call, and every canonical would then read as "foreign domain", critical,
    // on every page.
    expect(canonicalHostFromPages([row({ url: `${BASE}/a` })])).toBe(HOST);
  });

  it("returns '' when nothing is parsable — the caller must then not judge", () => {
    expect(canonicalHostFromPages([{ url: "not a url" }])).toBe("");
  });
});

describe("analyzeCanonicals", () => {
  it("reports a missing canonical", () => {
    const findings = analyzeCanonicals([row({ url: `${BASE}/a`, canonical: null })], HOST);
    expect(findings.map((f) => f.issue)).toEqual(["missing"]);
  });

  it("does not report a self-referencing canonical, even with a trailing slash", () => {
    const findings = analyzeCanonicals(
      [row({ url: `${BASE}/products/blue-shoe`, canonical: `${BASE}/products/blue-shoe/` })],
      HOST,
    );
    expect(findings).toEqual([]);
  });

  it("does NOT report Shopify's correct /collections/x/products/y → /products/y", () => {
    const findings = analyzeCanonicals(
      [
        row({
          url: `${BASE}/collections/summer/products/blue-shoe`,
          canonical: `${BASE}/products/blue-shoe`,
        }),
        row({ url: `${BASE}/products/blue-shoe`, canonical: `${BASE}/products/blue-shoe` }),
      ],
      HOST,
    );
    expect(findings).toEqual([]);
  });

  it("reports a canonical pointing at a 404", () => {
    const findings = analyzeCanonicals(
      [
        row({ url: `${BASE}/a`, canonical: `${BASE}/gone` }),
        row({ url: `${BASE}/gone`, statusCode: 404, indexabilityKnown: false }),
      ],
      HOST,
    );
    expect(findings.map((f) => f.issue)).toEqual(["targetBroken"]);
  });

  it("reports a canonical pointing at a redirect", () => {
    const findings = analyzeCanonicals(
      [
        row({ url: `${BASE}/a`, canonical: `${BASE}/b` }),
        row({ url: `${BASE}/b`, redirectHops: 1, canonical: `${BASE}/b` }),
      ],
      HOST,
    );
    expect(findings.map((f) => f.issue)).toEqual(["targetRedirects"]);
  });

  it("reports a canonical on a foreign domain", () => {
    const findings = analyzeCanonicals(
      [row({ url: `${BASE}/a`, canonical: "https://other-shop.example/a" })],
      HOST,
    );
    expect(findings.map((f) => f.issue)).toEqual(["crossHost"]);
  });

  it("reports a canonical chain A→B, B→C", () => {
    const findings = analyzeCanonicals(
      [
        row({ url: `${BASE}/a`, canonical: `${BASE}/b` }),
        row({ url: `${BASE}/b`, canonical: `${BASE}/c` }),
        row({ url: `${BASE}/c`, canonical: `${BASE}/c` }),
      ],
      HOST,
    );
    // /a → /b is the chain; /b → /c is a plain non-self canonical whose target
    // is fine, so it is not a second finding.
    expect(findings.map((f) => f.issue)).toEqual(["chain"]);
    expect(findings[0].url).toBe(`${BASE}/a`);
  });

  it("reports a canonical pointing at a noindex page", () => {
    const findings = analyzeCanonicals(
      [
        row({ url: `${BASE}/a`, canonical: `${BASE}/b` }),
        row({ url: `${BASE}/b`, canonical: `${BASE}/b`, metaRobots: "noindex" }),
      ],
      HOST,
    );
    expect(findings.map((f) => f.issue)).toEqual(["targetNoindex"]);
  });

  it("says nothing about a canonical whose target was never crawled", () => {
    const findings = analyzeCanonicals(
      [row({ url: `${BASE}/a`, canonical: `${BASE}/never-crawled` })],
      HOST,
    );
    expect(findings).toEqual([]);
  });

  it("collapses the myshopify alias host instead of calling it cross-host", () => {
    const findings = analyzeCanonicals(
      [row({ url: `${BASE}/a`, canonical: "https://shop.myshopify.com/a" })],
      HOST,
      ["shop.myshopify.com"],
    );
    expect(findings).toEqual([]);
  });

  it("never reports 'missing' for a page whose body was never parsed", () => {
    // A page at the BFS depth limit is fetched but never parsed, so its
    // canonical is null for that reason alone. The OTHER row is what makes
    // this a current snapshot rather than a pre-migration one.
    const findings = analyzeCanonicals(
      [
        row({ url: `${BASE}/deep`, canonical: null, indexabilityKnown: false }),
        row({ url: `${BASE}/b`, canonical: `${BASE}/b` }),
      ],
      HOST,
    );
    expect(findings).toEqual([]);
  });

  it("still judges canonicals on a snapshot that predates the parse flag", () => {
    // `canonical` is a pre-existing column, so gating it on a flag that did
    // not exist yet would make the whole category claim "no problems".
    const findings = analyzeCanonicals(
      [row({ url: `${BASE}/a`, canonical: null, indexabilityKnown: false })],
      HOST,
    );
    expect(findings.map((f) => f.issue)).toEqual(["missing"]);
  });
});

describe("analyzeHeadings / meta / images", () => {
  it("finds missing and multiple H1s", () => {
    const report = analyzeHeadings([
      row({ url: `${BASE}/a`, h1Count: 0, h1First: null }),
      row({ url: `${BASE}/b`, h1Count: 3 }),
      row({ url: `${BASE}/c`, h1Count: 1 }),
    ]);
    expect(report.missing.map((r) => r.url)).toEqual([`${BASE}/a`]);
    expect(report.multiple.map((r) => r.url)).toEqual([`${BASE}/b`]);
    expect(report.multiple[0].detail).toBe("3");
  });

  it("flags H1 == title only on an exact (whitespace/case-normalized) match", () => {
    const report = analyzeHeadings([
      row({ url: `${BASE}/a`, title: "Blue  Shoe", h1First: "blue shoe" }),
      // The normal, desirable shape: the theme appends the shop name.
      row({ url: `${BASE}/b`, title: "Blue Shoe – Acme", h1First: "Blue Shoe" }),
    ]);
    expect(report.sameAsTitle.map((r) => r.url)).toEqual([`${BASE}/a`]);
  });

  it("ignores pages that never served a body", () => {
    const report = analyzeHeadings([
      row({ url: `${BASE}/gone`, statusCode: 404, indexabilityKnown: false, h1Count: 0 }),
    ]);
    expect(report.missing).toEqual([]);
  });

  it("keeps judging h1Count on a pre-migration snapshot, but marks H1==title unknown", () => {
    // h1Count is a pre-existing column and its values are real; h1First is new,
    // so an empty sameAsTitle there means "not measured", not "none match".
    const report = analyzeHeadings([
      row({ url: `${BASE}/a`, h1Count: 0, h1First: null, indexabilityKnown: false }),
    ]);
    expect(report.missing.map((r) => r.url)).toEqual([`${BASE}/a`]);
    expect(report.sameAsTitleKnown).toBe(false);
  });

  it("reports images as measurable only on a snapshot that knows the parse state", () => {
    expect(snapshotKnowsParseState([row({ url: `${BASE}/a`, indexabilityKnown: false })])).toBe(false);
    expect(snapshotKnowsParseState([row({ url: `${BASE}/a` })])).toBe(true);
  });

  it("finds meta descriptions missing from the DELIVERED html", () => {
    const rows = findMissingMetaDescriptions([
      row({ url: `${BASE}/a`, metaDesc: null }),
      row({ url: `${BASE}/b`, metaDesc: "   " }),
      row({ url: `${BASE}/c`, metaDesc: "fine" }),
    ]);
    expect(rows.map((r) => r.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
  });

  it("lists pages with images lacking alt text, worst first", () => {
    const rows = findImagesWithoutAlt([
      row({ url: `${BASE}/a`, imgCount: 10, imgMissingAlt: 2 }),
      row({ url: `${BASE}/b`, imgCount: 10, imgMissingAlt: 7 }),
      row({ url: `${BASE}/c`, imgCount: 10, imgMissingAlt: 0 }),
    ]);
    expect(rows.map((r) => r.url)).toEqual([`${BASE}/b`, `${BASE}/a`]);
    expect(rows[0].detail).toBe("7/10");
  });
});

describe("findThinPages", () => {
  /** `count` pages of `type`, each with the given word count. */
  const many = (type: string, counts: number[]): OnPageRow[] =>
    counts.map((wordCount, i) =>
      row({ url: `${BASE}/${type}/${i}`, resourceType: type, wordCount }),
    );

  it("reports nothing for a type with fewer than the minimum sample — and SAYS so", () => {
    const report = findThinPages(many("product", [10, 500, 600, 700]));
    expect(report.pages).toEqual([]);
    expect(report.skippedTypes).toEqual([{ resourceType: "product", pageCount: 4 }]);
  });

  it("reports only pages below the 10th percentile AND below half the median", () => {
    // 19 pages at ~500 words + one at 20 → the outlier is thin, the rest is not.
    const counts = [...Array(THIN_MIN_SAMPLE - 1).fill(500), 20];
    const report = findThinPages(many("product", counts));
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].wordCount).toBe(20);
    expect(report.pages[0].comparedType).toBe("product");
  });

  it("reports nothing when a shop's texts are uniformly short — that is not a defect", () => {
    const counts = Array(THIN_MIN_SAMPLE + 5).fill(60);
    expect(findThinPages(many("product", counts)).pages).toEqual([]);
  });

  it("compares within a type, not across types", () => {
    // Products average ~500 words, pages ~60. A 60-word PAGE must not be
    // reported just because products are longer.
    const rows = [
      ...many("product", Array(THIN_MIN_SAMPLE).fill(500)),
      ...many("page", Array(THIN_MIN_SAMPLE).fill(60)),
    ];
    expect(findThinPages(rows).pages).toEqual([]);
  });
});

describe("groupDuplicateValues (§3.6)", () => {
  const rows = [
    { url: "/a", title: "Blue Shoe – Acme" },
    { url: "/b", title: "blue shoe" },
    { url: "/c", title: "Red Shoe" },
  ];

  it("is behaviourally identical to groupDuplicateTitles", () => {
    const viaWrapper = groupDuplicateTitles(rows, "Acme");
    const viaGeneric = groupDuplicateValues(
      rows.map((r) => ({ url: r.url, value: r.title })),
      (v) => normalizeHeadTitle(v, "Acme"),
    );
    expect(viaGeneric).toEqual(viaWrapper);
    expect(viaWrapper).toEqual([{ title: "blue shoe", urls: ["/a", "/b"] }]);
  });

  it("groups meta descriptions without stripping a shop-name suffix", () => {
    const groups = groupDuplicateValues(
      [
        { url: "/a", value: "  Great  shoes for everyone " },
        { url: "/b", value: "great shoes for everyone" },
        { url: "/c", value: "Something else" },
      ],
      normalizeMetaDescription,
    );
    expect(groups).toEqual([{ title: "great shoes for everyone", urls: ["/a", "/b"] }]);
  });

  it("skips empty values — 'all these pages have none' is the MISSING category", () => {
    const groups = groupDuplicateValues(
      [
        { url: "/a", value: null },
        { url: "/b", value: "  " },
      ],
      normalizeMetaDescription,
    );
    expect(groups).toEqual([]);
  });
});

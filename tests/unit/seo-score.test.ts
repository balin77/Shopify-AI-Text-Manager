import { describe, it, expect } from "vitest";
import {
  computeSeoScore,
  scoreTone,
  scoreLabelKey,
  progressTone,
  seoTitleEffectiveLimit,
  stripHtml,
  DEFAULT_SEO_TITLE_LIMIT,
} from "~/utils/seo-score";

/**
 * Parity + boundary suite for the extracted score core (Phase 0.3). These lock
 * the weights/thresholds lifted 1:1 from the former SeoSidebar useMemo so the
 * Sidebar and the Audit-Dashboard can never silently drift.
 */

const codes = (input: Parameters<typeof computeSeoScore>[0]) =>
  computeSeoScore(input).findings.map((f) => f.code);

describe("computeSeoScore — headline cases", () => {
  it("scores a fully-optimized product at 100", () => {
    const r = computeSeoScore({
      title: "A".repeat(40),
      description: "D".repeat(200),
      seoTitle: "S".repeat(40),
      metaDescription: "M".repeat(140),
      totalImages: 2,
      imagesWithAlt: 2,
    });
    expect(r.score).toBe(100);
    expect(r.recommendations).toEqual([]);
    expect(r.findings.every((f) => f.severity === "success")).toBe(true);
  });

  it("scores an empty product at 0 (images excluded when none)", () => {
    const r = computeSeoScore({
      title: "",
      description: "",
      seoTitle: "",
      metaDescription: "",
      totalImages: 0,
      imagesWithAlt: 0,
    });
    expect(r.score).toBe(0);
    expect(r.findings.map((f) => f.code)).toEqual([
      "titleTooShort",
      "seoTitleMissing",
      "descriptionMissing",
      "metaDescriptionMissing",
    ]);
    expect(r.recommendations).toEqual([
      "expandTitle",
      "addSeoTitle",
      "expandDescription",
      "addMetaDescription",
      "expandMetaDescription",
    ]);
  });
});

describe("title length boundaries (29/30/70/71)", () => {
  const base = {
    description: "D".repeat(200),
    seoTitle: "S".repeat(40),
    metaDescription: "M".repeat(140),
    totalImages: 0,
    imagesWithAlt: 0,
  };
  it("29 is too short, 30 is good", () => {
    expect(codes({ ...base, title: "A".repeat(29) })[0]).toBe("titleTooShort");
    expect(codes({ ...base, title: "A".repeat(30) })[0]).toBe("titleLengthGood");
  });
  it("70 is good, 71 is too long", () => {
    expect(codes({ ...base, title: "A".repeat(70) })[0]).toBe("titleLengthGood");
    expect(codes({ ...base, title: "A".repeat(71) })[0]).toBe("titleTooLong");
  });
});

describe("SEO title limit honors the suffix-adjusted budget", () => {
  const base = {
    title: "A".repeat(40),
    description: "D".repeat(200),
    metaDescription: "M".repeat(140),
    totalImages: 0,
    imagesWithAlt: 0,
  };
  it("missing → error", () => {
    expect(codes({ ...base, seoTitle: "" })[1]).toBe("seoTitleMissing");
  });
  it("at the effective limit → good, one over → too long", () => {
    const limit = 53; // 60 - 7-char suffix
    expect(
      codes({ ...base, seoTitle: "S".repeat(limit), seoTitleEffectiveLimit: limit })[1],
    ).toBe("seoTitleGood");
    expect(
      codes({ ...base, seoTitle: "S".repeat(limit + 1), seoTitleEffectiveLimit: limit })[1],
    ).toBe("seoTitleTooLong");
  });
  it("defaults to a 60-char budget", () => {
    expect(DEFAULT_SEO_TITLE_LIMIT).toBe(60);
    expect(codes({ ...base, seoTitle: "S".repeat(60) })[1]).toBe("seoTitleGood");
    expect(codes({ ...base, seoTitle: "S".repeat(61) })[1]).toBe("seoTitleTooLong");
  });
});

describe("meta description boundaries (0/119/120/160/161)", () => {
  const base = {
    title: "A".repeat(40),
    description: "D".repeat(200),
    seoTitle: "S".repeat(40),
    totalImages: 0,
    imagesWithAlt: 0,
  };
  const metaCode = (n: number) =>
    computeSeoScore({ ...base, metaDescription: "M".repeat(n) }).findings.find((f) =>
      f.code.startsWith("metaDescription"),
    )!.code;
  it("maps each band", () => {
    expect(metaCode(0)).toBe("metaDescriptionMissing");
    expect(metaCode(119)).toBe("metaDescriptionTooShort");
    expect(metaCode(120)).toBe("metaDescriptionGood");
    expect(metaCode(160)).toBe("metaDescriptionGood");
    expect(metaCode(161)).toBe("metaDescriptionTooLong");
  });
});

describe("image alt coverage", () => {
  const base = {
    title: "A".repeat(40),
    description: "D".repeat(200),
    seoTitle: "S".repeat(40),
    metaDescription: "M".repeat(140),
  };
  it("0-of-0 → image criterion skipped, score over /70", () => {
    const r = computeSeoScore({ ...base, totalImages: 0, imagesWithAlt: 0 });
    // 70/70 applicable points → 100
    expect(r.score).toBe(100);
    expect(r.findings.some((f) => f.code === "allImagesHaveAlt")).toBe(false);
  });
  it("2-of-2 → full 30 points", () => {
    const r = computeSeoScore({ ...base, totalImages: 2, imagesWithAlt: 2 });
    expect(r.score).toBe(100);
    expect(r.findings.find((f) => f.code === "allImagesHaveAlt")?.points).toBe(30);
  });
  it("1-of-2 → half the 30 points, carries the missing count", () => {
    const r = computeSeoScore({ ...base, totalImages: 2, imagesWithAlt: 1 });
    // 15+15+20+20 + round(1/2*30)=15 = 85 of 100
    expect(r.score).toBe(85);
    const f = r.findings.find((x) => x.code === "someImagesMissingAlt")!;
    expect(f.points).toBe(15);
    expect(f.data).toEqual({ count: 1 });
  });
});

describe("exclusions drop the criterion from maxScore", () => {
  it("excludeDescription + excludeImages renormalizes over the remaining 50", () => {
    const r = computeSeoScore({
      title: "A".repeat(40), // 15
      description: "",
      seoTitle: "", // missing → 0 of 15
      metaDescription: "M".repeat(140), // 20
      excludeDescription: true,
      excludeImages: true,
    });
    // applicable max = title15 + seo15 + meta20 = 50; earned 15+0+20 = 35 → 70
    expect(r.score).toBe(70);
    expect(r.findings.some((f) => f.code.startsWith("description"))).toBe(false);
  });
});

describe("seoTitleEffectiveLimit — suffix-adjusted budget with a floor", () => {
  it("returns the default 60 when there is no suffix", () => {
    expect(seoTitleEffectiveLimit(undefined)).toBe(60);
    expect(seoTitleEffectiveLimit(null)).toBe(60);
    expect(seoTitleEffectiveLimit("")).toBe(60);
  });
  it("subtracts the suffix length", () => {
    expect(seoTitleEffectiveLimit(" – Patis Universe")).toBe(60 - " – Patis Universe".length);
  });
  it("floors at 20 instead of going to zero/negative for a long suffix", () => {
    expect(seoTitleEffectiveLimit("A".repeat(60))).toBe(20);
    expect(seoTitleEffectiveLimit("A".repeat(100))).toBe(20);
  });
});

describe("computeSeoScore defensively clamps a caller-computed limit <= 0", () => {
  it("a suffix long enough to drive the inline formula to 0 doesn't make every seoTitle 'too long'", () => {
    const base = {
      title: "A".repeat(40),
      description: "D".repeat(200),
      metaDescription: "M".repeat(140),
      totalImages: 0,
      imagesWithAlt: 0,
    };
    // Mirrors a caller still using the un-clamped `suffix ? 60 - suffix.length : 60`.
    const r = computeSeoScore({ ...base, seoTitle: "S".repeat(15), seoTitleEffectiveLimit: 0 });
    expect(r.findings.find((f) => f.code.startsWith("seoTitle"))?.code).toBe("seoTitleGood");
  });
});

describe("stripHtml — tag/entity/whitespace normalization shared with keywords.service", () => {
  it("replaces tags with a space so adjacent blocks don't concatenate", () => {
    expect(stripHtml("<p>A</p><p>B</p>")).toBe("A B");
  });
  it("does not throw on numeric entities beyond the Unicode range (review W4)", () => {
    // String.fromCodePoint would RangeError on these — one broken entity in a
    // single item's HTML must not crash the whole audit task or the sidebar.
    expect(stripHtml("ok &#99999999; still ok")).toBe("ok &#99999999; still ok");
    expect(stripHtml("ok &#x110000; still ok")).toBe("ok &#x110000; still ok");
    // In-range entities keep decoding normally.
    expect(stripHtml("caf&#233;")).toBe("café");
  });
  it("decodes common named entities, including German umlauts", () => {
    expect(stripHtml("Gr&ouml;&szlig;e &amp; Farbe")).toBe("Größe & Farbe");
    expect(stripHtml("&lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot; &#39;it&#39;s&#39;")).toBe(
      `<b>bold</b> "quoted" 'it's'`,
    );
  });
  it("decodes numeric (decimal + hex) entities", () => {
    expect(stripHtml("&#65;&#x42;")).toBe("AB");
  });
  it("collapses whitespace and trims", () => {
    expect(stripHtml("  a   \n\t  b  ")).toBe("a b");
  });
  it("a body of only whitespace/tags/&nbsp; strips down to empty", () => {
    expect(stripHtml("<div>   </div>\n<p>&nbsp;</p>")).toBe("");
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(undefined)).toBe("");
  });

  it("computeSeoScore treats a whitespace/tag-only description as missing (descriptionMissing)", () => {
    const r = computeSeoScore({
      title: "A".repeat(40),
      description: "<p>&nbsp;</p>   ",
      seoTitle: "S".repeat(40),
      metaDescription: "M".repeat(140),
      totalImages: 0,
      imagesWithAlt: 0,
    });
    expect(r.findings.find((f) => f.code.startsWith("description"))?.code).toBe("descriptionMissing");
  });
});

describe("tone + label thresholds (single source ≥70 / ≥40)", () => {
  it("scoreTone", () => {
    expect(scoreTone(70)).toBe("success");
    expect(scoreTone(69)).toBe("warning");
    expect(scoreTone(40)).toBe("warning");
    expect(scoreTone(39)).toBe("critical");
  });
  it("scoreLabelKey", () => {
    expect(scoreLabelKey(70)).toBe("good");
    expect(scoreLabelKey(40)).toBe("medium");
    expect(scoreLabelKey(39)).toBe("poor");
  });
  it("progressTone maps the mid band to a Polaris-ProgressBar-valid tone", () => {
    expect(progressTone(70)).toBe("success");
    expect(progressTone(50)).toBe("highlight"); // never "warning" (invalid for ProgressBar)
    expect(progressTone(39)).toBe("critical");
  });
});

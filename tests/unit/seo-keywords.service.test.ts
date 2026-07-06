import { describe, it, expect, vi } from "vitest";
import {
  analyzeOnPage,
  normalizeKeyword,
  setKeyword,
  deleteKeyword,
} from "~/services/seo/keywords.service";

/**
 * Phase 5 keyword on-page analysis (pure) + persistence helpers. Density bands
 * use controlled word counts; H1 is extracted from raw HTML before tag-strip.
 */

describe("normalizeKeyword", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeKeyword("  Blue   SHOES ")).toBe("blue shoes");
  });
});

describe("analyzeOnPage — presence + score", () => {
  it("full presence with ok density scores 100", () => {
    const r = analyzeOnPage({
      keyword: "widget",
      title: "Best Widget",
      seoTitle: "Widget SEO title",
      metaDescription: "A widget for everyone, with plenty of descriptive length here.",
      bodyHtml: `<h1>Widget</h1><p>${"word ".repeat(98)}widget</p>`,
    });
    expect(r.presence).toEqual({
      title: true,
      seoTitle: true,
      metaDescription: true,
      h1: true,
      body: true,
    });
    expect(r.densityBand).toBe("ok");
    expect(r.score).toBe(100);
  });

  it("absent keyword → all false, densityNone, score 0", () => {
    const r = analyzeOnPage({
      keyword: "missing",
      title: "Hello world",
      seoTitle: "",
      metaDescription: "",
      bodyHtml: "<p>nothing relevant here</p>",
    });
    expect(r.presence.title).toBe(false);
    expect(r.presence.body).toBe(false);
    expect(r.densityBand).toBe("none");
    expect(r.score).toBe(0);
    expect(r.findings.find((f) => f.code === "densityNone")).toBeTruthy();
    expect(r.findings.find((f) => f.code === "notInTitle")).toBeTruthy();
  });

  it("extracts H1 from raw HTML before stripping", () => {
    const r = analyzeOnPage({
      keyword: "alpha",
      title: "",
      bodyHtml: "<div><h1>The <b>Alpha</b> heading</h1><p>body text</p></div>",
    });
    expect(r.presence.h1).toBe(true);
  });
});

describe("analyzeOnPage — word-boundary matching (R-keywords-1)", () => {
  it("does NOT match a keyword as a substring of a longer word", () => {
    const r = analyzeOnPage({ keyword: "tee", title: "Garantee inside" });
    expect(r.presence.title).toBe(false);
  });

  it("matches the same keyword as a whole word elsewhere", () => {
    const r = analyzeOnPage({ keyword: "tee", title: "Buy a tee today" });
    expect(r.presence.title).toBe(true);
  });

  it("matches a multi-word keyword across a single space", () => {
    const r = analyzeOnPage({ keyword: "blue shoes", title: "Best Blue Shoes Ever" });
    expect(r.presence.title).toBe(true);
  });

  it("does not match a multi-word keyword split across two spaces/other words", () => {
    const r = analyzeOnPage({ keyword: "blue shoes", title: "Blue suede shoes" });
    expect(r.presence.title).toBe(false);
  });

  it("matches umlaut keywords written as HTML entities in the body (NFC-normalized)", () => {
    const r = analyzeOnPage({
      keyword: "Größe",
      bodyHtml: "<p>Bitte die richtige Gr&ouml;&szlig;e w&auml;hlen.</p>",
    });
    expect(r.presence.body).toBe(true);
  });

  it("treats regex-special characters in the keyword literally (e.g. 'c++')", () => {
    const r = analyzeOnPage({ keyword: "c++", title: "Learn c++ fast" });
    expect(r.presence.title).toBe(true);
    // A plain "c" must not falsely match inside "c++" (word-boundary, not substring).
    const noMatch = analyzeOnPage({ keyword: "c++", title: "Learn c fast" });
    expect(noMatch.presence.title).toBe(false);
  });
});

describe("analyzeOnPage — H1 source depends on resourceType (R-keywords-2)", () => {
  it("for a Product, the effective H1 is the title — descriptionHtml having no <h1> no longer penalizes it", () => {
    const r = analyzeOnPage({
      keyword: "widget",
      resourceType: "Product",
      title: "Best Widget",
      bodyHtml: "<p>Plain description, no heading markup at all.</p>",
    });
    expect(r.presence.h1).toBe(true);
    expect(r.findings.find((f) => f.code === "notInH1")).toBeUndefined();
  });

  it("for a Product, an explicit <h1> in the body is NOT consulted — only the title counts", () => {
    const r = analyzeOnPage({
      keyword: "gadget",
      resourceType: "Product",
      title: "Best Widget",
      bodyHtml: "<h1>Gadget heading merchants shouldn't rely on</h1>",
    });
    expect(r.presence.h1).toBe(false);
  });

  it("for a Collection, the effective H1 is likewise the title", () => {
    const r = analyzeOnPage({
      keyword: "shoes",
      resourceType: "Collection",
      title: "Shoes Collection",
      bodyHtml: "<p>no heading here</p>",
    });
    expect(r.presence.h1).toBe(true);
  });

  it("for an Article, an explicit body <h1> is an additional signal alongside the title", () => {
    const r = analyzeOnPage({
      keyword: "alpha",
      resourceType: "Article",
      title: "Untitled post",
      bodyHtml: "<h1>The Alpha Release</h1><p>body</p>",
    });
    expect(r.presence.h1).toBe(true);
  });

  it("notInH1 still fires for an Article missing the keyword in both title and body <h1>", () => {
    const r = analyzeOnPage({
      keyword: "missing",
      resourceType: "Article",
      title: "Untitled post",
      bodyHtml: "<h1>The Alpha Release</h1><p>body</p>",
    });
    expect(r.presence.h1).toBe(false);
    expect(r.findings.find((f) => f.code === "notInH1")).toBeTruthy();
  });
});

describe("analyzeOnPage — density bands", () => {
  const body = (n: number, occ: number) =>
    `<p>${"word ".repeat(n - occ)}${"widget ".repeat(occ)}</p>`;

  it("low when below 0.5%", () => {
    const r = analyzeOnPage({ keyword: "widget", bodyHtml: body(1000, 1) });
    expect(r.occurrences).toBe(1);
    expect(r.densityPct).toBeCloseTo(0.1, 5);
    expect(r.densityBand).toBe("low");
  });

  it("ok between 0.5% and 2.5%", () => {
    const r = analyzeOnPage({ keyword: "widget", bodyHtml: body(100, 1) });
    expect(r.densityPct).toBeCloseTo(1, 5);
    expect(r.densityBand).toBe("ok");
  });

  it("high above 2.5% (stuffing)", () => {
    const r = analyzeOnPage({ keyword: "widget", bodyHtml: body(100, 3) });
    expect(r.densityPct).toBeCloseTo(3, 5);
    expect(r.densityBand).toBe("high");
    expect(r.findings.find((f) => f.code === "densityHigh")?.severity).toBe("error");
  });

  it("reports first-occurrence position for an early keyword", () => {
    const r = analyzeOnPage({ keyword: "widget", bodyHtml: `<p>widget ${"word ".repeat(99)}</p>` });
    expect(r.firstPositionPct).toBe(0);
  });
});

describe("persistence helpers", () => {
  it("setKeyword upserts a lowercased keyword scoped to the shop/item/locale", async () => {
    const upsert = vi.fn(async (_args: any) => ({}));
    const db = { seoKeyword: { upsert } } as any;
    await setKeyword(db, "s.myshopify.com", {
      resourceType: "Product",
      resourceId: "gid://shopify/Product/1",
      keyword: "  Blue Shoes ",
    });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.shop_resourceId_locale).toEqual({
      shop: "s.myshopify.com",
      resourceId: "gid://shopify/Product/1",
      locale: "",
    });
    expect(arg.create.keyword).toBe("blue shoes");
    expect(arg.update.keyword).toBe("blue shoes");
  });

  it("deleteKeyword scopes the delete to the shop", async () => {
    const deleteMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const db = { seoKeyword: { deleteMany } } as any;
    await deleteKeyword(db, "s.myshopify.com", "kw1");
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "kw1", shop: "s.myshopify.com" } });
  });
});

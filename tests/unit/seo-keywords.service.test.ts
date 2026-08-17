import { describe, it, expect, vi } from "vitest";
import {
  analyzeOnPage,
  findCannibalizationConflicts,
  type KeywordAssignmentRow,
  analyzeMultiKeyword,
  normalizeKeyword,
  assignKeyword,
  assignMany,
  planItemAssignments,
  removeAssignment,
  moveKeyword,
  deleteKeyword,
  createKeyword,
  renameKeyword,
  listAssignments,
  MAX_KEYWORDS_PER_ITEM,
  buildTranslatedContentInput,
  type TranslationRow,
} from "~/services/seo/keywords.service";

/**
 * The keyword write paths consult the shop's plan quota (§Plan-Matrix), so
 * every fake db needs an AISettings row and a shop-wide keyword count. Max +
 * count 0 = "quota never in the way", which keeps the pre-existing assertions
 * about the per-item cap and the locale key focused on what they test. The
 * quota itself is covered by its own cases below.
 */
function quotaFakes(plan = "max", used = 0) {
  return {
    aISettings: { findUnique: vi.fn(async (_args: any) => ({ subscriptionPlan: plan })) },
    keywordCount: vi.fn(async (_args: any) => used),
  };
}


/**
 * Phase 5 keyword on-page analysis (pure) + persistence helpers (keyword +
 * assignment model since the keywords expansion, PLAN_KEYWORDS_EXPANSION.md
 * §2). Density bands use controlled word counts; H1 is extracted from raw
 * HTML before tag-strip.
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

describe("analyzeMultiKeyword", () => {
  it("aggregates per-keyword densities and warns above 5% combined", () => {
    // 100 words, 3× widget + 3× gadget → 3% + 3% = 6% combined.
    const body = `<p>${"word ".repeat(94)}${"widget ".repeat(3)}${"gadget ".repeat(3)}</p>`;
    const r = analyzeMultiKeyword({ bodyHtml: body }, ["widget", "gadget"]);
    expect(r.results).toHaveLength(2);
    expect(r.aggregateDensityPct).toBeCloseTo(6, 1);
    expect(r.aggregateStuffing).toBe(true);
  });

  it("does not warn when the combined density stays below 5%", () => {
    const body = `<p>${"word ".repeat(98)}widget gadget</p>`;
    const r = analyzeMultiKeyword({ bodyHtml: body }, ["widget", "gadget"]);
    expect(r.aggregateStuffing).toBe(false);
  });
});

describe("persistence helpers (keyword + assignment)", () => {
  const SHOP = "s.myshopify.com";
  const P1 = "gid://shopify/Product/1";

  /** Minimal tx mock; db.$transaction(fn) just runs fn(tx). */
  function makeDb(overrides: {
    siblings?: any[];
    keywordRow?: any;
    /** Simulate a keyword the shop does NOT track yet (consumes quota). */
    newKeyword?: boolean;
    plan?: string;
    used?: number;
  } = {}) {
    const keywordRow = overrides.keywordRow ?? { id: "kw1", keyword: "blue shoes", locale: "" };
    const q = quotaFakes(overrides.plan, overrides.used);
    const tx = {
      seoKeyword: {
        upsert: vi.fn(async (_args: any) => keywordRow),
        delete: vi.fn(async (_args: any) => ({})),
        // Quota path: the keyword is already known unless a case says otherwise,
        // so an assign never consumes quota by default.
        findUnique: vi.fn(async (_args: any) =>
          overrides.newKeyword ? null : { id: keywordRow.id },
        ),
        count: q.keywordCount,
      },
      seoKeywordAssignment: {
        findMany: vi.fn(async (_args: any) => overrides.siblings ?? []),
        findFirst: vi.fn(async (_args: any): Promise<any> => null),
        upsert: vi.fn(async (_args: any) => ({})),
        update: vi.fn(async (_args: any) => ({})),
        delete: vi.fn(async (_args: any) => ({})),
        count: vi.fn(async (_args: any) => 0),
      },
      seoKeywordGroupMembership: {
        count: vi.fn(async (_args: any) => 0),
      },
    };
    const db = {
      ...tx,
      aISettings: q.aISettings,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    } as any;
    return { db, tx };
  }

  it("assignKeyword upserts the lowercased keyword on the (shop, keyword, locale) key and creates a primary assignment", async () => {
    const { db, tx } = makeDb();
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "  Blue   SHOES ",
      role: "primary",
    });
    expect(result).toEqual({ ok: true });
    const kwArg = tx.seoKeyword.upsert.mock.calls[0][0];
    expect(kwArg.where.shop_keyword_locale).toEqual({ shop: SHOP, keyword: "blue shoes", locale: "" });
    expect(kwArg.create.keyword).toBe("blue shoes");
    const asgArg = tx.seoKeywordAssignment.upsert.mock.calls[0][0];
    expect(asgArg.where.shop_keywordId_resourceId).toEqual({ shop: SHOP, keywordId: "kw1", resourceId: P1 });
    expect(asgArg.create.role).toBe("primary");
    expect(asgArg.create.resourceType).toBe("Product");
  });

  it("assignKeyword keeps the (shop, keyword, locale) key for a non-primary locale", async () => {
    const { db, tx } = makeDb({ keywordRow: { id: "kw2", keyword: "chaussures bleues", locale: "fr" } });
    await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "chaussures bleues",
      locale: "fr",
      role: "primary",
    });
    const kwArg = tx.seoKeyword.upsert.mock.calls[0][0];
    expect(kwArg.where.shop_keyword_locale).toEqual({ shop: SHOP, keyword: "chaussures bleues", locale: "fr" });
    // The sibling lookup folds the locale via the keyword relation.
    const findArg = tx.seoKeywordAssignment.findMany.mock.calls[0][0];
    expect(findArg.where.keyword).toEqual({ locale: "fr" });
  });

  it("assignKeyword stamps provided GSC metrics onto create AND update (adopt flow)", async () => {
    const { db, tx } = makeDb();
    const updatedAt = new Date("2026-07-21T00:00:00Z");
    await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "primary",
      gsc: { position: 7.5, clicks: 12, impressions: 300, ctr: 0.04, updatedAt },
    });
    const asgArg = tx.seoKeywordAssignment.upsert.mock.calls[0][0];
    const expected = {
      gscPosition: 7.5,
      gscClicks: 12,
      gscImpressions: 300,
      gscCtr: 0.04,
      gscUpdatedAt: updatedAt,
    };
    expect(asgArg.create).toMatchObject(expected);
    expect(asgArg.update).toMatchObject(expected);
  });

  it("assignKeyword without gsc leaves the assignment's GSC columns untouched", async () => {
    const { db, tx } = makeDb();
    await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "primary",
    });
    const asgArg = tx.seoKeywordAssignment.upsert.mock.calls[0][0];
    expect(asgArg.update).not.toHaveProperty("gscPosition");
    expect(asgArg.create).not.toHaveProperty("gscPosition");
  });

  it("assignKeyword with keepExistingPrimary never downgrades an existing primary to secondary", async () => {
    const { db, tx } = makeDb({
      siblings: [
        { id: "a1", keywordId: "kw1", role: "primary", keyword: { id: "kw1", keyword: "blue shoes", locale: "" } },
      ],
    });
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "secondary",
      keepExistingPrimary: true,
    });
    expect(result).toEqual({ ok: true });
    const asgArg = tx.seoKeywordAssignment.upsert.mock.calls[0][0];
    expect(asgArg.update.role).toBe("primary"); // role preserved, no silent demote
  });

  it("assignKeyword WITHOUT keepExistingPrimary applies an explicit secondary role change", async () => {
    const { db, tx } = makeDb({
      siblings: [
        { id: "a1", keywordId: "kw1", role: "primary", keyword: { id: "kw1", keyword: "blue shoes", locale: "" } },
      ],
    });
    await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "secondary",
    });
    const asgArg = tx.seoKeywordAssignment.upsert.mock.calls[0][0];
    expect(asgArg.update.role).toBe("secondary");
  });

  it("assignKeyword refuses a second primary without demoteExisting (no write)", async () => {
    const { db, tx } = makeDb({
      siblings: [
        { id: "a1", keywordId: "kwOld", role: "primary", keyword: { id: "kwOld", keyword: "old primary", locale: "" } },
      ],
    });
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "primary",
    });
    expect(result).toEqual({ ok: false, reason: "primaryExists", existingKeyword: "old primary" });
    expect(tx.seoKeywordAssignment.upsert).not.toHaveBeenCalled();
    expect(tx.seoKeywordAssignment.update).not.toHaveBeenCalled();
  });

  it("assignKeyword with demoteExisting demotes the old primary and writes the new one", async () => {
    const { db, tx } = makeDb({
      siblings: [
        { id: "a1", keywordId: "kwOld", role: "primary", keyword: { id: "kwOld", keyword: "old primary", locale: "" } },
      ],
    });
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "primary",
      demoteExisting: true,
    });
    expect(result).toEqual({ ok: true });
    expect(tx.seoKeywordAssignment.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { role: "secondary" },
    });
    expect(tx.seoKeywordAssignment.upsert).toHaveBeenCalled();
  });

  it("assignKeyword rejects a NEW keyword once the per-item cap is reached", async () => {
    const siblings = Array.from({ length: MAX_KEYWORDS_PER_ITEM }, (_, i) => ({
      id: `a${i}`,
      keywordId: `kwOther${i}`,
      role: i === 0 ? "primary" : "secondary",
      keyword: { id: `kwOther${i}`, keyword: `kw ${i}`, locale: "" },
    }));
    const { db, tx } = makeDb({ siblings });
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "secondary",
    });
    expect(result).toEqual({ ok: false, reason: "tooMany" });
    expect(tx.seoKeywordAssignment.upsert).not.toHaveBeenCalled();
  });

  it("assignKeyword still accepts a role change for an ALREADY assigned keyword at the cap", async () => {
    const siblings = Array.from({ length: MAX_KEYWORDS_PER_ITEM }, (_, i) => ({
      id: `a${i}`,
      keywordId: i === 0 ? "kw1" : `kwOther${i}`,
      role: "secondary",
      keyword: { id: i === 0 ? "kw1" : `kwOther${i}`, keyword: i === 0 ? "blue shoes" : `kw ${i}`, locale: "" },
    }));
    const { db, tx } = makeDb({ siblings });
    const result = await assignKeyword(db, SHOP, {
      resourceType: "Product",
      resourceId: P1,
      keyword: "blue shoes",
      role: "primary",
    });
    expect(result).toEqual({ ok: true });
    expect(tx.seoKeywordAssignment.upsert).toHaveBeenCalled();
  });

  it("removeAssignment deletes the assignment and a fully orphaned keyword", async () => {
    const { db, tx } = makeDb();
    tx.seoKeywordAssignment.findFirst.mockResolvedValueOnce({ keywordId: "kw1" });
    await removeAssignment(db, SHOP, "a1");
    expect(tx.seoKeywordAssignment.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(tx.seoKeyword.delete).toHaveBeenCalledWith({ where: { id: "kw1" } });
  });

  it("removeAssignment keeps the keyword while other assignments or memberships reference it", async () => {
    const { db, tx } = makeDb();
    tx.seoKeywordAssignment.findFirst.mockResolvedValueOnce({ keywordId: "kw1" });
    tx.seoKeywordAssignment.count.mockResolvedValueOnce(1);
    await removeAssignment(db, SHOP, "a1");
    expect(tx.seoKeyword.delete).not.toHaveBeenCalled();
  });

  it("removeAssignment is shop-scoped: unknown/foreign id is a no-op", async () => {
    const { db, tx } = makeDb();
    await removeAssignment(db, SHOP, "foreign");
    expect(tx.seoKeywordAssignment.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign", shop: SHOP },
      select: { keywordId: true },
    });
    expect(tx.seoKeywordAssignment.delete).not.toHaveBeenCalled();
  });

  it("findPrimaryElsewhere queries for a DIFFERENT item of the SAME type with the normalized keyword", async () => {
    const { findPrimaryElsewhere } = await import("~/services/seo/keywords.service");
    const findFirst = vi.fn(async (_args: any): Promise<any> => ({ resourceId: "p2" }));
    const db = { seoKeywordAssignment: { findFirst } } as any;
    const result = await findPrimaryElsewhere(db, SHOP, {
      keyword: "  Blue   SHOES ",
      resourceType: "Product",
      excludeResourceId: P1,
    });
    expect(result).toEqual({ resourceId: "p2" });
    const arg = findFirst.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      shop: SHOP,
      role: "primary",
      resourceType: "Product",
      resourceId: { not: P1 },
      keyword: { keyword: "blue shoes", locale: "" },
    });
  });

  it("setKeywordPriorities writes the selection shop-scoped, rejects bad input", async () => {
    const { setKeywordPriorities } = await import("~/services/seo/keywords.service");
    const updateMany = vi.fn(async (_args: any) => ({ count: 3 }));
    const db = { seoKeyword: { updateMany } } as any;
    // Invalid priority → 0, no write.
    expect(await setKeywordPriorities(db, SHOP, ["kw1"], 7)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    // Empty selection → 0, no write (an updateMany with `in: []` would be a
    // pointless round trip).
    expect(await setKeywordPriorities(db, SHOP, [], 1)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    // Real selection → one shop-scoped updateMany over exactly those ids.
    expect(await setKeywordPriorities(db, SHOP, ["kw1", "kw2"], 1)).toBe(3);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["kw1", "kw2"] }, shop: SHOP },
      data: { priority: 1 },
    });
  });

  it("listAssignments flattens the keyword join into rows (incl. locale + role)", async () => {
    const rows = [
      {
        id: "a1", resourceType: "Product", resourceId: "p1", role: "primary",
        gscPosition: null, gscClicks: null, gscImpressions: null, gscCtr: null,
        keyword: { id: "kw1", keyword: "widget", locale: "", priority: 2, updatedAt: new Date() },
      },
      {
        id: "a2", resourceType: "Product", resourceId: "p1", role: "secondary",
        gscPosition: 3.2, gscClicks: 5, gscImpressions: 100, gscCtr: 0.05,
        keyword: { id: "kw2", keyword: "gadget", locale: "fr", priority: 1, updatedAt: new Date() },
      },
    ];
    const findMany = vi.fn(async (_args: any) => rows);
    const db = { seoKeywordAssignment: { findMany } } as any;
    const result = await listAssignments(db, SHOP);
    expect(findMany.mock.calls[0][0].where).toEqual({ shop: SHOP });
    expect(result.map((r) => r.locale)).toEqual(["", "fr"]);
    expect(result.map((r) => r.role)).toEqual(["primary", "secondary"]);
    expect(result[1].gscPosition).toBe(3.2);
    expect(result[1].priority).toBe(1);
  });
});

describe("assignMany / planItemAssignments", () => {
  const SHOP = "s.myshopify.com";
  const P1 = "gid://shopify/Product/1";

  // ── planItemAssignments (pure) ──

  it("planItemAssignments skips the add that would exceed the 5-limit (cumulative)", () => {
    const siblings = [
      { keywordId: "s1", role: "secondary" as const },
      { keywordId: "s2", role: "secondary" as const },
      { keywordId: "s3", role: "secondary" as const },
    ];
    const keywords = [
      { keywordId: "a", role: "secondary" as const },
      { keywordId: "b", role: "secondary" as const },
      { keywordId: "c", role: "secondary" as const },
    ];
    const plan = planItemAssignments({ resourceId: P1, keywords, siblings, demoteExisting: false });
    // 3 existing + a (→4) + b (→5) apply; c would be the 6th → limitReached.
    expect(plan.applies.map((a) => a.keywordId)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([{ keywordId: "c", resourceId: P1, reason: "limitReached" }]);
  });

  it("planItemAssignments skips a new primary as primaryExists when a different primary exists (no demote)", () => {
    const plan = planItemAssignments({
      resourceId: P1,
      keywords: [{ keywordId: "new", role: "primary" }],
      siblings: [{ keywordId: "old", role: "primary" }],
      demoteExisting: false,
    });
    expect(plan.applies).toEqual([]);
    expect(plan.skipped).toEqual([{ keywordId: "new", resourceId: P1, reason: "primaryExists" }]);
  });

  it("planItemAssignments demotes the old primary when demoteExisting flips it", () => {
    const plan = planItemAssignments({
      resourceId: P1,
      keywords: [{ keywordId: "new", role: "primary" }],
      siblings: [{ keywordId: "old", role: "primary" }],
      demoteExisting: true,
    });
    expect(plan.applies).toEqual([{ keywordId: "new", role: "primary", demote: true }]);
    expect(plan.skipped).toEqual([]);
  });

  it("planItemAssignments skips a keyword already present with the same role as duplicate", () => {
    const plan = planItemAssignments({
      resourceId: P1,
      keywords: [{ keywordId: "a", role: "secondary" }],
      siblings: [{ keywordId: "a", role: "secondary" }],
      demoteExisting: false,
    });
    expect(plan.applies).toEqual([]);
    expect(plan.skipped).toEqual([{ keywordId: "a", resourceId: P1, reason: "duplicate" }]);
  });

  it("planItemAssignments promotes an existing secondary to primary (no count change, no different primary)", () => {
    const plan = planItemAssignments({
      resourceId: P1,
      keywords: [{ keywordId: "a", role: "primary" }],
      siblings: [{ keywordId: "a", role: "secondary" }],
      demoteExisting: false,
    });
    expect(plan.applies).toEqual([{ keywordId: "a", role: "primary", demote: false }]);
    expect(plan.skipped).toEqual([]);
  });

  it("planItemAssignments promotion demotes a different existing primary with demoteExisting", () => {
    const plan = planItemAssignments({
      resourceId: P1,
      keywords: [{ keywordId: "a", role: "primary" }],
      siblings: [
        { keywordId: "a", role: "secondary" },
        { keywordId: "old", role: "primary" },
      ],
      demoteExisting: true,
    });
    expect(plan.applies).toEqual([{ keywordId: "a", role: "primary", demote: true }]);
    expect(plan.skipped).toEqual([]);
  });

  // ── assignMany ──

  it("assignMany dryRun returns the predicted applied count + skips WITHOUT writing", async () => {
    // Six keywords, one empty-sibling item, secondary role → 5 apply, 6th limitReached.
    const ids = ["k0", "k1", "k2", "k3", "k4", "k5"];
    const keywordFindMany = vi.fn(async (_args: any) =>
      ids.map((id) => ({ id, keyword: id, locale: "" })),
    );
    const assignmentFindMany = vi.fn(async (_args: any) => []);
    const upsert = vi.fn(async (_args: any) => ({}));
    const $transaction = vi.fn(async (fn: any) => fn({}));
    const db = {
      seoKeyword: { findMany: keywordFindMany },
      seoKeywordAssignment: { findMany: assignmentFindMany, upsert },
      $transaction,
    } as any;

    const result = await assignMany(db, SHOP, {
      keywordIds: ids,
      targets: [{ resourceType: "Product", resourceId: P1 }],
      role: "secondary",
      dryRun: true,
    });
    expect(result.applied).toBe(5);
    expect(result.skipped).toEqual([{ keywordId: "k5", resourceId: P1, reason: "limitReached" }]);
    // No writes at all in a dry run.
    expect(upsert).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("assignMany real path counts applied and folds a tooMany return into skipped", async () => {
    const ids = ["kwA", "kwB"];
    const keywordFindMany = vi.fn(async (_args: any) => [
      { id: "kwA", keyword: "a", locale: "" },
      { id: "kwB", keyword: "b", locale: "" },
    ]);
    // Top-level lookup: no existing assignments → planner plans BOTH.
    const topAssignmentFindMany = vi.fn(async (_args: any) => []);

    // Inside each assignKeyword transaction: kwA sees no siblings (applies),
    // kwB races into a full item (5 siblings) → tooMany, folded to limitReached.
    const fiveSiblings = Array.from({ length: MAX_KEYWORDS_PER_ITEM }, (_, i) => ({
      id: `x${i}`,
      keywordId: `kwOther${i}`,
      role: "secondary",
      keyword: { id: `kwOther${i}`, keyword: `kw ${i}`, locale: "" },
    }));
    const txUpsertKw = vi
      .fn()
      .mockResolvedValueOnce({ id: "kwA", keyword: "a", locale: "" })
      .mockResolvedValueOnce({ id: "kwB", keyword: "b", locale: "" });
    const txAssignmentFindMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(fiveSiblings);
    const txAssignmentUpsert = vi.fn(async (_args: any) => ({}));
    const tx = {
      seoKeyword: {
        upsert: txUpsertKw,
        // Both keywords already exist (assignMany works off keyword IDs), so
        // the quota never engages here.
        findUnique: vi.fn(async (_args: any) => ({ id: "kw" })),
        count: vi.fn(async (_args: any) => 0),
      },
      seoKeywordAssignment: {
        findMany: txAssignmentFindMany,
        upsert: txAssignmentUpsert,
        update: vi.fn(async (_args: any) => ({})),
      },
    };
    const db = {
      seoKeyword: { findMany: keywordFindMany },
      seoKeywordAssignment: { findMany: topAssignmentFindMany },
      aISettings: quotaFakes().aISettings,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    } as any;

    const result = await assignMany(db, SHOP, {
      keywordIds: ids,
      targets: [{ resourceType: "Product", resourceId: P1 }],
      role: "secondary",
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([{ keywordId: "kwB", resourceId: P1, reason: "limitReached" }]);
    // kwA was actually written; kwB never reached the upsert (tooMany short-circuit).
    expect(txAssignmentUpsert).toHaveBeenCalledTimes(1);
  });

  it("assignMany drops unknown/foreign keyword ids before planning", async () => {
    const keywordFindMany = vi.fn(async (_args: any) => [{ id: "known", keyword: "a", locale: "" }]);
    const assignmentFindMany = vi.fn(async (_args: any) => []);
    const db = {
      seoKeyword: { findMany: keywordFindMany },
      seoKeywordAssignment: { findMany: assignmentFindMany },
    } as any;
    const result = await assignMany(db, SHOP, {
      keywordIds: ["known", "foreign"],
      targets: [{ resourceType: "Product", resourceId: P1 }],
      role: "secondary",
      dryRun: true,
    });
    // Only the known keyword is planned.
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
  });
});

describe("group locale (Phase 0)", () => {
  const SHOP = "s.myshopify.com";

  it("createGroup uses the shop_name_locale composite key and writes locale in create data", async () => {
    const { createGroup } = await import("~/services/seo/keywords.service");
    const findUnique = vi.fn(async (_args: any): Promise<any> => null);
    const create = vi.fn(async (_args: any) => ({ id: "g1" }));
    const db = { seoKeywordGroup: { findUnique, create } } as any;

    const result = await createGroup(db, SHOP, "  Summer  ", "fr", "  desc  ");
    expect(result).toEqual({ ok: true, id: "g1" });
    expect(findUnique.mock.calls[0][0].where.shop_name_locale).toEqual({
      shop: SHOP,
      name: "Summer",
      locale: "fr",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ shop: SHOP, name: "Summer", locale: "fr", description: "desc" });
  });

  it("createGroup defaults locale to the primary ('') bucket", async () => {
    const { createGroup } = await import("~/services/seo/keywords.service");
    const findUnique = vi.fn(async (_args: any): Promise<any> => null);
    const create = vi.fn(async (_args: any) => ({ id: "g2" }));
    const db = { seoKeywordGroup: { findUnique, create } } as any;

    await createGroup(db, SHOP, "Default");
    expect(findUnique.mock.calls[0][0].where.shop_name_locale).toEqual({ shop: SHOP, name: "Default", locale: "" });
    expect(create.mock.calls[0][0].data.locale).toBe("");
  });

  it("listGroups filters on { shop, locale } and returns locale in the rows", async () => {
    const { listGroups } = await import("~/services/seo/keywords.service");
    const findMany = vi.fn(async (_args: any) => [
      { id: "g1", name: "Alpha", locale: "fr", description: null, _count: { memberships: 3 } },
    ]);
    const db = { seoKeywordGroup: { findMany } } as any;

    const rows = await listGroups(db, SHOP, "fr");
    expect(findMany.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "fr" });
    expect(rows).toEqual([{ id: "g1", name: "Alpha", locale: "fr", description: null, keywordCount: 3 }]);
  });

  it("addKeywordsToGroup ignores entry.locale and stamps the group's locale onto created keywords", async () => {
    const { addKeywordsToGroup } = await import("~/services/seo/keywords.service");
    const createMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const db = {
      seoKeywordGroup: { findFirst: vi.fn(async (_args: any) => ({ locale: "de" })) },
      seoKeyword: {
        findMany: vi.fn(async (_args: any) => []), // nothing exists yet, then still nothing after create in this mock
        count: vi.fn(async (_args: any) => 0),
        createMany,
      },
      aISettings: quotaFakes().aISettings,
      seoKeywordGroupMembership: {
        findMany: vi.fn(async (_args: any) => []),
        createMany: vi.fn(async (_args: any) => ({ count: 0 })),
      },
    } as any;

    await addKeywordsToGroup(db, SHOP, "g1", [{ keyword: "Widget", locale: "fr" }]);
    // The group's locale (de) wins over the entry's locale (fr).
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ shop: SHOP, keyword: "widget", locale: "de" });
  });

  it("addKeywordsToGroup returns {added:0, alreadyInGroup:0} for a missing/foreign group", async () => {
    const { addKeywordsToGroup } = await import("~/services/seo/keywords.service");
    const createMany = vi.fn(async (_args: any) => ({ count: 0 }));
    const db = {
      seoKeywordGroup: { findFirst: vi.fn(async (_args: any): Promise<any> => null) },
      seoKeyword: {
        findMany: vi.fn(async (_args: any) => []),
        count: vi.fn(async (_args: any) => 0),
        createMany,
      },
      seoKeywordGroupMembership: { findMany: vi.fn(async (_args: any) => []), createMany: vi.fn() },
      aISettings: quotaFakes().aISettings,
    } as any;

    const result = await addKeywordsToGroup(db, SHOP, "foreign", [{ keyword: "widget" }]);
    expect(result).toEqual({ added: 0, alreadyInGroup: 0, skippedOverQuota: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("deleteGroup deletes member keywords with groups:{none} and NO assignments condition (§3.2 ownership)", async () => {
    const { deleteGroup } = await import("~/services/seo/keywords.service");
    const deleteMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const tx = {
      seoKeywordGroup: {
        findFirst: vi.fn(async (_args: any) => ({ id: "g1" })),
        delete: vi.fn(async (_args: any) => ({})),
      },
      seoKeywordGroupMembership: {
        findMany: vi.fn(async (_args: any) => [{ keywordId: "kw1" }, { keywordId: "kw2" }]),
      },
      seoKeyword: { deleteMany },
    };
    const db = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;

    await deleteGroup(db, SHOP, "g1");
    const where = deleteMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: { in: ["kw1", "kw2"] }, shop: SHOP, groups: { none: {} } });
    expect(where).not.toHaveProperty("assignments");
  });

  it("countUngrouped passes { shop, locale, groups: { none: {} } }", async () => {
    const { countUngrouped } = await import("~/services/seo/keywords.service");
    const count = vi.fn(async (_args: any) => 7);
    const db = { seoKeyword: { count } } as any;

    expect(await countUngrouped(db, SHOP, "fr")).toBe(7);
    expect(count.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "fr", groups: { none: {} } });
  });

  it("listUngrouped passes { shop, locale, groups: { none: {} } } and maps + sorts rows", async () => {
    const { listUngrouped } = await import("~/services/seo/keywords.service");
    const findMany = vi.fn(async (_args: any) => [
      { id: "kw2", keyword: "zebra", locale: "", priority: 1, _count: { assignments: 4 } },
      { id: "kw1", keyword: "apple", locale: "", priority: 1, _count: { assignments: 0 } },
    ]);
    const db = { seoKeyword: { findMany } } as any;

    const rows = await listUngrouped(db, SHOP);
    expect(findMany.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "", groups: { none: {} } });
    // Same sort as getGroupKeywords: priority asc, then keyword asc.
    expect(rows.map((r) => r.keyword)).toEqual(["apple", "zebra"]);
    expect(rows[0]).toEqual({ keywordId: "kw1", keyword: "apple", locale: "", priority: 1, assignmentCount: 0 });
  });

  it("countAllKeywords passes { shop, locale }", async () => {
    const { countAllKeywords } = await import("~/services/seo/keywords.service");
    const count = vi.fn(async (_args: any) => 312);
    const db = { seoKeyword: { count } } as any;

    expect(await countAllKeywords(db, SHOP, "fr")).toBe(312);
    expect(count.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "fr" });
  });

  it("listAllKeywords passes { shop, locale } and maps + sorts rows", async () => {
    const { listAllKeywords } = await import("~/services/seo/keywords.service");
    const findMany = vi.fn(async (_args: any) => [
      { id: "kw2", keyword: "zebra", locale: "", priority: 1, _count: { assignments: 4 } },
      { id: "kw1", keyword: "apple", locale: "", priority: 1, _count: { assignments: 0 } },
    ]);
    const db = { seoKeyword: { findMany } } as any;

    const rows = await listAllKeywords(db, SHOP);
    // No groups filter — "Alle" is every keyword of the locale.
    expect(findMany.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "" });
    // Same sort as getGroupKeywords: priority asc, then keyword asc.
    expect(rows.map((r) => r.keyword)).toEqual(["apple", "zebra"]);
    expect(rows[0]).toEqual({ keywordId: "kw1", keyword: "apple", locale: "", priority: 1, assignmentCount: 0 });
  });
});

describe("buildTranslatedContentInput", () => {
  const rows: TranslationRow[] = [
    { resourceId: "p1", locale: "fr", key: "title", value: "Titre FR" },
    { resourceId: "p1", locale: "fr", key: "meta_description", value: "Description FR" },
    // A different locale/resource row in the same batch must not leak in —
    // the caller is expected to pre-filter to one (resourceId, locale) pair.
    { resourceId: "p1", locale: "de", key: "title", value: "Titel DE" },
  ];

  it("maps ContentTranslation keys to the analyzeOnPage input shape", () => {
    const input = buildTranslatedContentInput(rows.filter((r) => r.locale === "fr"));
    expect(input).toEqual({
      title: "Titre FR",
      seoTitle: "",
      metaDescription: "Description FR",
      bodyHtml: "",
    });
  });

  it("falls back to empty string for untranslated fields rather than any primary value", () => {
    const input = buildTranslatedContentInput([]);
    expect(input).toEqual({ title: "", seoTitle: "", metaDescription: "", bodyHtml: "" });
  });

  it("the empty-fallback input analyzes as keyword-missing (not silently passing)", () => {
    const input = buildTranslatedContentInput([]);
    const result = analyzeOnPage({ keyword: "widget", ...input, resourceType: "Product" });
    expect(result.score).toBe(0);
    expect(result.presence).toEqual({ title: false, seoTitle: false, metaDescription: false, h1: false, body: false });
  });
});

/**
 * moveKeyword — the merchant-side fix for a keyword tracked under the wrong
 * language or filed in the wrong group. Same tx-mock style as the assignment
 * helpers above; a language change is a MERGE into the target language's
 * keyword row, so the invariants of that language (one primary per item,
 * MAX_KEYWORDS_PER_ITEM) are enforced on the way in.
 */
describe("moveKeyword", () => {
  const SHOP = "s.myshopify.com";
  const P1 = "gid://shopify/Product/1";
  const P2 = "gid://shopify/Product/2";

  function makeDb(overrides: {
    source?: any;
    targetGroup?: any;
    targetKeyword?: any;
    sourceAssignments?: any[];
    existingAssignments?: any[];
    membership?: any;
  } = {}) {
    const tx = {
      seoKeyword: {
        // `in` rather than ?? so an explicit `source: null` (unknown id) survives.
        findFirst: vi.fn(async (_a: any) =>
          "source" in overrides
            ? overrides.source
            : { id: "kw1", keyword: "blue shoes", locale: "", priority: 2 },
        ),
        findUnique: vi.fn(async (_a: any) => overrides.targetKeyword ?? null),
        create: vi.fn(async (_a: any) => ({ id: "kwNew" })),
        delete: vi.fn(async (_a: any) => ({})),
      },
      seoKeywordGroup: {
        findFirst: vi.fn(async (_a: any) => overrides.targetGroup ?? { id: "g2", locale: "" }),
      },
      seoKeywordGroupMembership: {
        findFirst: vi.fn(async (_a: any) => overrides.membership ?? null),
        create: vi.fn(async (_a: any) => ({})),
        deleteMany: vi.fn(async (_a: any) => ({ count: 0 })),
      },
      seoKeywordAssignment: {
        findMany: vi.fn(async (args: any) =>
          args?.where?.keywordId ? overrides.sourceAssignments ?? [] : overrides.existingAssignments ?? [],
        ),
        updateMany: vi.fn(async (_a: any) => ({ count: 0 })),
        deleteMany: vi.fn(async (_a: any) => ({ count: 0 })),
      },
    };
    const db = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    return { db, tx };
  }

  it("same language: swaps the group membership and touches nothing else", async () => {
    const { db, tx } = makeDb();
    const result = await moveKeyword(db, SHOP, {
      keywordId: "kw1",
      fromGroupId: "g1",
      targetLocale: "",
      targetGroupId: "g2",
    });
    expect(result).toEqual({ ok: true, keywordId: "kw1", movedAssignments: 0, demoted: 0, droppedAssignments: 0 });
    expect(tx.seoKeywordGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: { groupId: "g1", keywordId: "kw1", shop: SHOP },
    });
    expect(tx.seoKeywordGroupMembership.create).toHaveBeenCalledWith({
      data: { shop: SHOP, groupId: "g2", keywordId: "kw1" },
    });
    expect(tx.seoKeyword.delete).not.toHaveBeenCalled();
    expect(tx.seoKeywordAssignment.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a target group that belongs to another language (§3.1 invariant)", async () => {
    const { db, tx } = makeDb({ targetGroup: { id: "g2", locale: "de" } });
    const result = await moveKeyword(db, SHOP, {
      keywordId: "kw1",
      targetLocale: "fr",
      targetGroupId: "g2",
    });
    expect(result).toEqual({ ok: false, reason: "groupLocaleMismatch" });
    expect(tx.seoKeyword.delete).not.toHaveBeenCalled();
    expect(tx.seoKeyword.create).not.toHaveBeenCalled();
  });

  it("language change: creates the target-language row, re-points assignments and deletes the old row", async () => {
    const { db, tx } = makeDb({
      targetGroup: { id: "g2", locale: "fr" },
      sourceAssignments: [{ id: "a1", resourceId: P1, resourceType: "Product", role: "primary" }],
    });
    const result = await moveKeyword(db, SHOP, {
      keywordId: "kw1",
      fromGroupId: "g1",
      targetLocale: "fr",
      targetGroupId: "g2",
    });
    expect(result).toEqual({
      ok: true,
      keywordId: "kwNew",
      movedAssignments: 1,
      demoted: 0,
      droppedAssignments: 0,
    });
    expect(tx.seoKeyword.create.mock.calls[0][0].data).toMatchObject({
      shop: SHOP,
      keyword: "blue shoes",
      locale: "fr",
    });
    expect(tx.seoKeywordAssignment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] }, shop: SHOP },
      data: { keywordId: "kwNew" },
    });
    // Old-language memberships cannot follow the keyword.
    expect(tx.seoKeywordGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: { keywordId: "kw1", shop: SHOP },
    });
    expect(tx.seoKeyword.delete).toHaveBeenCalledWith({ where: { id: "kw1" } });
    expect(tx.seoKeywordGroupMembership.create).toHaveBeenCalledWith({
      data: { shop: SHOP, groupId: "g2", keywordId: "kwNew" },
    });
  });

  it("language change: merges into an EXISTING target-language keyword instead of creating one", async () => {
    const { db, tx } = makeDb({
      targetGroup: { id: "g2", locale: "fr" },
      targetKeyword: { id: "kwFr" },
      sourceAssignments: [{ id: "a1", resourceId: P1, resourceType: "Product", role: "secondary" }],
    });
    const result = await moveKeyword(db, SHOP, { keywordId: "kw1", targetLocale: "fr", targetGroupId: "g2" });
    expect(tx.seoKeyword.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, keywordId: "kwFr", movedAssignments: 1 });
  });

  it("language change: a moved primary lands as secondary when the item already has one there", async () => {
    const { db, tx } = makeDb({
      targetGroup: { id: "g2", locale: "fr" },
      sourceAssignments: [{ id: "a1", resourceId: P1, resourceType: "Product", role: "primary" }],
      existingAssignments: [{ keywordId: "other", resourceId: P1, role: "primary" }],
    });
    const result = await moveKeyword(db, SHOP, { keywordId: "kw1", targetLocale: "fr", targetGroupId: "g2" });
    expect(result).toMatchObject({ movedAssignments: 1, demoted: 1, droppedAssignments: 0 });
    expect(tx.seoKeywordAssignment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] }, shop: SHOP },
      data: { keywordId: "kwNew", role: "secondary" },
    });
  });

  it("language change: drops an assignment whose item is already at the keyword cap in the target language", async () => {
    const existingAssignments = Array.from({ length: MAX_KEYWORDS_PER_ITEM }, (_, i) => ({
      keywordId: `k${i}`,
      resourceId: P2,
      role: i === 0 ? "primary" : "secondary",
    }));
    const { db, tx } = makeDb({
      targetGroup: { id: "g2", locale: "fr" },
      sourceAssignments: [{ id: "a2", resourceId: P2, resourceType: "Product", role: "secondary" }],
      existingAssignments,
    });
    const result = await moveKeyword(db, SHOP, { keywordId: "kw1", targetLocale: "fr", targetGroupId: "g2" });
    expect(result).toMatchObject({ movedAssignments: 0, droppedAssignments: 1 });
    expect(tx.seoKeywordAssignment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a2"] }, shop: SHOP },
    });
    expect(tx.seoKeywordAssignment.updateMany).not.toHaveBeenCalled();
  });

  it("language change: drops the incoming assignment when the item already tracks the keyword there", async () => {
    const { db, tx } = makeDb({
      targetGroup: { id: "g2", locale: "fr" },
      targetKeyword: { id: "kwFr" },
      sourceAssignments: [{ id: "a1", resourceId: P1, resourceType: "Product", role: "primary" }],
      existingAssignments: [{ keywordId: "kwFr", resourceId: P1, role: "secondary" }],
    });
    const result = await moveKeyword(db, SHOP, { keywordId: "kw1", targetLocale: "fr", targetGroupId: "g2" });
    expect(result).toMatchObject({ movedAssignments: 0, droppedAssignments: 1 });
    expect(tx.seoKeywordAssignment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] }, shop: SHOP },
    });
  });

  it("a move to 'no group' keeps the keyword (it lands in the ungrouped bucket)", async () => {
    const { db, tx } = makeDb();
    const result = await moveKeyword(db, SHOP, {
      keywordId: "kw1",
      fromGroupId: "g1",
      targetLocale: "",
      targetGroupId: null,
    });
    expect(result).toMatchObject({ ok: true, keywordId: "kw1" });
    expect(tx.seoKeywordGroupMembership.create).not.toHaveBeenCalled();
    expect(tx.seoKeyword.delete).not.toHaveBeenCalled();
  });

  it("an unknown keyword id reports notFound without writing", async () => {
    const { db, tx } = makeDb({ source: null });
    const result = await moveKeyword(db, SHOP, { keywordId: "nope", targetLocale: "", targetGroupId: null });
    expect(result).toEqual({ ok: false, reason: "notFound" });
    expect(tx.seoKeywordGroupMembership.create).not.toHaveBeenCalled();
  });
});

/**
 * deleteKeyword — the explicit "get rid of it" path. The pre-existing removal
 * helpers only drop a keyword as a side effect of it becoming an orphan, so
 * this is the only one that removes a keyword that IS assigned to items.
 */
describe("deleteKeyword", () => {
  const SHOP = "s.myshopify.com";

  function makeDb(found: any = { id: "kw1" }, assignmentCount = 0) {
    const tx = {
      seoKeyword: {
        findFirst: vi.fn(async (_a: any) => found),
        delete: vi.fn(async (_a: any) => ({})),
      },
      seoKeywordAssignment: {
        count: vi.fn(async (_a: any) => assignmentCount),
      },
    };
    const db = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    return { db, tx };
  }

  it("deletes the keyword row and reports how many assignments cascade with it", async () => {
    const { db, tx } = makeDb({ id: "kw1" }, 3);
    const result = await deleteKeyword(db, SHOP, "kw1");
    expect(result).toEqual({ ok: true, removedAssignments: 3 });
    expect(tx.seoKeyword.delete).toHaveBeenCalledWith({ where: { id: "kw1" } });
  });

  it("deletes an unassigned keyword too (the ungrouped-bucket dead end)", async () => {
    const { db, tx } = makeDb({ id: "kw1" }, 0);
    const result = await deleteKeyword(db, SHOP, "kw1");
    expect(result).toEqual({ ok: true, removedAssignments: 0 });
    expect(tx.seoKeyword.delete).toHaveBeenCalled();
  });

  it("is shop-scoped: an unknown or foreign id is a no-op, not a delete", async () => {
    const { db, tx } = makeDb(null);
    const result = await deleteKeyword(db, SHOP, "foreign");
    expect(result).toEqual({ ok: false, removedAssignments: 0 });
    expect(tx.seoKeyword.delete).not.toHaveBeenCalled();
    expect(tx.seoKeyword.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign", shop: SHOP },
      select: { id: true },
    });
  });
});

/**
 * Inline table editing: "+ Keyword" adds a row under an auto-generated name
 * and the name is then edited in place. The two rules worth pinning down are
 * the placeholder numbering (lowest FREE number, per language) and that a
 * rename never silently merges two keywords.
 */
describe("createKeyword — placeholder rows for inline editing", () => {
  const SHOP = "s.myshopify.com";

  function makeDb(existing: { keyword: string }[], group?: { locale: string } | null) {
    const create = vi.fn(async (_args: any) => ({ id: "new-id" }));
    const membershipCreate = vi.fn(async (_args: any) => ({}));
    const q = quotaFakes();
    const db = {
      seoKeyword: {
        findMany: vi.fn(async (_args: any) => existing),
        count: q.keywordCount,
        create,
      },
      seoKeywordGroup: { findFirst: vi.fn(async (_args: any) => group ?? null) },
      seoKeywordGroupMembership: { create: membershipCreate },
      aISettings: q.aISettings,
    } as any;
    return { db, create, membershipCreate };
  }

  it("numbers from 1 when the language has no placeholders yet", async () => {
    const { db, create } = makeDb([]);
    const result = await createKeyword(db, SHOP, { groupId: null, locale: "" });
    expect(result).toEqual({ ok: true, keywordId: "new-id", keyword: "keyword 1" });
    expect(create).toHaveBeenCalledWith({
      data: { shop: SHOP, keyword: "keyword 1", locale: "" },
      select: { id: true },
    });
  });

  it("reuses the lowest FREE number rather than counting ever upwards", async () => {
    // "keyword 2" was deleted — the next row takes that slot back.
    const { db, create } = makeDb([{ keyword: "keyword 1" }, { keyword: "keyword 3" }]);
    const result = await createKeyword(db, SHOP, { groupId: null, locale: "" });
    expect(result).toMatchObject({ ok: true, keyword: "keyword 2" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ keyword: "keyword 2" }) }),
    );
  });

  it("ignores real keywords that merely start with the stem", async () => {
    const { db } = makeDb([{ keyword: "keyword tool vergleich" }, { keyword: "keyword 1" }]);
    const result = await createKeyword(db, SHOP, { groupId: null, locale: "" });
    expect(result).toMatchObject({ keyword: "keyword 2" });
  });

  it("takes the locale from the GROUP, not from the caller (§3.1)", async () => {
    const { db, create, membershipCreate } = makeDb([], { locale: "fr" });
    const result = await createKeyword(db, SHOP, { groupId: "g1", locale: "de" });
    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ locale: "fr" }) }),
    );
    expect(membershipCreate).toHaveBeenCalledWith({
      data: { shop: SHOP, groupId: "g1", keywordId: "new-id" },
    });
  });

  it("is shop-scoped: an unknown or foreign group creates nothing", async () => {
    const { db, create } = makeDb([], null);
    const result = await createKeyword(db, SHOP, { groupId: "foreign", locale: "" });
    expect(result).toEqual({ ok: false, reason: "notFound" });
    expect(create).not.toHaveBeenCalled();
  });

  it("recomputes the number when another writer took it (unique-key race)", async () => {
    const { db } = makeDb([]);
    let calls = 0;
    db.seoKeyword.findMany = vi.fn(async (_args: any) =>
      calls++ === 0 ? [] : [{ keyword: "keyword 1" }],
    );
    db.seoKeyword.create = vi.fn(async (args: any) => {
      if (args.data.keyword === "keyword 1") throw Object.assign(new Error("dup"), { code: "P2002" });
      return { id: "new-id" };
    });
    const result = await createKeyword(db, SHOP, { groupId: null, locale: "" });
    expect(result).toMatchObject({ ok: true, keyword: "keyword 2" });
  });
});

describe("renameKeyword — inline rename never merges", () => {
  const SHOP = "s.myshopify.com";

  function makeDb(row: any, clash: any = null) {
    const update = vi.fn(async (_args: any) => ({}));
    let call = 0;
    const db = {
      seoKeyword: {
        // First findFirst resolves the row, second looks for a collision.
        findFirst: vi.fn(async (_args: any) => (call++ === 0 ? row : clash)),
        update,
      },
    } as any;
    return { db, update };
  }

  it("normalizes before writing", async () => {
    const { db, update } = makeDb({ id: "kw1", keyword: "alt", locale: "" });
    const result = await renameKeyword(db, SHOP, "kw1", "  Blaue   SCHUHE ");
    expect(result).toEqual({ ok: true, keywordId: "kw1", keyword: "blaue schuhe" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "kw1" },
      data: { keyword: "blaue schuhe" },
    });
  });

  it("treats an edit that normalizes back to the same text as a no-op success", async () => {
    const { db, update } = makeDb({ id: "kw1", keyword: "blaue schuhe", locale: "" });
    const result = await renameKeyword(db, SHOP, "kw1", "Blaue Schuhe ");
    expect(result).toMatchObject({ ok: true, keyword: "blaue schuhe" });
    expect(update).not.toHaveBeenCalled();
  });

  it("REJECTS a rename onto a keyword the language already has", async () => {
    const { db, update } = makeDb({ id: "kw1", keyword: "alt", locale: "" }, { id: "kw2" });
    const result = await renameKeyword(db, SHOP, "kw1", "neu");
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a lost unique-key race as a duplicate, not a crash", async () => {
    const { db } = makeDb({ id: "kw1", keyword: "alt", locale: "" });
    db.seoKeyword.update = vi.fn(async () => {
      throw Object.assign(new Error("dup"), { code: "P2002" });
    });
    await expect(renameKeyword(db, SHOP, "kw1", "neu")).resolves.toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("rejects empty and over-long text without touching the DB", async () => {
    const { db, update } = makeDb({ id: "kw1", keyword: "alt", locale: "" });
    expect(await renameKeyword(db, SHOP, "kw1", "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(await renameKeyword(db, SHOP, "kw1", "x".repeat(121))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("is shop-scoped: an unknown or foreign id renames nothing", async () => {
    const { db, update } = makeDb(null);
    expect(await renameKeyword(db, SHOP, "foreign", "neu")).toEqual({
      ok: false,
      reason: "notFound",
    });
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * Cannibalization (§7.1). These moved here when the intent classifier was
 * removed — they lived in that feature's test file only because §7 covered
 * both topics, and deleting it would have left the invariant uncovered.
 */
describe("findCannibalizationConflicts", () => {
  const row = (
    keywordId: string,
    keyword: string,
    resourceType: string,
    resourceId: string,
    role: "primary" | "secondary",
  ): KeywordAssignmentRow => ({
    id: `${keywordId}:${resourceId}`,
    keywordId,
    resourceType,
    resourceId,
    keyword,
    locale: "",
    role,
    priority: 2,
    gscPosition: null,
    gscClicks: null,
    gscImpressions: null,
    gscCtr: null,
    updatedAt: new Date(0),
  });

  it("flags the same keyword primary on two items of the SAME type", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Product", "p2", "primary"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resourceIds.sort()).toEqual(["p1", "p2"]);
  });

  it("does NOT flag Product vs. Collection sharing a primary (plan §7.1)", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Collection", "c1", "primary"),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("ignores secondary assignments entirely", () => {
    const conflicts = findCannibalizationConflicts([
      row("kw1", "vases", "Product", "p1", "primary"),
      row("kw1", "vases", "Product", "p2", "secondary"),
    ]);
    expect(conflicts).toEqual([]);
  });
});

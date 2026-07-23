import { describe, it, expect, vi } from "vitest";
import {
  analyzeOnPage,
  analyzeMultiKeyword,
  normalizeKeyword,
  assignKeyword,
  removeAssignment,
  listAssignments,
  MAX_KEYWORDS_PER_ITEM,
  buildTranslatedContentInput,
  type TranslationRow,
} from "~/services/seo/keywords.service";

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
  } = {}) {
    const keywordRow = overrides.keywordRow ?? { id: "kw1", keyword: "blue shoes", locale: "" };
    const tx = {
      seoKeyword: {
        upsert: vi.fn(async (_args: any) => keywordRow),
        delete: vi.fn(async (_args: any) => ({})),
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
    const db = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
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

  it("setGroupPriority refuses foreign groups and invalid priorities", async () => {
    const { setGroupPriority } = await import("~/services/seo/keywords.service");
    const updateMany = vi.fn(async (_args: any) => ({ count: 3 }));
    const findFirst = vi.fn(async (_args: any): Promise<any> => null);
    const db = { seoKeywordGroup: { findFirst }, seoKeyword: { updateMany } } as any;
    // Unknown/foreign group → 0, no write.
    expect(await setGroupPriority(db, SHOP, "foreign", 1)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    // Invalid priority → 0 without even the ownership lookup write.
    expect(await setGroupPriority(db, SHOP, "g1", 7)).toBe(0);
    // Owned group → shop-scoped updateMany via the membership relation.
    findFirst.mockResolvedValueOnce({ id: "g1" });
    expect(await setGroupPriority(db, SHOP, "g1", 1)).toBe(3);
    expect(updateMany.mock.calls[0][0].where).toEqual({ shop: SHOP, groups: { some: { groupId: "g1" } } });
  });

  it("listAssignments flattens the keyword join into rows (incl. locale + role)", async () => {
    const rows = [
      {
        id: "a1", resourceType: "Product", resourceId: "p1", role: "primary",
        gscPosition: null, gscClicks: null, gscImpressions: null, gscCtr: null,
        keyword: { id: "kw1", keyword: "widget", locale: "", priority: 2, intent: null, updatedAt: new Date() },
      },
      {
        id: "a2", resourceType: "Product", resourceId: "p1", role: "secondary",
        gscPosition: 3.2, gscClicks: 5, gscImpressions: 100, gscCtr: 0.05,
        keyword: { id: "kw2", keyword: "gadget", locale: "fr", priority: 1, intent: "commercial", updatedAt: new Date() },
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
        createMany,
      },
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
      seoKeyword: { findMany: vi.fn(async (_args: any) => []), createMany },
      seoKeywordGroupMembership: { findMany: vi.fn(async (_args: any) => []), createMany: vi.fn() },
    } as any;

    const result = await addKeywordsToGroup(db, SHOP, "foreign", [{ keyword: "widget" }]);
    expect(result).toEqual({ added: 0, alreadyInGroup: 0 });
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
      { id: "kw2", keyword: "zebra", locale: "", priority: 1, intent: null, _count: { assignments: 4 } },
      { id: "kw1", keyword: "apple", locale: "", priority: 1, intent: "info", _count: { assignments: 0 } },
    ]);
    const db = { seoKeyword: { findMany } } as any;

    const rows = await listUngrouped(db, SHOP);
    expect(findMany.mock.calls[0][0].where).toEqual({ shop: SHOP, locale: "", groups: { none: {} } });
    // Same sort as getGroupKeywords: priority asc, then keyword asc.
    expect(rows.map((r) => r.keyword)).toEqual(["apple", "zebra"]);
    expect(rows[0]).toEqual({ keywordId: "kw1", keyword: "apple", locale: "", priority: 1, intent: "info", assignmentCount: 0 });
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

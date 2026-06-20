/**
 * Unit tests for the direct translation service ("Direktübersetzungen").
 * No real DB needed — Prisma is mocked.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeSource,
  sourceHash,
  getDictionary,
  createItem,
  updateItemSource,
  setTranslation,
  aiAutoTranslateItems,
  isCollectibleString,
  recordCandidates,
} from "~/services/direct-translation.server";

describe("normalizeSource()", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSource("  Write   a\n review ")).toBe("Write a review");
    expect(normalizeSource("\t\nHello\tWorld\n")).toBe("Hello World");
  });
});

describe("sourceHash()", () => {
  it("is deterministic and content-sensitive", () => {
    const a = sourceHash("Write a review");
    const b = sourceHash("Write a review");
    const c = sourceHash("Add to cart");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("getDictionary()", () => {
  it("flattens item→translation for the locale and returns the version + collect", async () => {
    const db = {
      directTranslationSettings: {
        findUnique: vi.fn().mockResolvedValue({ shop: "s", collect: true, version: 7, updatedAt: new Date() }),
      },
      directTranslationItem: {
        findMany: vi.fn().mockResolvedValue([
          { sourceText: "Write a review", translations: [{ targetText: "Bewertung schreiben" }] },
          { sourceText: "Add to cart", translations: [{ targetText: "In den Warenkorb" }] },
          { sourceText: "No translation yet", translations: [] },
        ]),
      },
    } as never;

    const dict = await getDictionary(db, "s", "de");
    expect(dict.version).toBe(7);
    expect(dict.collect).toBe(true);
    expect(dict.entries["Write a review"]).toBe("Bewertung schreiben");
    expect(dict.entries["Add to cart"]).toBe("In den Warenkorb");
    expect(dict.entries["No translation yet"]).toBeUndefined();
  });
});

describe("createItem()", () => {
  it("normalizes the source, upserts on the stable hash, and bumps the version", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "x", sourceText: "Write a review", translations: [] });
    const settingsUpsert = vi.fn().mockResolvedValue({});
    const db = {
      directTranslationItem: { upsert },
      directTranslationSettings: { upsert: settingsUpsert },
    } as never;

    await createItem(db, "s", "  Write   a review  ");

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.shop_sourceHash.sourceHash).toBe(sourceHash("Write a review"));
    expect(arg.create.sourceText).toBe("Write a review"); // normalized
    expect(settingsUpsert).toHaveBeenCalledTimes(1); // version bump
  });

  it("rejects empty source", async () => {
    const db = { directTranslationItem: { upsert: vi.fn() }, directTranslationSettings: { upsert: vi.fn() } } as never;
    await expect(createItem(db, "s", "   ")).rejects.toThrow(/empty/i);
  });
});

describe("updateItemSource()", () => {
  it("rehashes and keeps translations (FK on item id), bumps version", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const settingsUpsert = vi.fn().mockResolvedValue({});
    const db = {
      directTranslationItem: { updateMany },
      directTranslationSettings: { upsert: settingsUpsert },
    } as never;

    await updateItemSource(db, "s", "item1", "  New   source ");
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "item1", shop: "s" });
    expect(arg.data.sourceText).toBe("New source");
    expect(arg.data.sourceHash).toBe(sourceHash("New source"));
    expect(settingsUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("setTranslation()", () => {
  it("guards tenant isolation and upserts on (itemId, locale)", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "item1" });
    const upsert = vi.fn().mockResolvedValue({ id: "t1", itemId: "item1", locale: "de", targetText: "x", source: "user" });
    const settingsUpsert = vi.fn().mockResolvedValue({});
    const db = {
      directTranslationItem: { findFirst },
      directTranslation: { upsert },
      directTranslationSettings: { upsert: settingsUpsert },
    } as never;

    await setTranslation(db, "s", "item1", "de", "Bewertung", "user");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].where.itemId_locale).toEqual({ itemId: "item1", locale: "de" });
    expect(settingsUpsert).toHaveBeenCalledTimes(1);
  });

  it("throws when the item does not belong to the shop", async () => {
    const db = {
      directTranslationItem: { findFirst: vi.fn().mockResolvedValue(null) },
      directTranslation: { upsert: vi.fn() },
      directTranslationSettings: { upsert: vi.fn() },
    } as never;
    await expect(setTranslation(db, "s", "item1", "de", "x")).rejects.toThrow(/not found/i);
  });
});

describe("aiAutoTranslateItems()", () => {
  function mkDb() {
    const findFirst = vi.fn().mockResolvedValue({ id: "ok" });
    const upsert = vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: create.itemId + ":" + create.locale, ...create }));
    return {
      db: {
        directTranslationItem: { findFirst },
        directTranslation: { upsert },
        directTranslationSettings: { upsert: vi.fn() },
      } as never,
      upsert,
    };
  }

  it("translates each item into one locale, persists source:'ai', skips empties", async () => {
    const { db, upsert } = mkDb();
    // third source comes back empty → skipped (would otherwise wipe a row)
    const translateBatch = vi.fn().mockResolvedValue(["Bewertung schreiben", "In den Warenkorb", ""]);

    const rows = await aiAutoTranslateItems(
      db,
      "s",
      {
        items: [
          { id: "i1", sourceText: "Write a review" },
          { id: "i2", sourceText: "Add  to cart" },
          { id: "i3", sourceText: "Unrendered" },
        ],
        locales: ["de"],
      },
      translateBatch,
    );

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0][0]).toEqual(["Write a review", "Add to cart", "Unrendered"]);
    expect(translateBatch.mock.calls[0][1]).toBe("auto"); // auto-detect mode
    expect(rows).toHaveLength(2);
    expect(upsert.mock.calls.every((c) => c[0].create.source === "ai")).toBe(true);
  });

  it("persists same-as-source 1:1 when target locale matches detected source", async () => {
    const { db, upsert } = mkDb();
    // AI returns source unchanged (target locale = detected source language).
    const translateBatch = vi.fn().mockResolvedValue(["Write a review"]);

    const rows = await aiAutoTranslateItems(
      db,
      "s",
      { items: [{ id: "i1", sourceText: "Write a review" }], locales: ["en"] },
      translateBatch,
    );

    expect(rows).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.targetText).toBe("Write a review");
  });

  it("chunks large inputs per locale and reports progress", async () => {
    const { db } = mkDb();
    const items = Array.from({ length: 120 }, (_v, i) => ({ id: "i" + i, sourceText: "label-" + i }));
    const translateBatch = vi.fn().mockImplementation((vals: string[]) => Promise.resolve(vals.map((v) => v + "-de")));
    const progress: number[] = [];

    const rows = await aiAutoTranslateItems(
      db,
      "s",
      { items, locales: ["de"] },
      translateBatch,
      (done) => { progress.push(done); },
    );

    expect(translateBatch).toHaveBeenCalledTimes(3); // 50 / 50 / 20
    expect(translateBatch.mock.calls[2][0]).toHaveLength(20);
    expect(rows).toHaveLength(120);
    expect(progress).toEqual([50, 100, 120]);
  });

  it("translates into multiple locales", async () => {
    const { db, upsert } = mkDb();
    const translateBatch = vi.fn().mockImplementation((vals: string[], _f: string, to: string) =>
      Promise.resolve(vals.map((v) => v + "-" + to)),
    );
    const rows = await aiAutoTranslateItems(
      db,
      "s",
      { items: [{ id: "i1", sourceText: "Hi" }], locales: ["de", "fr"] },
      translateBatch,
    );
    expect(rows).toHaveLength(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe("isCollectibleString()", () => {
  it("accepts short UI labels", () => {
    expect(isCollectibleString("Write a review")).toBe(true);
    expect(isCollectibleString("Verified buyer")).toBe(true);
  });
  it("rejects prices, emails, urls, phone, numeric and too-long strings", () => {
    expect(isCollectibleString("$19.99")).toBe(false);
    expect(isCollectibleString("19,99 €")).toBe(false);
    expect(isCollectibleString("john@example.com")).toBe(false);
    expect(isCollectibleString("https://example.com")).toBe(false);
    expect(isCollectibleString("+1 (555) 123-4567")).toBe(false);
    expect(isCollectibleString("12345")).toBe(false);
    expect(isCollectibleString("a")).toBe(false);
    expect(isCollectibleString("x".repeat(101))).toBe(false);
  });
});

describe("recordCandidates()", () => {
  it("filters non-collectible, skips existing items, upserts the rest", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const count = vi.fn().mockResolvedValue(0);
    const itemFindMany = vi.fn().mockResolvedValue([]); // no existing items
    const db = {
      directTranslationItem: { findMany: itemFindMany },
      directTranslationCandidate: { upsert, count, findMany: vi.fn(), deleteMany: vi.fn() },
    } as never;

    const recorded = await recordCandidates(db, "s", [
      { text: "Write a review" },
      { text: "$19.99" }, // filtered
      { text: "Add to cart" },
      { text: "  " }, // filtered
    ]);

    expect(recorded).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    // upsert update branch must NOT touch status (rejected stays rejected)
    expect(upsert.mock.calls[0][0].update.status).toBeUndefined();
  });

  it("skips strings that already exist as items", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const db = {
      directTranslationItem: {
        findMany: vi.fn().mockResolvedValue([{ sourceHash: sourceHash("Add to cart") }]),
      },
      directTranslationCandidate: { upsert, count: vi.fn().mockResolvedValue(0), findMany: vi.fn(), deleteMany: vi.fn() },
    } as never;

    const recorded = await recordCandidates(db, "s", [{ text: "Add to cart" }, { text: "Write a review" }]);
    expect(recorded).toBe(1); // only "Write a review"
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.sourceText).toBe("Write a review");
  });
});

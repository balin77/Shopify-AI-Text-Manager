/**
 * Unit tests for the dynamic storefront translation service.
 * No real DB needed — Prisma is mocked.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeSource,
  sourceHash,
  getDictionary,
  upsertDynamicTranslation,
  aiAutoTranslate,
} from "~/services/dynamic-translation.server";

describe("normalizeSource()", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSource("  Write   a\n review ")).toBe("Write a review");
    expect(normalizeSource("\t\nHello\tWorld\n")).toBe("Hello World");
  });
});

describe("sourceHash()", () => {
  it("is deterministic and scope-sensitive", () => {
    const a = sourceHash("Write a review", "global");
    const b = sourceHash("Write a review", "global");
    const c = sourceHash("Write a review", "template:product");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("getDictionary()", () => {
  it("groups entries by scope and returns the version", async () => {
    const db = {
      dynamicTranslationSettings: {
        findUnique: vi.fn().mockResolvedValue({ shop: "s", enabled: true, version: 7, updatedAt: new Date() }),
      },
      dynamicTranslation: {
        findMany: vi.fn().mockResolvedValue([
          { sourceText: "Write a review", targetText: "Bewertung schreiben", scope: "global" },
          { sourceText: "Add to cart", targetText: "In den Warenkorb", scope: "template:product" },
        ]),
      },
    } as never;

    const dict = await getDictionary(db, "s", "de");
    expect(dict.version).toBe(7);
    expect(dict.enabled).toBe(true);
    expect(dict.entries.global["Write a review"]).toBe("Bewertung schreiben");
    expect(dict.entries["template:product"]["Add to cart"]).toBe("In den Warenkorb");
  });
});

describe("upsertDynamicTranslation()", () => {
  it("normalizes the source, upserts on the stable key, and bumps the version", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "x", locale: "de", scope: "global", sourceText: "Write a review", targetText: "Bewertung schreiben", source: "user",
    });
    const settingsUpsert = vi.fn().mockResolvedValue({});
    const db = {
      dynamicTranslation: { upsert },
      dynamicTranslationSettings: { upsert: settingsUpsert },
    } as never;

    await upsertDynamicTranslation(db, "s", { locale: "de", sourceText: "  Write   a review  ", targetText: "Bewertung schreiben" });

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.shop_locale_scope_sourceHash.sourceHash).toBe(sourceHash("Write a review", "global"));
    expect(arg.create.sourceText).toBe("Write a review"); // normalized
    // version bump
    expect(settingsUpsert).toHaveBeenCalledTimes(1);
  });

  it("rejects empty source", async () => {
    const db = { dynamicTranslation: { upsert: vi.fn() }, dynamicTranslationSettings: { upsert: vi.fn() } } as never;
    await expect(
      upsertDynamicTranslation(db, "s", { locale: "de", sourceText: "   ", targetText: "x" }),
    ).rejects.toThrow(/empty/i);
  });
});

describe("aiAutoTranslate()", () => {
  it("normalizes + de-dupes sources, batches once, persists AI pairs, skips no-ops", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: create.sourceText, ...create }));
    const db = {
      dynamicTranslation: { upsert },
      dynamicTranslationSettings: { upsert: vi.fn() },
    } as never;

    // "Add to cart" duplicated (raw + whitespace variant) → one source.
    // Third source comes back empty from the model → skipped.
    const translateBatch = vi.fn().mockResolvedValue(["Bewertung schreiben", "In den Warenkorb", ""]);

    const rows = await aiAutoTranslate(
      db,
      "s",
      { locale: "de", fromLang: "en", sources: ["Write a review", "Add  to cart", "Add to cart", "Unrendered"] },
      translateBatch,
    );

    // de-duped to 3 unique normalized sources
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0][0]).toEqual(["Write a review", "Add to cart", "Unrendered"]);
    expect(translateBatch.mock.calls[0][1]).toBe("en");
    expect(translateBatch.mock.calls[0][2]).toBe("de");

    // empty translation skipped → 2 persisted, all source:"ai"
    expect(rows).toHaveLength(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.every((c) => c[0].create.source === "ai")).toBe(true);
  });

  it("returns nothing when there are no usable sources", async () => {
    const db = { dynamicTranslation: { upsert: vi.fn() }, dynamicTranslationSettings: { upsert: vi.fn() } } as never;
    const translateBatch = vi.fn();
    const rows = await aiAutoTranslate(db, "s", { locale: "de", fromLang: "en", sources: ["   ", ""] }, translateBatch);
    expect(rows).toEqual([]);
    expect(translateBatch).not.toHaveBeenCalled();
  });
});

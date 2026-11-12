/**
 * Per-entry verification of a package answer (PLAN_BULK_TRANSLATE_BATCHING 3.1).
 */
import { describe, it, expect } from "vitest";
import { judgePackageAnswer, verifyTranslation } from "~/services/bulk-editor/translate-package-verify.shared";
import { buildPackageItems, type PackageEntry } from "~/services/bulk-editor/translate-packages.shared";

const v = (over: Partial<Parameters<typeof verifyTranslation>[0]>) =>
  verifyTranslation({ kind: "short", source: "Wool scarf", translation: "Echarpe en laine", strictNumbers: true, ...over });

describe("verifyTranslation", () => {
  it("passes an ordinary translation", () => {
    expect(v({})).toBeNull();
  });
  it("missing / non-string / blank", () => {
    expect(v({ translation: undefined })).toBe("missing");
    expect(v({ translation: 12 })).toBe("missing");
    expect(v({ translation: "   " })).toBe("empty");
  });
  it("a line break in a single-line kind is rejected; allowed for long", () => {
    expect(v({ translation: "Echarpe\nlaine" })).toBe("newline");
    expect(v({ kind: "value", translation: "a\nb" })).toBe("newline");
    expect(v({ kind: "long", source: "a\nb", translation: "c\nd" })).toBeNull();
  });
  it("an absurdly long answer for a short label is rejected", () => {
    expect(v({ translation: "x".repeat(200) })).toBe("length");
  });
  it("protected tokens must survive exactly", () => {
    expect(v({ source: "Hello {{ name }}", translation: "Bonjour {{ nom }}" })).toBe("protectedTokens");
    expect(v({ source: "Hello {{ name }}", translation: "Bonjour {{ name }}" })).toBeNull();
    expect(v({ source: "%s items", translation: "articles" })).toBe("protectedTokens");
    expect(v({ source: "See [shortcode id=1]", translation: "Voir [shortcode id=1]" })).toBeNull();
  });
  it("numbers: a swapped entry is caught in a multi-item package, not in a single answer", () => {
    expect(v({ source: "Pack of 3", translation: "Lot de 6" })).toBe("numbers");
    expect(v({ source: "Pack of 3", translation: "Dreierpack", strictNumbers: true })).toBe("numbers");
    expect(v({ source: "Pack of 3", translation: "Dreierpack", strictNumbers: false })).toBeNull();
    // Decimal separators differ by language: the digit runs are what counts.
    expect(v({ source: "1.5 l", translation: "1,5 l" })).toBeNull();
  });
  it("SKU-like tokens must be kept", () => {
    expect(v({ source: "Model AB-123-X", translation: "Modele AB-124-X" })).toBe("numbers");
  });
  it("a long unchanged paragraph is an echo; a short identical value is fine", () => {
    const paragraph = "word ".repeat(60);
    expect(v({ kind: "long", source: paragraph, translation: paragraph })).toBe("echo");
    expect(v({ source: "Hotel", translation: "Hotel" })).toBeNull();
  });
  it("HTML skeleton: same tags, same href/src/id/class", () => {
    const src = '<p class="a">Hello <a href="/x">link</a></p>';
    expect(v({ kind: "long", source: src, translation: '<p class="a">Bonjour <a href="/x">lien</a></p>' })).toBeNull();
    expect(v({ kind: "long", source: src, translation: '<p class="a">Bonjour <a href="/y">lien</a></p>' })).toBe("htmlSkeleton");
    expect(v({ kind: "long", source: src, translation: "<p class=\"a\">Bonjour lien</p>" })).toBe("htmlSkeleton");
    expect(v({ kind: "long", source: src, translation: '<div class="a">Bonjour <a href="/x">lien</a></div>' })).toBe("htmlSkeleton");
  });
  it("non-HTML multi-line text keeps its line count", () => {
    expect(v({ kind: "long", source: "a\nb\nc", translation: "x\ny" })).toBe("lineCount");
    expect(v({ kind: "long", source: "a\nb", translation: "x\ny" })).toBeNull();
  });
});

describe("judgePackageAnswer", () => {
  const entries: PackageEntry[] = [
    { owner: "a", kind: "short", fieldKey: "title", source: "Wool scarf", locales: ["fr", "es"] },
    { owner: "b", kind: "short", fieldKey: "title", source: "Cap 3", locales: ["fr", "es"] },
  ];
  const items = buildPackageItems(entries);
  const idOf = new Map(items.map((item, i) => [item.key, `k${i + 1}`]));

  it("accepts per item and per language; a missing id or locale rejects only that part", () => {
    const verdicts = judgePackageAnswer(items, idOf, {
      k1: { fr: "Echarpe", es: "Bufanda" },
      k2: { fr: "Bonnet 3" },
    });
    expect(verdicts.get(items[0].key)!.accepted).toEqual({ fr: "Echarpe", es: "Bufanda" });
    expect(verdicts.get(items[1].key)!.accepted).toEqual({ fr: "Bonnet 3" });
    expect(verdicts.get(items[1].key)!.rejected).toEqual({ es: "missing" });
  });

  it("ignores extra ids and extra locales (never written)", () => {
    const verdicts = judgePackageAnswer(items, idOf, {
      k1: { fr: "Echarpe", es: "Bufanda", de: "Schal" },
      k2: { fr: "Bonnet 3", es: "Gorro 3" },
      k99: { fr: "ghost" },
    });
    expect(Object.keys(verdicts.get(items[0].key)!.accepted).sort()).toEqual(["es", "fr"]);
    expect([...verdicts.keys()]).toEqual(items.map((i) => i.key));
  });

  it("entries that swapped their answers are caught by the number check", () => {
    const verdicts = judgePackageAnswer(items, idOf, {
      k1: { fr: "Bonnet 3", es: "Gorro 3" },
      k2: { fr: "Echarpe", es: "Bufanda" },
    });
    expect(Object.keys(verdicts.get(items[0].key)!.rejected).sort()).toEqual(["es", "fr"]);
    expect(Object.keys(verdicts.get(items[1].key)!.rejected).sort()).toEqual(["es", "fr"]);
  });

  it("a non-object answer rejects everything as missing", () => {
    const verdicts = judgePackageAnswer(items, idOf, ["not", "an", "object"]);
    expect(Object.keys(verdicts.get(items[0].key)!.accepted)).toEqual([]);
    expect(verdicts.get(items[0].key)!.rejected).toEqual({ fr: "missing", es: "missing" });
  });
});

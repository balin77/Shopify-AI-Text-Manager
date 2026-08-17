import { describe, it, expect } from "vitest";
import {
  keywordsMissingFrom,
  keywordTranslationDirective,
  keywordTranslationDirectiveMulti,
  type LocaleKeywords,
} from "~/services/seo/keyword-translation-prompt";

/**
 * Keyword-aware translation. The two rules worth pinning down are that a
 * language never receives another language's keyword, and that a language
 * tracking nothing produces no clause at all — that is what keeps the previous
 * literal behaviour intact for every shop that does not use per-locale
 * keywords.
 */

const fr: LocaleKeywords = {
  locale: "fr",
  localeName: "French",
  primary: "vase en céramique",
  secondaries: ["vase fait main"],
};
const es: LocaleKeywords = {
  locale: "es",
  localeName: "Spanish",
  primary: "jarrón de cerámica",
  secondaries: [],
};
const noKeywords: LocaleKeywords = { locale: "it", localeName: "Italian", primary: null, secondaries: [] };

describe("keywordTranslationDirective (one language per call)", () => {
  it("names the target keyword and forbids appending", () => {
    const out = keywordTranslationDirective(fr);
    expect(out).toContain('"vase en céramique"');
    expect(out).toContain("French");
    expect(out).toContain("ONCE");
    expect(out).toContain("not by appending a sentence");
  });

  it("offers the secondaries as optional, capped at one per sentence", () => {
    const out = keywordTranslationDirective(fr);
    expect(out).toContain('"vase fait main"');
    expect(out).toContain("never more than one per sentence");
  });

  it("says nothing at all for a language without a primary keyword", () => {
    expect(keywordTranslationDirective(noKeywords)).toBe("");
  });

  it("leaves the translation alone when the keyword cannot be used", () => {
    expect(keywordTranslationDirective(es)).toContain("without distorting the meaning");
  });
});

describe("keywordTranslationDirectiveMulti (every language in one call)", () => {
  it("lists one line per language that has keywords", () => {
    const out = keywordTranslationDirectiveMulti([fr, es, noKeywords]);
    expect(out).toContain('- French (fr): "vase en céramique", "vase fait main"');
    expect(out).toContain('- Spanish (es): "jarrón de cerámica"');
  });

  it("omits languages without keywords rather than listing them empty", () => {
    const out = keywordTranslationDirectiveMulti([fr, noKeywords]);
    expect(out).not.toContain("Italian");
  });

  it("forbids carrying a keyword into a language it is not listed for", () => {
    expect(keywordTranslationDirectiveMulti([fr, es])).toContain(
      "never carry a keyword into a language it is not listed for",
    );
  });

  it("is empty when no language tracks anything", () => {
    expect(keywordTranslationDirectiveMulti([noKeywords])).toBe("");
    expect(keywordTranslationDirectiveMulti([])).toBe("");
  });
});

describe("keywordsMissingFrom", () => {
  it("reports a keyword the source text already carries as NOT missing", () => {
    expect(keywordsMissingFrom("Eine schöne Keramikvase für den Flur", ["keramikvase"])).toEqual([]);
  });

  it("reports a keyword the source text lacks", () => {
    expect(keywordsMissingFrom("Eine schöne Vase", ["keramikvase"])).toEqual(["keramikvase"]);
  });

  it("uses word boundaries — a substring hit does not count as present", () => {
    // "tee" inside "Garantee" must not mask a genuinely missing keyword.
    expect(keywordsMissingFrom("Mit Garantee geliefert", ["tee"])).toEqual(["tee"]);
  });

  it("treats every keyword as missing when there is no source text", () => {
    expect(keywordsMissingFrom("   ", ["a", "b"])).toEqual(["a", "b"]);
  });
});

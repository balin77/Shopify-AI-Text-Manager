/**
 * Readability analysis — pure logic.
 *
 * The rule with the most weight is the one about NOT printing a number: a
 * reading-ease score computed with English coefficients over another language
 * is a wrong number wearing a familiar name, so unsupported locales must return
 * null rather than something plausible-looking.
 */

import { describe, it, expect } from "vitest";
import {
  analyzeReadability,
  textBlocks,
  hasReadingEaseFormula,
  baseLanguage,
  MIN_WORDS_FOR_ANALYSIS,
  LONG_SENTENCE_WORDS,
} from "~/utils/readability";

/** n words of simple prose, split into sentences of `per` words. */
function prose(n: number, per = 8): string {
  const out: string[] = [];
  for (let i = 0; i < n; i += per) {
    out.push(Array.from({ length: Math.min(per, n - i) }, () => "wort").join(" ") + ".");
  }
  return `<p>${out.join(" ")}</p>`;
}

describe("textBlocks", () => {
  it("splits on block tags and keeps inline markup out of the text", () => {
    const blocks = textBlocks("<p>Erster <strong>Satz</strong> hier.</p><p>Zweiter Absatz.</p>");
    expect(blocks).toEqual(["Erster Satz hier.", "Zweiter Absatz."]);
  });

  it("drops script/style content entirely", () => {
    expect(textBlocks("<p>Text</p><script>var a = 1;</script>")).toEqual(["Text"]);
  });

  it("decodes the entities a rich-text editor emits", () => {
    expect(textBlocks("<p>a&nbsp;b &amp; c</p>")).toEqual(["a b & c"]);
  });
});

describe("analyzeReadability — structure", () => {
  it("says nothing about copy that is too short to judge", () => {
    const report = analyzeReadability("<p>Kurzer Text.</p>", "de");
    expect(report.tooShort).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.words).toBeLessThan(MIN_WORDS_FOR_ANALYSIS);
  });

  it("counts words, sentences and paragraphs", () => {
    const report = analyzeReadability("<p>Eins zwei drei.</p><p>Vier fünf.</p>", "de");
    expect(report.words).toBe(5);
    expect(report.sentences).toBe(2);
    expect(report.paragraphs).toBe(2);
    expect(report.avgSentenceWords).toBe(2.5);
  });

  it("flags long sentences only once they are the majority pattern", () => {
    // One long sentence among many short ones is not a finding.
    const mostlyShort = prose(80, 5) + `<p>${"wort ".repeat(LONG_SENTENCE_WORDS + 5)}.</p>`;
    expect(analyzeReadability(mostlyShort, "de").findings.map((f) => f.code)).not.toContain(
      "longSentences",
    );

    const mostlyLong = Array.from(
      { length: 4 },
      () => `<p>${"wort ".repeat(LONG_SENTENCE_WORDS + 5)}.</p>`,
    ).join("");
    const report = analyzeReadability(mostlyLong, "de");
    expect(report.findings.map((f) => f.code)).toContain("longSentences");
    expect(report.longSentences).toBe(4);
    // The data keys ARE the i18n placeholders: a rename here leaves "{sentences}"
    // rendered literally in the sidebar.
    expect(Object.keys(report.findings.find((f) => f.code === "longSentences")!.data!).sort()).toEqual(
      ["count", "limit", "sentences"],
    );
  });

  it("flags a wall of text", () => {
    const report = analyzeReadability(prose(200, 10), "de");
    expect(report.findings.map((f) => f.code)).toContain("longParagraphs");
    expect(report.longestParagraphWords).toBeGreaterThan(150);
  });

  it("asks for subheadings only in long copy, and not when they exist", () => {
    const long = Array.from({ length: 8 }, () => prose(50, 10)).join("");
    expect(analyzeReadability(long, "de").findings.map((f) => f.code)).toContain("noSubheadings");
    expect(
      analyzeReadability("<h2>Kapitel</h2>" + long, "de").findings.map((f) => f.code),
    ).not.toContain("noSubheadings");
  });
});

describe("analyzeReadability — reading ease", () => {
  it("scores the three languages that have a validated formula", () => {
    for (const locale of ["en", "de-DE", "es-ES"]) {
      const report = analyzeReadability(prose(120, 8), locale);
      expect(report.readingEase).not.toBeNull();
      expect(report.readingEase!).toBeGreaterThanOrEqual(0);
      expect(report.readingEase!).toBeLessThanOrEqual(100);
      expect(report.readingEaseBand).not.toBeNull();
    }
  });

  it("returns null instead of a wrong number for every other language", () => {
    const report = analyzeReadability(prose(120, 8), "fi");
    expect(report.readingEase).toBeNull();
    expect(report.readingEaseFormula).toBeNull();
    expect(report.readingEaseBand).toBeNull();
    // The structural half still works — that is the point of splitting them.
    expect(report.words).toBeGreaterThan(0);
  });

  it("rates short simple sentences as easier than long complex ones", () => {
    const simple = analyzeReadability(
      "<p>" + "Der Hund lief. ".repeat(20) + "</p>",
      "de",
    ).readingEase!;
    const complex = analyzeReadability(
      "<p>" +
        "Die außergewöhnliche Berücksichtigung individueller Kundenanforderungen erforderte umfangreiche organisatorische Vorbereitungen innerhalb komplexer Verwaltungsstrukturen. ".repeat(
          6,
        ) +
        "</p>",
      "de",
    ).readingEase!;
    expect(simple).toBeGreaterThan(complex);
  });

  it("knows which locales it supports", () => {
    expect(hasReadingEaseFormula("de-CH")).toBe(true);
    expect(hasReadingEaseFormula("pt-BR")).toBe(false);
    expect(baseLanguage("es_MX")).toBe("es");
    expect(baseLanguage(null)).toBe("");
  });
});

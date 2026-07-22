import { describe, it, expect } from "vitest";
import { parseKeywordsCsv } from "~/services/seo/keywords-csv";

const LOCALES = new Set(["fr", "en"]);

describe("parseKeywordsCsv", () => {
  it("parses a headered CSV with all four columns", () => {
    const { rows, errors } = parseKeywordsCsv(
      "keyword,priority,intent,locale\nGreen  Vase,1,transactional,fr\nblue vase,,,\n",
      LOCALES,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { keyword: "green vase", priority: 1, intent: "transactional", locale: "fr", csvRow: 2 },
      { keyword: "blue vase", priority: 2, intent: null, locale: "", csvRow: 3 },
    ]);
  });

  it("treats a headerless single-column file as a plain keyword list", () => {
    const { rows } = parseKeywordsCsv("grüne vase\nhandgemachte vase\n", LOCALES);
    expect(rows.map((r) => r.keyword)).toEqual(["grüne vase", "handgemachte vase"]);
  });

  it("supports German ;-delimited files and German headers", () => {
    const { rows } = parseKeywordsCsv("Suchbegriff;Priorität\nkeramik vase;3\n", LOCALES);
    expect(rows).toEqual([{ keyword: "keramik vase", priority: 3, intent: null, locale: "", csvRow: 2 }]);
  });

  it("errors on bad priority / intent / locale without dropping other rows", () => {
    const { rows, errors } = parseKeywordsCsv(
      "keyword,priority,intent,locale\nok keyword,2,commercial,\nbad prio,7,,\nbad intent,,buying,\nbad locale,,,xx\n",
      LOCALES,
    );
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.error).sort()).toEqual(["badIntent", "badLocale", "badPriority"]);
  });

  it("rejects over-long keywords with a tooLong error", () => {
    const { rows, errors } = parseKeywordsCsv(`keyword\n${"x".repeat(200)}\n`, LOCALES);
    expect(rows).toEqual([]);
    expect(errors[0].error).toBe("tooLong");
  });

  it("dedupes identical (keyword, locale) rows within the file", () => {
    const { rows } = parseKeywordsCsv("keyword,locale\nvase,\nVASE,\nvase,fr\n", LOCALES);
    expect(rows).toHaveLength(2);
  });

  it("skips empty lines and returns nothing for an empty file", () => {
    expect(parseKeywordsCsv("", LOCALES)).toEqual({ rows: [], errors: [] });
    expect(parseKeywordsCsv("keyword\n\n\n", LOCALES).rows).toEqual([]);
  });
});

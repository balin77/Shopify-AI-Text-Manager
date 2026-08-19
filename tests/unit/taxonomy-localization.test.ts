/**
 * The parser for Shopify's published taxonomy file, and the two rules that
 * keep a bad import out of the table.
 *
 * The file is the ONLY source for a category name in the merchant's language:
 * the Admin API answers in English and offers no way to ask otherwise
 * (measured twice — no `@inContext` in the schema, `Accept-Language` accepted
 * and ignored). So a parser bug here does not degrade a label, it writes the
 * wrong one — into a table that a derived product type is then built from.
 */

import { describe, it, expect } from "vitest";
import {
  MIN_PLAUSIBLE_ENTRIES,
  needsLocalization,
  parseTaxonomyCategoriesFile,
  taxonomyFolderCandidates,
  taxonomyLocaleFolder,
} from "../../app/services/taxonomy-localization.shared";

const FILE = `# Shopify Product Taxonomy - Categories: 2026-05
# Format: {GID} : {Ancestor name} > ... > {Category name}

gid://shopify/TaxonomyCategory/ap                : Tiere & Tierbedarf
gid://shopify/TaxonomyCategory/ap-1              : Tiere & Tierbedarf > Lebende Tiere
gid://shopify/TaxonomyCategory/hg-3-72           : Heim & Garten > Dekoration > Vasen
`;

describe("parseTaxonomyCategoriesFile", () => {
  it("reads the version out of the header", () => {
    expect(parseTaxonomyCategoriesFile(FILE).version).toBe("2026-05");
  });

  it("keeps the whole path and splits the leaf off it", () => {
    const { entries } = parseTaxonomyCategoriesFile(FILE);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toEqual({
      gid: "gid://shopify/TaxonomyCategory/hg-3-72",
      fullName: "Heim & Garten > Dekoration > Vasen",
      // The leaf is what a derived product type is built from — the whole path
      // would be unusable as a filter value.
      name: "Vasen",
      isLeaf: true,
    });
  });

  it("uses the path itself as the name for a top-level vertical", () => {
    const { entries } = parseTaxonomyCategoriesFile(FILE);
    expect(entries[0]).toEqual({
      gid: "gid://shopify/TaxonomyCategory/ap",
      fullName: "Tiere & Tierbedarf",
      name: "Tiere & Tierbedarf",
      // "…/ap-1" is in the file, so this vertical has a child.
      isLeaf: false,
    });
  });

  it("splits at the FIRST separator, so a colon inside a name survives", () => {
    // Real taxonomy names carry punctuation. Splitting on every " : " would
    // truncate such a category to its first half, silently.
    const { entries } = parseTaxonomyCategoriesFile(
      "gid://shopify/TaxonomyCategory/x-1 : Medien > Bücher : Sachbuch\n",
    );
    expect(entries[0].fullName).toBe("Medien > Bücher : Sachbuch");
    // The leaf keeps its colon too: the LAST ">" ends the path, not the first
    // ":" inside a name.
    expect(entries[0].name).toBe("Bücher : Sachbuch");
  });

  it("skips a line it does not understand rather than guessing at it", () => {
    // A skipped line is one category falling back to the API's English name.
    // A misread line is a category labelled wrong, which nothing would catch.
    const { entries } = parseTaxonomyCategoriesFile(
      [
        "gid://shopify/TaxonomyCategory/ok : Gut",
        "not-a-gid : Etwas",
        "gid://shopify/TaxonomyCategory/nosep Ohne Trenner",
        "gid://shopify/TaxonomyCategory/empty : ",
        "",
      ].join("\n"),
    );
    expect(entries.map((e) => e.gid)).toEqual(["gid://shopify/TaxonomyCategory/ok"]);
  });

  it("returns nothing for an error page served with a 200", () => {
    const { entries } = parseTaxonomyCategoriesFile("<!DOCTYPE html><html>404: Not Found</html>");
    expect(entries).toHaveLength(0);
    // …and that is below the plausibility floor, which is what stops it from
    // replacing a good table.
    expect(entries.length).toBeLessThan(MIN_PLAUSIBLE_ENTRIES);
  });
});

describe("leaf flags", () => {
  it("reads the hierarchy off the GIDs", () => {
    // The file carries no leaf column. Marking every category broad — which is
    // what a blanket default does — prints a marketplace warning over
    // categories it is not true of.
    const { entries } = parseTaxonomyCategoriesFile(
      [
        "gid://shopify/TaxonomyCategory/hg : Heim & Garten",
        "gid://shopify/TaxonomyCategory/hg-3 : Heim & Garten > Dekoration",
        "gid://shopify/TaxonomyCategory/hg-3-72 : Heim & Garten > Dekoration > Vasen",
      ].join("\n"),
    );
    expect(entries.map((e) => [e.gid.split("/").pop(), e.isLeaf])).toEqual([
      ["hg", false],
      ["hg-3", false],
      ["hg-3-72", true],
    ]);
  });

  it("does not read a SIBLING as a parent", () => {
    // "hg-3" and "hg-4" share a prefix but neither contains the other. A
    // prefix test without the dash boundary would call both branches.
    const { entries } = parseTaxonomyCategoriesFile(
      [
        "gid://shopify/TaxonomyCategory/hg-3 : A > B",
        "gid://shopify/TaxonomyCategory/hg-4 : A > C",
      ].join("\n"),
    );
    expect(entries.every((e) => e.isLeaf)).toBe(true);
  });
});

describe("taxonomyFolderCandidates", () => {
  it("falls back from a region to its base language", () => {
    // Shopify publishes dist/fr but no dist/fr-CA. Without the fallback a
    // Canadian-French shop 404s once and is then pinned to English for the
    // whole process, although its language is right there.
    expect(taxonomyFolderCandidates("fr-CA")).toEqual(["fr-CA", "fr"]);
  });

  it("offers a plain language once, not twice", () => {
    expect(taxonomyFolderCandidates("de")).toEqual(["de"]);
  });

  it("offers nothing for something that is not a locale", () => {
    expect(taxonomyFolderCandidates("")).toEqual([]);
  });
});

describe("taxonomyLocaleFolder", () => {
  it("passes a plain language through in lower case", () => {
    expect(taxonomyLocaleFolder("de")).toBe("de");
    expect(taxonomyLocaleFolder("DE")).toBe("de");
  });

  it("spells a region the way the file host does", () => {
    // The folder names are case-sensitive on a raw file host: `pt-br` 404s
    // where `pt-BR` works, and a 404 is remembered as "no file for this
    // language" — a quiet wrong answer for a language that has one.
    expect(taxonomyLocaleFolder("pt-br")).toBe("pt-BR");
    expect(taxonomyLocaleFolder("pt-BR")).toBe("pt-BR");
  });

  it("refuses something that is not a locale", () => {
    expect(taxonomyLocaleFolder("")).toBeNull();
    expect(taxonomyLocaleFolder("   ")).toBeNull();
    expect(taxonomyLocaleFolder("deutsch-ish!")).toBeNull();
  });
});

describe("needsLocalization", () => {
  it("skips English — the API already answers in it", () => {
    // Importing it would be a second copy of one answer, and the copy could
    // drift when Shopify ships a category before the open-data release does.
    expect(needsLocalization("en")).toBe(false);
    expect(needsLocalization("en-GB")).toBe(false);
  });

  it("is on for every other language", () => {
    expect(needsLocalization("de")).toBe(true);
    expect(needsLocalization("pt-BR")).toBe(true);
  });

  it("is off for a locale it cannot spell", () => {
    expect(needsLocalization("")).toBe(false);
  });
});

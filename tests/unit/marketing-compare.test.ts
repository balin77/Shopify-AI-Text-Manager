import { describe, expect, it } from "vitest";
import {
  COMPARE_GROUPS,
  COMPARE_ROWS,
  COMPETITORS,
  comparePath,
  isCompetitorId,
} from "../../app/config/marketing-compare";
import { getCompareCopy } from "../../app/i18n/marketing/compare";
import { MARKETING_LOCALES, isMarketingPath, localizedPath } from "../../app/services/marketing-locale.shared";

describe("comparison pages", () => {
  it("has a page for every competitor in every locale that counts as public", () => {
    for (const locale of MARKETING_LOCALES) {
      expect(isMarketingPath(localizedPath(locale, "/compare"))).toBe(true);
      for (const id of COMPETITORS) {
        expect(isMarketingPath(localizedPath(locale, comparePath(id)))).toBe(true);
      }
    }
  });

  it("only accepts the listed competitors as slugs", () => {
    expect(isCompetitorId("weglot")).toBe(true);
    expect(isCompetitorId("langify")).toBe(false);
    expect(isCompetitorId(undefined)).toBe(false);
  });

  it("puts every row into a group the table renders", () => {
    for (const row of COMPARE_ROWS) expect(COMPARE_GROUPS).toContain(row.group);
    for (const group of COMPARE_GROUPS) {
      expect(COMPARE_ROWS.some((row) => row.group === group)).toBe(true);
    }
  });

  it("names our own gaps too — a table we win on every row reads as an advert", () => {
    expect(COMPARE_ROWS.some((row) => row.ours === "no")).toBe(true);
  });

  it("gives every competitor the same number of strengths and edges in every language", () => {
    const en = getCompareCopy("en");
    for (const locale of MARKETING_LOCALES) {
      const copy = getCompareCopy(locale);
      for (const id of COMPETITORS) {
        expect(copy.competitors[id].strengths.length).toBe(en.competitors[id].strengths.length);
        expect(copy.competitors[id].ourEdge.length).toBe(en.competitors[id].ourEdge.length);
        expect(Object.keys(copy.competitors[id].notes ?? {}).sort()).toEqual(
          Object.keys(en.competitors[id].notes ?? {}).sort(),
        );
      }
      expect(Object.keys(copy.ourNotes).sort()).toEqual(Object.keys(en.ourNotes).sort());
      expect(copy.vsTitle).toContain("{name}");
      expect(copy.disclaimer).toContain("{date}");
    }
  });
});

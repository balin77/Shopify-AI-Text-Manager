import { describe, expect, it } from "vitest";
import {
  COMPARE_PRICES,
  PRICE_APPS,
  formatComparePrice,
  COMPARE_GROUPS,
  COMPARE_ROWS,
  COMPETITORS,
  comparePath,
  isCompetitorId,
} from "../../app/config/marketing-compare";
import { getCompareCopy } from "../../app/i18n/marketing/compare";
import { BILLING_PLANS } from "../../app/config/billing";
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

  it("describes every plan of every app in every language", () => {
    for (const locale of MARKETING_LOCALES) {
      const copy = getCompareCopy(locale);
      for (const app of PRICE_APPS) {
        expect(copy.pricing.summaries[app]).toBeTruthy();
        for (const plan of COMPARE_PRICES[app].plans) {
          expect(copy.pricing.plans[app][plan.id], `${locale}/${app}/${plan.id}`).toBeTruthy();
        }
        expect(Object.keys(copy.pricing.plans[app]).sort()).toEqual(
          COMPARE_PRICES[app].plans.map((p) => p.id).sort(),
        );
      }
    }
  });

  it("advertises exactly the prices the app bills", () => {
    const ours = Object.fromEntries(COMPARE_PRICES.contentpilot.plans.map((p) => [p.id, p.monthly]));
    expect(ours).toEqual({
      free: 0,
      basic: BILLING_PLANS.basic.price,
      pro: BILLING_PLANS.pro.price,
      max: BILLING_PLANS.max.price,
    });
  });

  it("formats prices without Intl, the same on server and client", () => {
    expect(formatComparePrice(9.9, "EUR", "en")).toBe("€9.90");
    expect(formatComparePrice(9.9, "EUR", "de")).toBe("9,90 €");
    expect(formatComparePrice(17, "USD", "es")).toBe("17 US$");
    expect(formatComparePrice(14.9, "USD", "en")).toBe("$14.90");
  });
});

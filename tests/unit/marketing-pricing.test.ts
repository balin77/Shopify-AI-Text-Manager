import { describe, expect, it } from "vitest";
import { BILLING_PLANS, MANAGED_BILLING_PLANS } from "../../app/config/billing";
import { PLAN_CONFIG } from "../../app/config/plans";
import { SEO_SECTIONS } from "../../app/config/seo-sections";
import {
  PRICING_GROUPS,
  PRICING_PLANS,
  planCardRows,
  planPrice,
  pricingCell,
} from "../../app/config/marketing-pricing";
import { de, en, es } from "../../app/i18n/marketing";

const row = (id: string) => {
  const found = PRICING_GROUPS.flatMap((g) => g.rows).find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe("public pricing page follows the app's own plan config", () => {
  it("shows the billing prices, with and without the AI included", () => {
    expect(planPrice("free", false)).toBe(0);
    expect(planPrice("free", true)).toBe(0);
    for (const plan of ["basic", "pro", "max"] as const) {
      expect(planPrice(plan, false)).toBe(BILLING_PLANS[plan].price);
      expect(planPrice(plan, true)).toBe(MANAGED_BILLING_PLANS[plan].price);
    }
  });

  it("reads limits from PLAN_CONFIG", () => {
    for (const plan of PRICING_PLANS) {
      expect(pricingCell(row("products"), plan)).toBe(PLAN_CONFIG[plan].maxProducts);
      expect(pricingCell(row("imageOperations"), plan)).toBe(PLAN_CONFIG[plan].monthlyImageOperations);
      expect(pricingCell(row("keywords"), plan)).toBe(PLAN_CONFIG[plan].seo.maxTrackedKeywords);
    }
  });

  it("locks an SEO row exactly where the section's planGate locks it", () => {
    const tier = { free: 0, basic: 1, pro: 2, max: 3 } as const;
    const crawlGate = SEO_SECTIONS.find((s) => s.id === "crawl")?.planGate ?? "free";
    for (const plan of PRICING_PLANS) {
      expect(pricingCell(row("crawl"), plan)).toBe(tier[plan] >= tier[crawlGate]);
    }
  });

  it("derives each paid card from what the plan adds over the one below", () => {
    for (let i = 1; i < PRICING_PLANS.length; i++) {
      const plan = PRICING_PLANS[i];
      const previous = PRICING_PLANS[i - 1];
      for (const r of planCardRows(plan)) {
        const now = pricingCell(r, plan);
        const before = pricingCell(r, previous);
        expect(now !== false && now !== 0).toBe(true);
        expect(before === false || before === 0).toBe(true);
      }
    }
    // Every plan names at least one thing, or its card would be empty.
    for (const plan of PRICING_PLANS) expect(planCardRows(plan).length).toBeGreaterThan(0);
  });

  it("has a label for every row in every language", () => {
    for (const t of [en, de, es]) {
      for (const r of PRICING_GROUPS.flatMap((g) => g.rows)) {
        expect((t.pricing.rows[r.id] as { label: string }).label.length).toBeGreaterThan(0);
      }
    }
  });
});

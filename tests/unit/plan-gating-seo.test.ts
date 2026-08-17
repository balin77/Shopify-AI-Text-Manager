/**
 * Plan gating for the SEO tab (PlanLimits.seo).
 *
 * The rule these tests lock down: **Pro has the full SEO feature surface, Max
 * buys automation, memory, scale and throughput.** Before this block existed
 * the highest gate anywhere in the SEO tab was `planGate: "pro"`, so Max
 * unlocked nothing at all there.
 *
 *   scheduledAudit (nightly store audit)     → Max only
 *   scoreHistory   (score/ranking trends)    → Pro 30d / Max 365d
 *   keywords       (target-keyword tracking) → Basic+ (25 / 100 / 1000)
 *   searchConsole  (GSC)                     → Pro+ (28d / 480d window)
 *   indexNow       (instant indexing)        → Pro+ (5k / 50k per month)
 *   bulkBatchSize  (bulk-fix throughput)     → 25 / 100 / 500 / 2500
 *
 * See docs/plans/SEO_TAB_IMPLEMENTATION_PLAN.md §Plan-Matrix.
 */

import { describe, it, expect } from "vitest";
import {
  canAccessSeoFeature,
  getMinimumPlanForSeoFeature,
  getSeoLimits,
  canUseScheduledSeoAudit,
  getSeoScoreHistoryDays,
  getMaxTrackedKeywords,
  isWithinKeywordQuota,
  isOverKeywordQuota,
  getMaxGscProperties,
  canConnectGscProperty,
  getGscHistoryDays,
  getMonthlyIndexNowLimit,
  isWithinIndexNowQuota,
  getSeoBulkBatchSize,
  type SeoFeature,
} from "~/utils/planUtils";
import { SEO_RUBRICS } from "~/config/seo-sections";
import type { Plan } from "~/config/plans";

const PLANS: Plan[] = ["free", "basic", "pro", "max"];

const matrix: Record<SeoFeature, Record<Plan, boolean>> = {
  scheduledAudit: { free: false, basic: false, pro: false, max: true },
  scoreHistory: { free: false, basic: false, pro: true, max: true },
  keywords: { free: false, basic: true, pro: true, max: true },
  searchConsole: { free: false, basic: false, pro: true, max: true },
  indexNow: { free: false, basic: false, pro: true, max: true },
};

describe("plan gating — SEO tab features", () => {
  for (const [feature, byPlan] of Object.entries(matrix) as [SeoFeature, Record<Plan, boolean>][]) {
    for (const plan of PLANS) {
      it(`${plan} ${byPlan[plan] ? "can" : "cannot"} use ${feature}`, () => {
        expect(canAccessSeoFeature(plan, feature)).toBe(byPlan[plan]);
      });
    }
  }

  it("never points a merchant at a tier that would not help", () => {
    for (const feature of Object.keys(matrix) as SeoFeature[]) {
      const minimum = getMinimumPlanForSeoFeature(feature);
      expect(minimum).not.toBeNull();
      expect(canAccessSeoFeature(minimum as Plan, feature)).toBe(true);
      // ...and the tier below must NOT have it, so the upsell is truly minimal.
      const below = PLANS[PLANS.indexOf(minimum as Plan) - 1];
      if (below) expect(canAccessSeoFeature(below, feature)).toBe(false);
    }
  });

  it("reports the minimum plan for each SEO feature", () => {
    expect(getMinimumPlanForSeoFeature("scheduledAudit")).toBe("max");
    expect(getMinimumPlanForSeoFeature("scoreHistory")).toBe("pro");
    expect(getMinimumPlanForSeoFeature("keywords")).toBe("basic");
    expect(getMinimumPlanForSeoFeature("searchConsole")).toBe("pro");
    expect(getMinimumPlanForSeoFeature("indexNow")).toBe("pro");
  });

  it("gives Max something Pro does not have — the whole point of this matrix", () => {
    const pro = getSeoLimits("pro");
    const max = getSeoLimits("max");
    const differences = [
      max.scheduledAudit !== pro.scheduledAudit,
      max.scoreHistoryDays > pro.scoreHistoryDays,
      max.maxTrackedKeywords > pro.maxTrackedKeywords,
      max.gscHistoryDays > pro.gscHistoryDays,
      max.monthlyIndexNowSubmissions > pro.monthlyIndexNowSubmissions,
      max.bulkBatchSize > pro.bulkBatchSize,
    ].filter(Boolean);
    // Not "at least one": a 3× price step needs to be visible across the board.
    expect(differences.length).toBeGreaterThanOrEqual(5);
  });

  it("never decreases an SEO limit as the tier rises", () => {
    for (let i = 1; i < PLANS.length; i++) {
      const lower = getSeoLimits(PLANS[i - 1]);
      const higher = getSeoLimits(PLANS[i]);
      expect(higher.scoreHistoryDays).toBeGreaterThanOrEqual(lower.scoreHistoryDays);
      expect(higher.maxTrackedKeywords).toBeGreaterThanOrEqual(lower.maxTrackedKeywords);
      expect(higher.gscProperties).toBeGreaterThanOrEqual(lower.gscProperties);
      expect(higher.gscHistoryDays).toBeGreaterThanOrEqual(lower.gscHistoryDays);
      expect(higher.monthlyIndexNowSubmissions).toBeGreaterThanOrEqual(
        lower.monthlyIndexNowSubmissions,
      );
      expect(higher.bulkBatchSize).toBeGreaterThanOrEqual(lower.bulkBatchSize);
      expect(Number(higher.scheduledAudit)).toBeGreaterThanOrEqual(Number(lower.scheduledAudit));
    }
  });
});

describe("SEO quota helpers", () => {
  it("exposes the scheduled-audit flag", () => {
    expect(canUseScheduledSeoAudit("pro")).toBe(false);
    expect(canUseScheduledSeoAudit("max")).toBe(true);
  });

  it("exposes score-history retention", () => {
    expect(getSeoScoreHistoryDays("basic")).toBe(0);
    expect(getSeoScoreHistoryDays("pro")).toBe(30);
    expect(getSeoScoreHistoryDays("max")).toBe(365);
  });

  it("enforces the keyword quota with 0 = feature disabled", () => {
    expect(getMaxTrackedKeywords("free")).toBe(0);
    expect(isWithinKeywordQuota("free", 0)).toBe(false); // disabled, not "empty"
    expect(isWithinKeywordQuota("basic", 24)).toBe(true);
    expect(isWithinKeywordQuota("basic", 25)).toBe(false); // at cap
    expect(isWithinKeywordQuota("pro", 90, 10)).toBe(true); // exactly fills 100
    expect(isWithinKeywordQuota("pro", 91, 10)).toBe(false);
    expect(isWithinKeywordQuota("max", 999)).toBe(true);
  });

  it("recognises an over-cap shop after a downgrade without deleting anything", () => {
    // 400 keywords tracked on Max, then a downgrade to Pro (cap 100).
    expect(isOverKeywordQuota("pro", 400)).toBe(true);
    expect(isWithinKeywordQuota("pro", 400)).toBe(false); // no NEW ones
    expect(isOverKeywordQuota("pro", 100)).toBe(false); // exactly at cap is not over
    expect(isOverKeywordQuota("max", 400)).toBe(false);
  });

  it("caps connectable GSC properties per plan", () => {
    expect(getMaxGscProperties("basic")).toBe(0);
    expect(canConnectGscProperty("basic", 0)).toBe(false);
    expect(canConnectGscProperty("pro", 0)).toBe(true);
    expect(canConnectGscProperty("pro", 1)).toBe(false);
  });

  it("spreads the GSC lookback window — the real Pro→Max GSC difference", () => {
    expect(getGscHistoryDays("pro")).toBe(28);
    expect(getGscHistoryDays("max")).toBe(480); // ≈ the API's own 16 months
  });

  it("enforces the monthly IndexNow quota with 0 = feature disabled", () => {
    expect(getMonthlyIndexNowLimit("basic")).toBe(0);
    expect(isWithinIndexNowQuota("basic", 0)).toBe(false);
    expect(isWithinIndexNowQuota("pro", 4999)).toBe(true);
    expect(isWithinIndexNowQuota("pro", 5000)).toBe(false);
    expect(isWithinIndexNowQuota("pro", 4000, 1000)).toBe(true);
    expect(isWithinIndexNowQuota("pro", 4001, 1000)).toBe(false);
    expect(isWithinIndexNowQuota("max", 49999)).toBe(true);
  });

  it("spreads bulk throughput like the WebP concurrency does", () => {
    expect(getSeoBulkBatchSize("free")).toBe(25);
    expect(getSeoBulkBatchSize("basic")).toBe(100);
    expect(getSeoBulkBatchSize("pro")).toBe(500);
    expect(getSeoBulkBatchSize("max")).toBe(2500);
  });
});

describe("SEO gating does not touch the deliberate USPs", () => {
  it("never gates on locale count", () => {
    // Locales are uncapped on every tier by design (ROADMAP §Limit-Review);
    // the SEO matrix must not smuggle a per-locale limit back in.
    const keys = Object.keys(getSeoLimits("free"));
    expect(keys.some((k) => /locale/i.test(k))).toBe(false);
  });

  it("leaves the diagnostic sections reachable on every tier", () => {
    // A shop that cannot see its own SEO problems has nothing to upgrade for,
    // so these sections must never carry a planGate.
    const open = ["overview", "performance", "hreflang", "redirects", "structuredData"];
    const gated = new Map<string, string | undefined>();
    for (const rubric of SEO_RUBRICS) {
      for (const entry of rubric.entries) gated.set(entry.id, entry.planGate);
    }
    for (const id of open) {
      expect(gated.get(id)).toBeUndefined();
    }
  });

  it("keeps every section's planGate at or below the tier its quota needs", () => {
    // A section visible on a plan whose quota is 0 would render an empty shell.
    const gateById = new Map<string, string | undefined>();
    for (const rubric of SEO_RUBRICS) {
      for (const entry of rubric.entries) gateById.set(entry.id, entry.planGate);
    }
    expect(gateById.get("keywords")).toBe(getMinimumPlanForSeoFeature("keywords"));
    expect(gateById.get("searchConsole")).toBe(getMinimumPlanForSeoFeature("searchConsole"));
    expect(gateById.get("indexNow")).toBe(getMinimumPlanForSeoFeature("indexNow"));
  });
});

/**
 * Plan-gating for the full-translation-coverage rubrics (Phase 4).
 *
 *   onlineStoreExtras (Filter / Cookie-Banner / Shop-Metadaten) → all tiers
 *   delivery          (checkout shipping names)                 → Basic+
 *   system            (notifications / payment / packing)       → Pro+
 *   sellingPlans      (subscriptions)                           → Pro+
 */

import { describe, it, expect } from "vitest";
import { canAccessContentType, getMinimumPlanForContentType } from "~/utils/planUtils";
import type { Plan, ContentType } from "~/config/plans";

const matrix: Record<ContentType extends string ? string : never, Record<Plan, boolean>> = {
  onlineStoreExtras: { free: true, basic: true, pro: true, max: true },
  delivery: { free: false, basic: true, pro: true, max: true },
  system: { free: false, basic: false, pro: true, max: true },
  sellingPlans: { free: false, basic: false, pro: true, max: true },
} as const;

describe("plan gating — new translation-coverage rubrics", () => {
  for (const [ct, byPlan] of Object.entries(matrix)) {
    for (const [plan, allowed] of Object.entries(byPlan)) {
      it(`${plan} ${allowed ? "can" : "cannot"} access ${ct}`, () => {
        expect(canAccessContentType(plan as Plan, ct as ContentType)).toBe(allowed);
      });
    }
  }

  it("minimum plan is correct for each new rubric", () => {
    expect(getMinimumPlanForContentType("onlineStoreExtras")).toBeNull(); // free
    expect(getMinimumPlanForContentType("delivery")).toBe("basic");
    expect(getMinimumPlanForContentType("system")).toBe("pro");
    expect(getMinimumPlanForContentType("sellingPlans")).toBe("pro");
  });
});

/**
 * PLAN_CONTENT_CREATION §1.2 — may this merchant create this resource?
 *
 * Client-safe and pure, so the button's disabled state and the server's refusal
 * are the SAME decision rather than two implementations that drift. The server
 * re-runs the check regardless (`create.actions.ts`) — this is not a security
 * boundary, it is what makes the UI honest about a refusal the server would
 * issue anyway.
 *
 * The gate is two-stage because `plans.ts` has two genuinely different locks,
 * and the merchant's remedy differs:
 *
 *   - the TYPE is not in the plan (Free has no pages, Basic no articles)
 *     → "your plan does not include this content type" — an upgrade adds a
 *       capability
 *   - the QUANTITY limit is reached
 *     → "limit reached" — an upgrade adds headroom, or they delete something
 *
 * Showing "limit reached" to someone whose plan simply lacks the type sends
 * them looking for items to delete that would not help. That is the whole
 * reason these are not collapsed into one boolean.
 *
 * Neither state hides the button (§ single-language rules, same spirit):
 * visible-but-disabled with the right reason, never absent — a missing button
 * reads as a missing feature.
 */

import { canAccessContentType, getMaxForResource, isAtLimit, type Plan, type ResourceType } from "./planUtils";
import type { ContentType } from "../config/plans";
import { createSpecFor, type CreatableResource } from "../config/create-fields.config";

export type CreateGateResult =
  | { allowed: true }
  | { allowed: false; reason: "planContentType"; contentType: ContentType; }
  | { allowed: false; reason: "planLimit"; limitResource: ResourceType; max: number; current: number }
  | { allowed: false; reason: "unknownResource" };

export function evaluateCreateGate(
  plan: Plan,
  resource: CreatableResource,
  /**
   * How many of this resource the shop already has. `undefined` means the
   * caller does not know yet — the gate then does NOT refuse: an unknown count
   * is not evidence of being at the limit, and the server checks anyway. Same
   * rule as `attributesSyncedAt`: absence is not a negative.
   */
  currentCount?: number,
): CreateGateResult {
  const spec = createSpecFor(resource);
  if (!spec) return { allowed: false, reason: "unknownResource" };

  if (!canAccessContentType(plan, spec.planContentType as ContentType)) {
    return { allowed: false, reason: "planContentType", contentType: spec.planContentType as ContentType };
  }

  if (spec.limitResource && currentCount !== undefined) {
    if (isAtLimit(plan, spec.limitResource, currentCount)) {
      return {
        allowed: false,
        reason: "planLimit",
        limitResource: spec.limitResource,
        max: getMaxForResource(plan, spec.limitResource),
        current: currentCount,
      };
    }
  }

  return { allowed: true };
}

/**
 * The whole tab's verdict: creation is offered while ANY of its resources is
 * allowed. The blogs tab offers both an article and its blog container, and a
 * plan that caps articles must not also hide the way to create a blog.
 */
export function evaluateCreateGates(
  plan: Plan,
  resources: CreatableResource[],
  counts: Partial<Record<ResourceType, number>> = {},
): { anyAllowed: boolean; byResource: Array<{ resource: CreatableResource; gate: CreateGateResult }> } {
  const byResource = resources.map((resource) => {
    const spec = createSpecFor(resource);
    const count = spec?.limitResource ? counts[spec.limitResource] : undefined;
    return { resource, gate: evaluateCreateGate(plan, resource, count) };
  });
  return { anyAllowed: byResource.some((r) => r.gate.allowed), byResource };
}

/** i18n key for the tooltip explaining a refusal. */
export function gateTooltipKey(gate: CreateGateResult): string | null {
  if (gate.allowed) return null;
  switch (gate.reason) {
    case "planContentType": return "create.gate.planContentType";
    case "planLimit":       return "create.gate.planLimit";
    case "unknownResource": return "create.gate.unavailable";
  }
}

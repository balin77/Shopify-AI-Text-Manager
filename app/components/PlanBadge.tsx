/**
 * Plan Badge Component
 * Visual indicator for subscription plan tier
 */

import { Badge } from "@shopify/polaris";
import { type Plan } from "../config/plans";
import { getPlanDisplayName } from "../utils/planUtils";

interface PlanBadgeProps {
  plan: Plan;
  size?: "small" | "medium";
}

export function PlanBadge({ plan, size = "medium" }: PlanBadgeProps) {
  const displayName = getPlanDisplayName(plan);

  // Map plans to Polaris Badge tones
  const toneMap: Record<Plan, "info" | "success" | "attention" | "warning"> = {
    free: "info",
    basic: "success",
    pro: "attention",
    max: "warning",
  };

  return (
    <Badge tone={toneMap[plan]} size={size}>
      {displayName}
    </Badge>
  );
}

/**
 * PlanAccessGate
 *
 * Reusable component that blocks access to a page if the user's plan
 * does not grant it. Two gating modes:
 *   - `contentType`: plan must include the content type (original mode)
 *   - `minPlan`: plan must rank at or above the given tier (hierarchical,
 *     e.g. the bulk editor requires "basic")
 * Shows a centered upgrade message while keeping the navigation visible.
 *
 * Usage:
 *   <PlanAccessGate contentType="articles">…</PlanAccessGate>
 *   <PlanAccessGate minPlan="basic">…</PlanAccessGate>
 */

import type { ReactNode } from "react";
import { Text } from "@shopify/polaris";
import { usePlan } from "../contexts/PlanContext";
import { useI18n } from "../contexts/I18nContext";
import { getMinimumPlanForContentType, meetsPlan } from "../utils/planUtils";
import { PLAN_DISPLAY_NAMES, type ContentType, type Plan } from "../config/plans";

interface PlanAccessGateProps {
  /** Content-type mode: plan must include this content type. */
  contentType?: ContentType;
  /** Tier mode: plan must rank at or above this plan. */
  minPlan?: Plan;
  children: ReactNode;
}

export function PlanAccessGate({ contentType, minPlan, children }: PlanAccessGateProps) {
  const { plan, canAccessContentType } = usePlan();
  const { t } = useI18n();

  const allowed =
    (contentType === undefined || canAccessContentType(contentType)) &&
    (minPlan === undefined || meetsPlan(plan, minPlan));

  if (allowed) {
    return <>{children}</>;
  }

  const requiredPlan =
    minPlan !== undefined && !meetsPlan(plan, minPlan)
      ? minPlan
      : contentType !== undefined
        ? getMinimumPlanForContentType(contentType)
        : null;
  const planName = requiredPlan ? PLAN_DISPLAY_NAMES[requiredPlan] : "Pro";

  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <Text as="p" variant="bodyMd" tone="subdued">
        {t.content?.upgradeToAccessFeature?.replace("{plan}", planName)
          || `Upgrade to ${planName} to access this feature.`}
      </Text>
    </div>
  );
}

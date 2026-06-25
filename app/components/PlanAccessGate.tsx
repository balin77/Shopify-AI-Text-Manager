/**
 * PlanAccessGate
 *
 * Reusable component that blocks access to a page if the user's plan
 * does not include the specified content type. Shows a centered upgrade
 * message while keeping the navigation visible.
 *
 * Usage:
 *   <PlanAccessGate contentType="articles">
 *     {/* page content rendered only when plan allows access *​/}
 *   </PlanAccessGate>
 */

import type { ReactNode } from "react";
import { Text } from "@shopify/polaris";
import { usePlan } from "../contexts/PlanContext";
import { useI18n } from "../contexts/I18nContext";
import { getMinimumPlanForContentType } from "../utils/planUtils";
import { PLAN_DISPLAY_NAMES, type ContentType } from "../config/plans";

interface PlanAccessGateProps {
  contentType: ContentType;
  children: ReactNode;
}

export function PlanAccessGate({ contentType, children }: PlanAccessGateProps) {
  const { canAccessContentType } = usePlan();
  const { t } = useI18n();

  if (canAccessContentType(contentType)) {
    return <>{children}</>;
  }

  const requiredPlan = getMinimumPlanForContentType(contentType);
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

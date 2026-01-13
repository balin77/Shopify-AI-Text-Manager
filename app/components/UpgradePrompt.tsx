/**
 * Upgrade Prompt Component
 * Call-to-action for upgrading to a higher plan
 */

import { Banner, Text } from "@shopify/polaris";
import { type Plan } from "../config/plans";
import { getPlanDisplayName, getNextPlanUpgrade } from "../utils/planUtils";

interface UpgradePromptProps {
  currentPlan: Plan;
  feature: string;
  onUpgrade?: () => void;
}

export function UpgradePrompt({ currentPlan, feature, onUpgrade }: UpgradePromptProps) {
  const nextPlan = getNextPlanUpgrade(currentPlan);

  if (!nextPlan) {
    return null; // Already at max plan
  }

  const nextPlanName = getPlanDisplayName(nextPlan);

  return (
    <Banner tone="info" onDismiss={onUpgrade ? undefined : () => {}}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Text as="p" fontWeight="semibold">
          {feature} is available in the {nextPlanName} plan
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Upgrade to unlock this feature and get access to more content types and higher limits.
        </Text>
      </div>
    </Banner>
  );
}

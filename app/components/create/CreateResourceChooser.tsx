/**
 * PLAN_CONTENT_CREATION §1.1 — "what do you want to create?"
 *
 * Only the blogs tab needs this: it serves an ARTICLE and the BLOG it lives in,
 * two genuinely different resources behind one "+". Every other tab has a
 * single creatable resource and skips this step entirely — an extra click to
 * choose between one option is pure friction.
 *
 * A refused option stays listed with its reason rather than disappearing. On a
 * plan without articles, a merchant who can still create a blog needs to see
 * both facts.
 */

import { Modal, BlockStack, Text } from "@shopify/polaris";
import type { CreatableResource } from "~/config/create-fields.config";
import type { CreateGateResult } from "~/utils/create-gate";

export interface CreateResourceChooserProps {
  open: boolean;
  onClose: () => void;
  resources: Array<{ resource: CreatableResource; gate: CreateGateResult }>;
  onChoose: (resource: CreatableResource) => void;
  /** Label per resource; falls back to the resource key. */
  labels?: Partial<Record<CreatableResource, string>>;
  /** Explanation per refusal reason. */
  reasons?: { planContentType?: string; planLimit?: string; unavailable?: string };
  title?: string;
  cancel?: string;
}

export function CreateResourceChooser({
  open,
  onClose,
  resources,
  onChoose,
  labels = {},
  reasons = {},
  title,
  cancel,
}: CreateResourceChooserProps) {
  const reasonFor = (gate: CreateGateResult): string | null => {
    if (gate.allowed) return null;
    switch (gate.reason) {
      case "planContentType": return reasons.planContentType || "Not included in your plan.";
      case "planLimit":       return reasons.planLimit || "Plan limit reached.";
      default:                return reasons.unavailable || "Not available.";
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || "What would you like to create?"}
      secondaryActions={[{ content: cancel || "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {resources.map(({ resource, gate }) => {
            const reason = reasonFor(gate);
            return (
              <button
                key={resource}
                type="button"
                onClick={() => gate.allowed && onChoose(resource)}
                disabled={!gate.allowed}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "12px",
                  border: "1px solid var(--app-surface-border-color)",
                  borderRadius: "8px",
                  background: gate.allowed ? "white" : "#f6f6f7",
                  cursor: gate.allowed ? "pointer" : "not-allowed",
                }}
              >
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {labels[resource] || resource}
                  </Text>
                  {reason && (
                    <Text as="p" variant="bodySm" tone="subdued">{reason}</Text>
                  )}
                </BlockStack>
              </button>
            );
          })}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

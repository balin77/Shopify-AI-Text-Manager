/**
 * The field/tab-level ❓: a popover with the short explanation and, when the
 * help entry has `details`, a "Mehr erfahren" modal behind it.
 *
 * Trigger, overlay and the scroll lock that keeps the overlay glued to the icon
 * all come from [HelpTrigger.tsx](HelpTrigger.tsx) — see the module comment
 * there for why an overlay opened inside this app's inner scroll containers has
 * to freeze them.
 */

import { useCallback, useState } from "react";
import { Button, Text, BlockStack, InlineStack, Modal, List } from "@shopify/polaris";
import { HelpPopover } from "./HelpTrigger";
import { useI18n } from "../contexts/I18nContext";
import type { HelpContent } from "../types/content-editor.types";

export type { HelpContent };

interface HelpTooltipProps {
  helpKey: string;
  position?: "above" | "below";
}

export function HelpTooltip({ helpKey, position = "above" }: HelpTooltipProps) {
  const { t } = useI18n();
  const [modalActive, setModalActive] = useState(false);
  const closeModal = useCallback(() => setModalActive(false), []);

  // Get help content from translations
  const helpDict = t.help as Record<string, HelpContent> | undefined;
  const helpContent = helpDict?.[helpKey];
  if (!helpContent) return null;

  return (
    <>
      <HelpPopover
        label={helpContent.title}
        preferredPosition={position}
        keepScrollLocked={modalActive}
      >
        {(closePopover) => (
          <BlockStack gap="200">
            <Text as="h4" variant="headingSm" fontWeight="semibold">
              {helpContent.title}
            </Text>
            <Text as="p" variant="bodySm">
              {helpContent.summary}
            </Text>
            {helpContent.tips && helpContent.tips.length > 0 && (
              <div className="help-tooltip-tips">
                <List type="bullet">
                  {helpContent.tips.map((tip, i) => (
                    <List.Item key={i}>
                      <Text as="span" variant="bodySm">{tip}</Text>
                    </List.Item>
                  ))}
                </List>
              </div>
            )}
            {helpContent.details && (
              <InlineStack align="end">
                <Button
                  size="slim"
                  variant="plain"
                  onClick={() => {
                    closePopover();
                    setModalActive(true);
                  }}
                >
                  {t.common?.learnMore || "Mehr erfahren"}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        )}
      </HelpPopover>

      {helpContent.details && (
        <Modal
          open={modalActive}
          onClose={closeModal}
          title={helpContent.title}
          primaryAction={{
            content: t.common?.close || "Schließen",
            onAction: closeModal,
          }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p">{helpContent.details}</Text>
              {helpContent.examples && helpContent.examples.length > 0 && (
                <div className="help-tooltip-examples">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {t.common?.examples || "Beispiele:"}
                  </Text>
                  <BlockStack gap="100">
                    {helpContent.examples.map((example, i) => (
                      <Text key={i} as="p" variant="bodySm" tone="subdued">
                        {example}
                      </Text>
                    ))}
                  </BlockStack>
                </div>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}

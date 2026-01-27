import { useState, useCallback } from "react";
import {
  Popover,
  Button,
  Icon,
  Text,
  BlockStack,
  InlineStack,
  Modal,
  List,
} from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import "../styles/HelpTooltip.css";

export interface HelpContent {
  title: string;
  summary: string;
  details?: string;
  tips?: string[];
  examples?: string[];
}

interface HelpTooltipProps {
  helpKey: string;
  position?: "above" | "below";
}

export function HelpTooltip({ helpKey, position = "above" }: HelpTooltipProps) {
  const { t } = useI18n();
  const [popoverActive, setPopoverActive] = useState(false);
  const [modalActive, setModalActive] = useState(false);

  const togglePopover = useCallback(() => setPopoverActive((active) => !active), []);
  const closePopover = useCallback(() => setPopoverActive(false), []);
  const openModal = useCallback(() => {
    setPopoverActive(false);
    setModalActive(true);
  }, []);
  const closeModal = useCallback(() => setModalActive(false), []);

  // Get help content from translations
  const helpContent = t.help?.[helpKey] as HelpContent | undefined;
  if (!helpContent) return null;

  const activator = (
    <button
      className="help-tooltip-trigger"
      onClick={togglePopover}
      type="button"
      aria-label={helpContent.title}
    >
      <Icon source={QuestionCircleIcon} tone="subdued" />
    </button>
  );

  return (
    <>
      <Popover
        active={popoverActive}
        activator={activator}
        onClose={closePopover}
        preferredPosition={position}
        sectioned
      >
        <div className="help-tooltip-content">
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
                <Button size="slim" variant="plain" onClick={openModal}>
                  {t.common?.learnMore || "Mehr erfahren"}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </div>
      </Popover>

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

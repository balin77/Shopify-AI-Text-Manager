/**
 * Settings Navigation Mobile - Dropdown Version
 *
 * Mobile-optimized navigation for settings page that shows as a collapsible dropdown
 * with the current section displayed.
 */

import { useState } from "react";
import { Card, InlineStack, Text, Icon, BlockStack } from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";

export type SettingsSection = "setup" | "ai" | "instructions" | "language" | "plan";

interface SettingsNavigationMobileProps {
  /** Currently selected section */
  selectedSection: SettingsSection;
  /** Callback when section is selected */
  onSectionSelect: (section: SettingsSection) => void;
  /** Translation strings */
  t: {
    settings: {
      appSetup: string;
      aiApiAccess: string;
      aiInstructions: string;
      appLanguage: string;
      plan: string;
    };
  };
}

export function SettingsNavigationMobile({
  selectedSection,
  onSectionSelect,
  t,
}: SettingsNavigationMobileProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Define all sections
  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "setup", label: t.settings.appSetup },
    { id: "ai", label: t.settings.aiApiAccess },
    { id: "instructions", label: t.settings.aiInstructions },
    { id: "language", label: t.settings.appLanguage },
    { id: "plan", label: t.settings.plan },
  ];

  // Find the current section label
  const currentSection = sections.find((s) => s.id === selectedSection);

  const handleSectionSelect = (section: SettingsSection) => {
    onSectionSelect(section);
    setIsExpanded(false);
  };

  return (
    <div className="settings-navigation-mobile">
      {/* Selected Section Display - Tap to expand */}
      <Card>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: "100%",
            background: "none",
            border: "none",
            padding: "0.75rem",
            cursor: "pointer",
            textAlign: "left",
          }}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Close settings menu" : "Open settings menu"}
        >
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {currentSection?.label || "Settings"}
            </Text>
            <Icon source={isExpanded ? ChevronUpIcon : ChevronDownIcon} />
          </InlineStack>
        </button>
      </Card>

      {/* Expanded Section List */}
      {isExpanded && (
        <Card padding="0">
          <BlockStack gap="0">
            {sections.map((section, index) => {
              const isSelected = section.id === selectedSection;

              return (
                <button
                  key={section.id}
                  onClick={() => handleSectionSelect(section.id)}
                  style={{
                    width: "100%",
                    padding: "1rem",
                    background: isSelected ? "#f1f8f5" : "white",
                    borderTop: index === 0 ? "none" : "1px solid #e1e3e5",
                    borderRight: "none",
                    borderBottom: "none",
                    borderLeft: isSelected ? "3px solid #008060" : "3px solid transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.2s",
                  }}
                  aria-current={isSelected ? "page" : undefined}
                >
                  <Text as="span" variant="bodyMd" fontWeight={isSelected ? "semibold" : "regular"}>
                    {section.label}
                  </Text>
                </button>
              );
            })}
          </BlockStack>
        </Card>
      )}
    </div>
  );
}

/**
 * SeoSectionLayout — the shared shell every SEO section renders inside
 * (SEO_TAB_IMPLEMENTATION_PLAN.md §0.1b / A1).
 *
 * Provides a consistent header (icon + title + description from
 * `t.seo.sections.<id>`) and enforces the section's `planGate` from
 * SEO_SECTIONS: a merchant below the required plan sees an upsell card instead
 * of the section content (the server loader/action must gate too — this is the
 * client half). Sections without a `planGate` are available on all plans.
 */

import type { ReactNode } from "react";
import { Card, BlockStack, Text, InlineStack } from "@shopify/polaris";
import { usePlan } from "../../contexts/PlanContext";
import { useI18n } from "../../contexts/I18nContext";
import { meetsPlan } from "../../utils/planUtils";
import { SEO_SECTIONS } from "../../config/seo-sections";
import { PLAN_DISPLAY_NAMES } from "../../config/plans";

interface SeoSectionLayoutProps {
  sectionId: string;
  children: ReactNode;
}

interface SeoSectionStrings {
  label?: string;
  title?: string;
  description?: string;
}

export function SeoSectionLayout({ sectionId, children }: SeoSectionLayoutProps) {
  const { plan } = usePlan();
  const { t } = useI18n();

  const section = SEO_SECTIONS.find((s) => s.id === sectionId);
  const sections = (t.seo as { sections?: Record<string, SeoSectionStrings> }).sections;
  const strings = sections?.[sectionId] ?? {};
  const title = strings.title || strings.label || sectionId;

  const locked = section?.planGate ? !meetsPlan(plan, section.planGate) : false;

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center">
          {section?.icon && (
            <Text as="span" variant="headingLg">
              {section.icon}
            </Text>
          )}
          <Text as="h2" variant="headingLg">
            {title}
          </Text>
        </InlineStack>
        {strings.description && (
          <Text as="p" variant="bodyMd" tone="subdued">
            {strings.description}
          </Text>
        )}
      </BlockStack>

      {locked ? (
        <Card>
          <div style={{ padding: "1rem", textAlign: "center" }}>
            <Text as="p" variant="bodyMd" tone="subdued">
              {(t.seo as { upgradeForSection?: string }).upgradeForSection?.replace(
                "{plan}",
                PLAN_DISPLAY_NAMES[section!.planGate!],
              ) || `Upgrade to ${PLAN_DISPLAY_NAMES[section!.planGate!]} to use this feature.`}
            </Text>
          </div>
        </Card>
      ) : (
        children
      )}
    </BlockStack>
  );
}

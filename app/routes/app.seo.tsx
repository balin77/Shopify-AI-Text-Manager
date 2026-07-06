/**
 * SEO tab layout route (SEO_TAB_IMPLEMENTATION_PLAN.md §0.2).
 *
 * Renders the SEO sub-navigation — driven entirely by SEO_SECTIONS so a new
 * section appears by adding one descriptor entry — plus the <Outlet/> for the
 * active section. Sits under app.tsx (which already provides the scroll <main>),
 * so this only adds a padded container + the sub-nav bar.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLocation, useNavigation } from "@remix-run/react";
import { Text, Card, BlockStack, SkeletonBodyText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { meetsPlan } from "../utils/planUtils";
import { SEO_SECTIONS, getActiveSeoSection, isSeoPath } from "../config/seo-sections";
import { PLAN_DISPLAY_NAMES } from "../config/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth-gate the whole SEO tab; section data is loaded by each child route.
  await authenticate.admin(request);
  return json({});
};

interface SeoSectionStrings {
  label?: string;
}

export default function SeoLayout() {
  const location = useLocation();
  const navigation = useNavigation();
  const { t } = useI18n();
  const { plan } = usePlan();
  const { handleNavigate } = useAppNavigation();

  const active = getActiveSeoSection(location.pathname);
  const sectionStrings =
    (t.seo as { sections?: Record<string, SeoSectionStrings> }).sections ?? {};

  // Section-switch loading feedback: loaders like analyzeStore re-run on every
  // tab click with no visual feedback otherwise. Only swap the outlet for a
  // skeleton when the *target* of the in-flight navigation is itself within
  // /app/seo — the sub-nav (rendered above) stays interactive throughout.
  const isSeoSectionLoading =
    navigation.state !== "idle" && isSeoPath(navigation.location?.pathname ?? "");

  const lockedTitle = (section: (typeof SEO_SECTIONS)[number]) =>
    section.planGate
      ? (t.seo as { upgradeForSection?: string }).upgradeForSection?.replace(
          "{plan}",
          PLAN_DISPLAY_NAMES[section.planGate],
        ) || `Upgrade to ${PLAN_DISPLAY_NAMES[section.planGate]} to use this feature.`
      : undefined;

  return (
    <div style={{ padding: "1rem", maxWidth: "1200px", margin: "0 auto", width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          borderBottom: "1px solid #e1e3e5",
          marginBottom: "1rem",
        }}
      >
        {SEO_SECTIONS.map((section) => {
          const isActive = active?.id === section.id;
          const locked = section.planGate ? !meetsPlan(plan, section.planGate) : false;
          const label = sectionStrings[section.id]?.label || section.id;
          return (
            <button
              key={section.id}
              onClick={() => handleNavigate(section.path)}
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              title={locked ? lockedTitle(section) : undefined}
              style={{
                background: "none",
                border: "none",
                padding: "0.5rem 0.75rem",
                cursor: "pointer",
                borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
              }}
            >
              <Text
                as="span"
                variant="bodyMd"
                fontWeight={isActive ? "bold" : "regular"}
                tone={isActive ? "base" : "subdued"}
              >
                {section.icon} {label}
                {locked ? " 🔒" : ""}
              </Text>
            </button>
          );
        })}
      </div>

      {isSeoSectionLoading ? (
        <Card>
          <BlockStack gap="400">
            <SkeletonBodyText lines={3} />
            <SkeletonBodyText lines={5} />
          </BlockStack>
        </Card>
      ) : (
        <Outlet />
      )}
    </div>
  );
}

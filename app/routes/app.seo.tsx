/**
 * SEO tab layout route (SEO_TAB_IMPLEMENTATION_PLAN.md §0.2).
 *
 * Renders the SEO sub-navigation — driven entirely by SEO_SECTIONS so a new
 * section appears by adding one descriptor entry — plus the <Outlet/> for the
 * active section. Sits under app.tsx (which already provides the scroll <main>),
 * so this only adds the sub-nav bar + a padded container for the outlet.
 *
 * The sub-nav reuses the shared `SubNavBar` component (Level-2 look also used
 * by RubricNavigation in the "Inhalte" tab) so both tabs render an identical
 * bar and hover behaviour, driven from their respective config arrays.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLocation, useNavigation } from "@remix-run/react";
import { Card, BlockStack, SkeletonBodyText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { meetsPlan } from "../utils/planUtils";
import { SEO_SECTIONS, getActiveSeoSection, isSeoPath } from "../config/seo-sections";
import { PLAN_DISPLAY_NAMES } from "../config/plans";
import { SubNavBar, type SubNavBarItem } from "../components/nav/SubNavBar";

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

  const items: SubNavBarItem[] = SEO_SECTIONS.map((section) => {
    const locked = section.planGate ? !meetsPlan(plan, section.planGate) : false;
    const label = sectionStrings[section.id]?.label || section.id;
    return {
      id: section.id,
      icon: section.icon,
      label,
      locked,
      tooltip: locked ? lockedTitle(section) : undefined,
    };
  });

  const onSelect = (item: SubNavBarItem) => {
    const section = SEO_SECTIONS.find((s) => s.id === item.id);
    if (section) handleNavigate(section.path);
  };

  return (
    // Own the full height of <main> so the scroll happens INSIDE the outlet
    // container, not on the outer <main>. Otherwise <main>'s scrollbar track
    // runs behind the (sticky) SubNavBar — the merchant sees the track/thumb
    // extending up alongside the sub-nav chips. Same pattern the fixed-frame
    // editor routes use (see comment in app.tsx's <main>).
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <SubNavBar
        items={items}
        activeId={active?.id ?? null}
        onSelect={onSelect}
        ariaLabel="SEO sections"
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ padding: "1rem", maxWidth: "1200px", margin: "0 auto", width: "100%" }}>
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
      </div>
    </div>
  );
}

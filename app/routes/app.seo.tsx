/**
 * SEO tab layout route (SEO_TAB_IMPLEMENTATION_PLAN.md §0.2).
 *
 * Renders the two-level SEO sub-navigation — driven entirely by SEO_RUBRICS so
 * a new section appears by adding one descriptor entry — plus the <Outlet/> for
 * the active section. Sits under app.tsx (which already provides the scroll
 * <main>), so this only adds the nav bars + a padded container for the outlet.
 *
 *   LEVEL 2  rubric bar    : Übersicht / Analyse / Keywords / Verlinkungen / Technik
 *   LEVEL 3  section bar   : the active rubric's sections (hidden when the
 *                            rubric holds a single section — see below)
 *
 * Both bars reuse the shared `SubNavBar` component (`variant` picks the level
 * look) which the "Inhalte" tab uses for the same two levels, so the tabs
 * render identical bars and hover behaviour from their respective configs.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { Outlet, useLocation, useNavigation } from "react-router";
import { Card, BlockStack, SkeletonBodyText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { meetsPlan } from "../utils/planUtils";
import {
  SEO_RUBRICS,
  SEO_SECTIONS,
  getActiveSeoRubric,
  getActiveSeoSection,
  isSeoPath,
  type SeoRubricDef,
} from "../config/seo-sections";
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
  const activeRubric = getActiveSeoRubric(location.pathname);
  const sectionStrings =
    (t.seo as { sections?: Record<string, SeoSectionStrings> }).sections ?? {};
  const rubricStrings = (t.seo as { rubrics?: Record<string, string> }).rubrics ?? {};

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

  const isLocked = (section: (typeof SEO_SECTIONS)[number]) =>
    section.planGate ? !meetsPlan(plan, section.planGate) : false;

  // Level 2 — one chip per rubric. A rubric only shows the lock when EVERY one
  // of its sections is gated above the merchant's plan; a mixed rubric (e.g.
  // Verlinkungen: Weiterleitungen free, Interne Verlinkung Pro) stays open and
  // the lock is carried by the individual Level-3 chip.
  const rubricItems: SubNavBarItem[] = SEO_RUBRICS.map((rubric) => {
    const locked = rubric.entries.every(isLocked);
    const firstGated = rubric.entries.find((e) => e.planGate);
    return {
      id: rubric.id,
      icon: rubric.icon,
      label: rubricStrings[rubric.id] || rubric.id,
      locked,
      tooltip: locked && firstGated ? lockedTitle(firstGated) : undefined,
    };
  });

  // Level 3 — sections of the active rubric only.
  const sectionItems: SubNavBarItem[] = (activeRubric?.entries ?? []).map((section) => {
    const locked = isLocked(section);
    return {
      id: section.id,
      icon: section.icon,
      label: sectionStrings[section.id]?.label || section.id,
      locked,
      tooltip: locked ? lockedTitle(section) : undefined,
    };
  });

  // Jump to the first section the plan actually allows (fallback: first entry,
  // which then renders SeoSectionLayout's upsell card). Mirrors RubricNavigation.
  const onSelectRubric = (item: SubNavBarItem) => {
    const rubric: SeoRubricDef | undefined = SEO_RUBRICS.find((r) => r.id === item.id);
    if (!rubric) return;
    const target = rubric.entries.find((e) => !isLocked(e)) || rubric.entries[0];
    if (target) handleNavigate(target.path);
  };

  const onSelectSection = (item: SubNavBarItem) => {
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
        items={rubricItems}
        activeId={activeRubric?.id ?? null}
        onSelect={onSelectRubric}
        ariaLabel="SEO rubrics"
      />

      {/* A single-entry rubric (Übersicht) would render one Level-3 chip that
          just repeats its own Level-2 label — hide the bar in that case. */}
      {sectionItems.length > 1 && (
        <SubNavBar
          items={sectionItems}
          activeId={active?.id ?? null}
          onSelect={onSelectSection}
          ariaLabel="SEO sections"
          variant="level3"
        />
      )}

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

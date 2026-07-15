/**
 * RubricNavigation — Level 2 of the 3-level content navigation (Plan §3.1/§5).
 *
 * Thin wrapper around the shared `SubNavBar` (Level-2 sub-nav also used by the
 * SEO layout). Owns config-to-item mapping and navigation; SubNavBar owns the
 * rendering, sticky behaviour, height measurement, and hover styling.
 *
 * Rendered by ContentTypeNavigation so every content page gets both bars with a
 * single `<ContentTypeNavigation />`. On non-content pages it renders null.
 */

import { useLocation } from "@remix-run/react";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { CONTENT_RUBRICS, getActiveRubric, type RubricDef } from "../config/content-rubrics";
import { SubNavBar, type SubNavBarItem } from "./nav/SubNavBar";

// Fallback labels if the i18n bundle hasn't been updated yet.
const RUBRIC_FALLBACK: Record<string, string> = {
  catalog: "Catalog",
  onlineStore: "Online Store",
  theme: "Theme",
  system: "System",
  directTranslations: "Direct Translations",
};

export function RubricNavigation() {
  const location = useLocation();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { canAccessContentType } = usePlan();
  const { mainNavHeight, setRubricNavHeight } = useNavigationHeight();

  const activeRubric = getActiveRubric(location.pathname);
  if (!activeRubric) return null;

  const rubricLabel = (r: RubricDef) =>
    (t as unknown as { rubrics?: Record<string, string> }).rubrics?.[r.id] ||
    RUBRIC_FALLBACK[r.id] ||
    r.id;

  const items: SubNavBarItem[] = CONTENT_RUBRICS.map((r) => ({
    id: r.id,
    icon: r.icon,
    label: rubricLabel(r),
  }));

  // Navigate to the first plan-accessible entry of a rubric (fallback: first entry).
  const goToRubric = (item: SubNavBarItem) => {
    const r = CONTENT_RUBRICS.find((x) => x.id === item.id);
    if (!r) return;
    const target = r.entries.find((e) => canAccessContentType(e.planContentType)) || r.entries[0];
    if (target) handleNavigate(target.path);
  };

  return (
    <SubNavBar
      items={items}
      activeId={activeRubric.id}
      onSelect={goToRubric}
      ariaLabel="Content rubrics"
      stickyTop={mainNavHeight}
      onMeasure={setRubricNavHeight}
    />
  );
}

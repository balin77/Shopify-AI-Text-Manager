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
import { Outlet, useLoaderData, useLocation, useNavigation } from "react-router";
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
  const { admin, session } = await authenticate.admin(request);
  // Locale count drives the language gate on sections that only say something
  // with a second shop language (hreflang). Read from the 60s locale cache the
  // sections use anyway, so this costs no extra Admin API call in practice.
  //
  // NOT wrapped in a catch: the cache re-throws a 401 Response on purpose so the
  // request can re-authenticate — swallowing it would strand the merchant on a
  // silently degraded page. Every OTHER failure is already swallowed inside the
  // cache, which then resolves with `[]`; an empty list therefore means "lookup
  // failed", not "shop has no locales" (a shop always has at least its primary).
  // Treat it as multi-language so a failed lookup never greys out a section the
  // shop can actually use.
  const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
  const published = (await getCachedShopLocales(admin, session.shop)).filter(
    (l) => l.published !== false,
  ).length;
  return json({ localeCount: published === 0 ? 2 : published });
};

interface SeoSectionStrings {
  label?: string;
}

export default function SeoLayout() {
  const location = useLocation();
  const navigation = useNavigation();
  const { localeCount } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { plan } = usePlan();
  const { handleNavigate } = useAppNavigation();
  const singleLocale = localeCount <= 1;
  const singleLocaleHint = t.common?.requiresSecondLanguage;

  const active = getActiveSeoSection(location.pathname);
  const activeRubric = getActiveSeoRubric(location.pathname);
  const sectionStrings =
    (t.seo as { sections?: Record<string, SeoSectionStrings> }).sections ?? {};
  const rubricStrings = (t.seo as { rubrics?: Record<string, string> }).rubrics ?? {};

  // Section-switch loading feedback: loaders like analyzeStore re-run on every
  // tab click with no visual feedback otherwise. Only swap the outlet for a
  // skeleton when the *target* of the in-flight navigation is itself within
  // /app/seo — the sub-nav (rendered above) stays interactive throughout.
  //
  // The skeleton is for switching SECTION, not for a section updating itself:
  // a section that drives its own view through search params (the keywords
  // page's ?tab= / ?group= / ?loc=) navigates to the SAME pathname, and
  // swapping the outlet for a skeleton there unmounts the section on every
  // click — losing filters, expanded rows and selections and reading as a full
  // page reload. Same pathname → the section keeps rendering its own data.
  const isSeoSectionLoading =
    navigation.state !== "idle"
    && isSeoPath(navigation.location?.pathname ?? "")
    && navigation.location?.pathname !== location.pathname;

  const lockedTitle = (section: (typeof SEO_SECTIONS)[number]) =>
    section.planGate
      ? (t.seo as { upgradeForSection?: string }).upgradeForSection?.replace(
          "{plan}",
          PLAN_DISPLAY_NAMES[section.planGate],
        ) || `Upgrade to ${PLAN_DISPLAY_NAMES[section.planGate]} to use this feature.`
      : undefined;

  const isLocked = (section: (typeof SEO_SECTIONS)[number]) =>
    section.planGate ? !meetsPlan(plan, section.planGate) : false;

  /** Greyed out because the shop has a single language, not because of the plan. */
  const isLanguageGated = (section: (typeof SEO_SECTIONS)[number]) =>
    !!section.requiresMultipleLocales && singleLocale;

  // Level 2 — one chip per rubric. A rubric only shows the lock when EVERY one
  // of its sections is gated above the merchant's plan; a mixed rubric (e.g.
  // Verlinkungen: Weiterleitungen free, Interne Verlinkung Pro) stays open and
  // the lock is carried by the individual Level-3 chip.
  const rubricItems: SubNavBarItem[] = SEO_RUBRICS.map((rubric) => {
    // A rubric whose sections are ALL unavailable — for whichever reason —
    // carries the marker itself; a mixed rubric stays open and the Level-3 chip
    // carries it.
    const locked = rubric.entries.every((e) => isLocked(e) || isLanguageGated(e));
    const firstGated = rubric.entries.find((e) => e.planGate);
    const languageOnly = locked && rubric.entries.every(isLanguageGated);
    return {
      id: rubric.id,
      icon: rubric.icon,
      label: rubricStrings[rubric.id] || rubric.id,
      locked,
      lockIcon: languageOnly ? "🌐" : undefined,
      tooltip: languageOnly
        ? singleLocaleHint
        : locked && firstGated
          ? lockedTitle(firstGated)
          : undefined,
    };
  });

  // Level 3 — sections of the active rubric only.
  const sectionItems: SubNavBarItem[] = (activeRubric?.entries ?? []).map((section) => {
    const planLocked = isLocked(section);
    const languageLocked = isLanguageGated(section);
    return {
      id: section.id,
      icon: section.icon,
      label: sectionStrings[section.id]?.label || section.id,
      locked: planLocked || languageLocked,
      // Plan gate wins the marker: an upgrade unlocks the section outright,
      // while the language hint would still apply afterwards.
      lockIcon: !planLocked && languageLocked ? "🌐" : undefined,
      tooltip: planLocked ? lockedTitle(section) : languageLocked ? singleLocaleHint : undefined,
    };
  });

  // Jump to the first section the plan actually allows (fallback: first entry,
  // which then renders SeoSectionLayout's upsell card). Mirrors RubricNavigation.
  const onSelectRubric = (item: SubNavBarItem) => {
    const rubric: SeoRubricDef | undefined = SEO_RUBRICS.find((r) => r.id === item.id);
    if (!rubric) return;
    const target =
      rubric.entries.find((e) => !isLocked(e) && !isLanguageGated(e)) || rubric.entries[0];
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
    // `seo-layout` marks this route as bringing its own bottom spacing, so the
    // app shell does not reserve the mobile bar inset a second time on top of
    // it (see .app-shell:has(.seo-layout) in responsive.css).
    <div className="seo-layout" style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <SubNavBar
        items={rubricItems}
        activeId={activeRubric?.id ?? null}
        onSelect={onSelectRubric}
        ariaLabel="SEO rubrics"
        placement="app-nav"
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
          placement="app-nav"
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* Width comes from .app-page-width (responsive.css :root) — never
            hardcode a max-width here. SEO sections are reading-width content. */}
        <div className="app-page-width" style={{ padding: "1rem" }}>
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

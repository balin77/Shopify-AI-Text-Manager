/**
 * RubricNavigation — Level 2 of the 3-level content navigation (Plan §3.1/§5).
 *
 * Sits between MainNavigation (Level 1) and ContentTypeNavigation (Level 3) and
 * shows the content rubrics (Katalog / Online Store / Theme / System / Direkte
 * Übersetzungen). Compact by design (Plan §3.2): smaller height, padding, font
 * and active border than the Level 3 bar.
 *
 * Uses position: sticky so the bar takes real layout space and no JS-measured
 * top offset is needed for its initial paint — eliminates the hydration flash
 * that position: fixed produced. The top offset (mainNavHeight) only affects
 * sticky behavior during scrolling, not first paint.
 *
 * Rendered by ContentTypeNavigation so every content page gets both bars with a
 * single `<ContentTypeNavigation />`. On non-content pages it renders null.
 */

import { useLocation } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useEffect, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { CONTENT_RUBRICS, getActiveRubric, type RubricDef } from "../config/content-rubrics";

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
  const navRef = useRef<HTMLDivElement>(null);

  const activeRubric = getActiveRubric(location.pathname);
  const activeRubricId = activeRubric?.id ?? null;

  // Measure the bar (or reset to 0 when not on a content page). The bar itself
  // doesn't need its own height — sticky handles that — so this is only for the
  // L3 bar that needs to know where to stick during scrolling.
  useEffect(() => {
    if (!activeRubric) {
      setRubricNavHeight(0);
      return;
    }
    const update = () => {
      if (navRef.current) setRubricNavHeight(navRef.current.offsetHeight);
    };
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | undefined;
    if (navRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(navRef.current);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeRubric, setRubricNavHeight]);

  if (!activeRubric) return null;

  const rubricLabel = (r: RubricDef) =>
    (t as unknown as { rubrics?: Record<string, string> }).rubrics?.[r.id] || RUBRIC_FALLBACK[r.id] || r.id;

  // Navigate to the first plan-accessible entry of a rubric (fallback: first entry).
  const goToRubric = (r: RubricDef) => {
    const target = r.entries.find((e) => canAccessContentType(e.planContentType)) || r.entries[0];
    if (target) handleNavigate(target.path);
  };

  return (
    <div
      ref={navRef}
      className="desktop-only rubric-nav"
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: "#fafbfb",
        padding: "0.2rem 1rem",
        position: "sticky",
        top: `${mainNavHeight}px`,
        left: 0,
        right: 0,
        zIndex: 999,
        overflowX: "auto",
      }}
    >
      <InlineStack gap="100">
        {CONTENT_RUBRICS.map((r) => {
          const isActive = r.id === activeRubricId;
          return (
            <button
              key={r.id}
              onClick={() => goToRubric(r)}
              aria-current={isActive ? "page" : undefined}
              style={{
                padding: "0.2rem 0.6rem",
                border: isActive ? "2px solid #008060" : "1px solid transparent",
                borderRadius: "6px",
                background: isActive ? "#f1f8f5" : "transparent",
                cursor: "pointer",
                transition: "all 0.15s",
                display: "flex",
                alignItems: "center",
                gap: "0.3rem",
                lineHeight: 1.1,
              }}
            >
              <span style={{ fontSize: "0.9rem" }}>{r.icon}</span>
              <Text as="span" variant="bodySm" fontWeight={isActive ? "semibold" : "regular"}>
                {rubricLabel(r)}
              </Text>
            </button>
          );
        })}
      </InlineStack>
    </div>
  );
}

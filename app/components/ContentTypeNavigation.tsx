/**
 * ContentTypeNavigation — merged Level 2 + Level 3 sub-navigation.
 *
 * Renders a single sticky bar under the MainNavigation that combines the
 * rubric switcher (Katalog / Online Store / Theme / System / Direkte
 * Übersetzungen) on the left with the content-type entries of the active
 * rubric on the right, separated by a thin vertical divider. Replaces the
 * previous two-row layout (RubricNavigation + ContentTypeNavigation) to save
 * vertical space without losing scannability of either level.
 *
 * Sticky-positioning is used instead of position:fixed so the bar takes real
 * space in document flow — no spacer div, no JS-measured top offset, and no
 * hydration flash where the bar briefly overlaps content before the
 * measurement-based top offset kicks in.
 */

import { useLocation, useMatches } from "@remix-run/react";
import { InlineStack, Text, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { getPlanDisplayName as getPlanDisplayNameUtil } from "../utils/planUtils";
import {
  CONTENT_RUBRICS,
  getActiveRubric,
  getActiveEntry,
  type ContentEntryDef,
  type RubricDef,
} from "../config/content-rubrics";
import { useEffect, useRef } from "react";

// Fallback labels if the i18n bundle hasn't been updated yet.
const RUBRIC_FALLBACK: Record<string, string> = {
  catalog: "Catalog",
  onlineStore: "Online Store",
  theme: "Theme",
  system: "System",
  directTranslations: "Direct Translations",
};

export function ContentTypeNavigation() {
  const location = useLocation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { canAccessContentType, getNextPlanUpgrade, plan, getMaxProducts } = usePlan();
  const { mainNavHeight, setContentNavHeight } = useNavigationHeight();
  const navRef = useRef<HTMLDivElement>(null);

  const activeRubric = getActiveRubric(location.pathname);
  const activeRubricId = activeRubric?.id ?? null;
  const activeEntry = getActiveEntry(location.pathname);
  const entries: ContentEntryDef[] = activeRubric?.entries ?? [];

  // Product count (+ at-limit warning) is sourced from the products route loader
  // and shown on the Produkte entry — only populated while on the products page.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productsRouteData = matches.find((m) => m.id === "routes/app.products")?.data as any;
  const productCount: number | undefined = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  const contentLabels = t.content as unknown as Record<string, string>;
  const labelFor = (entry: ContentEntryDef) => contentLabels?.[entry.labelKey] || entry.id;
  const rubricLabel = (r: RubricDef) =>
    (t as unknown as { rubrics?: Record<string, string> }).rubrics?.[r.id] || RUBRIC_FALLBACK[r.id] || r.id;

  // Measure the bar and publish its height (for sticky offsets in the page body
  // and the layout calc in app.menus). The bar itself doesn't need its own
  // height — sticky positioning handles that — so this is purely for consumers.
  useEffect(() => {
    if (!activeRubric) {
      setContentNavHeight(0);
      return;
    }
    const updateHeight = () => {
      if (navRef.current) setContentNavHeight(navRef.current.offsetHeight);
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    let observer: ResizeObserver | undefined;
    if (navRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateHeight);
      observer.observe(navRef.current);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [activeRubric, setContentNavHeight, entries.length]);

  // Navigate to the first plan-accessible entry of a rubric (fallback: first).
  const goToRubric = (r: RubricDef) => {
    const target = r.entries.find((e) => canAccessContentType(e.planContentType)) || r.entries[0];
    if (target) handleNavigate(target.path);
  };

  if (!activeRubric) return null;

  return (
    <div
      ref={navRef}
      className="desktop-only content-type-nav"
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: "white",
        padding: "0.4rem 1rem",
        position: "sticky",
        top: `${mainNavHeight}px`,
        left: 0,
        right: 0,
        zIndex: 998,
        overflowX: "auto",
      }}
    >
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {/* Left: rubric chips (Level 2) — compact, icon + label */}
        {CONTENT_RUBRICS.map((r) => {
          const isActive = r.id === activeRubricId;
          return (
            <button
              key={r.id}
              onClick={() => goToRubric(r)}
              aria-current={isActive ? "page" : undefined}
              style={{
                padding: "0.3rem 0.6rem",
                border: isActive ? "1px solid #008060" : "1px solid transparent",
                borderRadius: "6px",
                background: isActive ? "#f1f8f5" : "transparent",
                cursor: "pointer",
                transition: "all 0.15s",
                display: "flex",
                alignItems: "center",
                gap: "0.3rem",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: "0.95rem" }}>{r.icon}</span>
              <Text as="span" variant="bodySm" fontWeight={isActive ? "semibold" : "regular"}>
                {rubricLabel(r)}
              </Text>
            </button>
          );
        })}

        {/* Vertical divider between rubric chips and content-type chips */}
        <div
          aria-hidden="true"
          style={{
            width: "1px",
            height: "20px",
            background: "#d2d5d8",
            margin: "0 0.4rem",
            flexShrink: 0,
          }}
        />

        {/* Right: content-type chips (Level 3) for the active rubric only */}
        {entries.map((entry) => {
          const hasAccess = canAccessContentType(entry.planContentType);
          const isActive = activeEntry?.id === entry.id;
          const nextPlan = getNextPlanUpgrade();
          const isPlanLocked = !hasAccess;

          const nextPlanName = nextPlan ? getPlanDisplayNameUtil(nextPlan) : "";
          const upgradeHint =
            isPlanLocked && nextPlan
              ? t.content.upgradeToAccessFeature.replace("{plan}", nextPlanName)
              : undefined;

          const showProductCount = entry.id === "products" && productCount !== undefined;
          const isAtLimit = showProductCount && productCount! >= maxProducts && maxProducts !== Infinity;

          const button = (
            <button
              key={entry.id}
              onClick={() => {
                if (hasAccess || isPlanLocked) handleNavigate(entry.path);
              }}
              aria-disabled={!hasAccess}
              aria-current={isActive ? "page" : undefined}
              title={upgradeHint}
              style={{
                padding: "0.35rem 0.7rem",
                border: isActive ? "2px solid #008060" : "1px solid #c9cccf",
                borderRadius: "6px",
                background: isActive ? "#f1f8f5" : !hasAccess ? "#f6f6f7" : "white",
                cursor: isPlanLocked ? "help" : "pointer",
                transition: "all 0.15s",
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                lineHeight: 1.2,
                opacity: !hasAccess ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: "1rem" }}>{entry.icon}</span>
              <Text as="span" variant="bodySm" fontWeight={isActive ? "semibold" : "regular"}>
                {labelFor(entry)}
              </Text>
              {showProductCount && (
                <Text as="span" variant="bodySm" tone={isAtLimit ? "critical" : "subdued"}>
                  ({productCount})
                </Text>
              )}
              {!hasAccess && <span style={{ marginLeft: "0.15rem" }}>🔒</span>}
            </button>
          );

          if (upgradeHint) {
            return (
              <Tooltip key={entry.id} content={upgradeHint}>
                {button}
              </Tooltip>
            );
          }
          if (isAtLimit && plan === "free") {
            return (
              <Tooltip key={entry.id} content={t.products.upgradeForMoreProducts}>
                {button}
              </Tooltip>
            );
          }
          return button;
        })}
      </InlineStack>
    </div>
  );
}

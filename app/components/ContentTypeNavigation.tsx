/**
 * ContentTypeNavigation — Level 3 of the 3-level content navigation.
 *
 * Shows the content-type entries of the ACTIVE rubric only (filtered via the
 * shared content-rubrics config). Renders the Level 2 RubricNavigation above
 * itself so any content page gets both bars with a single
 * `<ContentTypeNavigation />`. Compact styling per Plan §3.2.
 *
 * Uses position: sticky (not fixed) — the bar takes real space in document
 * flow, so no spacer div and no JS-measured top offset for initial paint are
 * needed. The top offset (mainNavHeight + rubricNavHeight) only governs sticky
 * behavior during scrolling.
 */

import { useLocation, useMatches } from "react-router";
import { InlineStack, Text, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { getPlanDisplayName as getPlanDisplayNameUtil, getMinimumPlanForContentType } from "../utils/planUtils";
import { getActiveRubric, getActiveEntry, type ContentEntryDef } from "../config/content-rubrics";
import { RubricNavigation } from "./RubricNavigation";
import { useEffect, useRef } from "react";

export function ContentTypeNavigation() {
  const location = useLocation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { canAccessContentType, plan, getMaxProducts } = usePlan();
  const { mainNavHeight, rubricNavHeight, setContentNavHeight } = useNavigationHeight();
  const navRef = useRef<HTMLDivElement>(null);

  const activeRubric = getActiveRubric(location.pathname);
  const activeEntry = getActiveEntry(location.pathname);
  const allEntries: ContentEntryDef[] = activeRubric?.entries ?? [];

  // Presence of conditional content types from the app root loader. A
  // conditional entry (e.g. Abo-Pläne) is hidden only when the plan is entitled
  // AND the shop has no such content — otherwise it stays (upsell lock for
  // non-entitled plans; fail-open when presence is unknown).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appRootData = matches.find((m) => m.id === "routes/app")?.data as any;
  const conditionalContent: Record<string, boolean> | undefined = appRootData?.conditionalContent;
  const entries = allEntries.filter((entry) => {
    if (!entry.conditional) return true;
    const present = conditionalContent?.[entry.id];
    return !(present === false && canAccessContentType(entry.planContentType));
  });

  // Product count (+ at-limit warning) is sourced from the products route loader
  // and shown on the Produkte entry — only populated while on the products page.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productsRouteData = matches.find((m) => m.id === "routes/app.products")?.data as any;
  const productCount: number | undefined = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  const contentLabels = t.content as unknown as Record<string, string>;
  const labelFor = (entry: ContentEntryDef) => contentLabels?.[entry.labelKey] || entry.id;

  // Measure the bar and publish its height for downstream sticky offsets
  // (UnifiedItemList, UnifiedContentEditor, app.menus.tsx). On non-content
  // pages (no active rubric) the bar renders nothing, so its contributed
  // height must reset to 0 — otherwise the last measured value would leak
  // into sticky offsets now that this component is mounted app-wide.
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

  // Mounted app-wide via the layout route: render nothing on non-content
  // pages so no empty L2/L3 strip appears under the main nav.
  if (!activeRubric) return null;

  return (
    <>
      {/* Level 2 — rubric bar (renders nothing on non-content pages). */}
      <RubricNavigation />

      {/* Level 3 — content-type bar (filtered to the active rubric). Hidden on mobile. */}
      <div
        ref={navRef}
        className="desktop-only content-type-nav"
        style={{
          borderBottom: "1px solid #e1e3e5",
          background: "white",
          // Extra left padding visually indents L3 chips under the L2 bar so
          // hierarchy reads top → down even when the L3 chips are smaller
          // than the L2 chips above them.
          padding: "0.2rem 1rem 0.2rem 2rem",
          position: "sticky",
          top: `${mainNavHeight + rubricNavHeight}px`,
          left: 0,
          right: 0,
          zIndex: 998,
          overflowX: "auto",
        }}
      >
        <InlineStack gap="100">
          {entries.map((entry) => {
            const hasAccess = canAccessContentType(entry.planContentType);
            const isActive = activeEntry?.id === entry.id;
            const isPlanLocked = !hasAccess;

            // Use the plan that actually unlocks THIS content type — not just
            // the next tier up. Free → Basic for pages/policies/delivery, but
            // Free → Pro for articles/templates/menus/…, and Free → Max for
            // direct translations. getNextPlanUpgrade() would wrongly say
            // "Basic" for all of them.
            const requiredPlan = getMinimumPlanForContentType(entry.planContentType);
            const requiredPlanName = requiredPlan ? getPlanDisplayNameUtil(requiredPlan) : "";
            const upgradeHint =
              isPlanLocked && requiredPlan
                ? t.content.upgradeToAccessFeature.replace("{plan}", requiredPlanName)
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
                  // L3 (this bar) reads as a sub-level of L2: flat by default
                  // (transparent bg + border), active state marked by a bottom
                  // underline + subtle bg — looks like a sub-tab rather than a
                  // raised card, so the L2 card-chips above visually dominate.
                  // 2px transparent border on all sides keeps the active state
                  // (which only swaps the bottom edge) from causing layout shift.
                  padding: "0.2rem 0.55rem",
                  border: "2px solid transparent",
                  borderBottom: isActive ? "2px solid #008060" : "2px solid transparent",
                  borderRadius: "4px",
                  background: isActive ? "#f1f8f5" : "transparent",
                  cursor: isPlanLocked ? "help" : "pointer",
                  transition: "all 0.15s",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  lineHeight: 1.1,
                  opacity: !hasAccess ? 0.55 : 1,
                }}
              >
                <span style={{ fontSize: "0.85rem" }}>{entry.icon}</span>
                <Text as="span" variant="bodySm" fontWeight={isActive ? "semibold" : "regular"} tone={isActive ? "base" : "subdued"}>
                  {labelFor(entry)}
                </Text>
                {showProductCount && (
                  <Text as="span" variant="bodySm" tone={isAtLimit ? "critical" : "subdued"}>
                    ({productCount})
                  </Text>
                )}
                {!hasAccess && <span style={{ marginLeft: "0.15rem", fontSize: "0.8rem" }}>🔒</span>}
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
    </>
  );
}

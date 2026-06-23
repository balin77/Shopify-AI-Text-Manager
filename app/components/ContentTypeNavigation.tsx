/**
 * ContentTypeNavigation — Level 3 of the 3-level content navigation.
 *
 * Shows the content-type entries of the ACTIVE rubric only (filtered via the
 * shared content-rubrics config). Renders the Level 2 RubricNavigation above
 * itself so any content page gets both bars with a single
 * `<ContentTypeNavigation />`. Compact styling per Plan §3.2.
 */

import { useLocation, useMatches } from "@remix-run/react";
import { InlineStack, Text, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { getPlanDisplayName as getPlanDisplayNameUtil } from "../utils/planUtils";
import { getActiveRubric, getActiveEntry, type ContentEntryDef } from "../config/content-rubrics";
import { RubricNavigation } from "./RubricNavigation";
import { useState, useEffect, useRef } from "react";

export function ContentTypeNavigation() {
  const location = useLocation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { canAccessContentType, getNextPlanUpgrade, plan, getMaxProducts } = usePlan();
  const { mainNavHeight, rubricNavHeight, setContentNavHeight } = useNavigationHeight();
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(56);
  const [isClient, setIsClient] = useState(false);

  const activeRubric = getActiveRubric(location.pathname);
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

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Measure the bar and publish its height (for sticky offsets + spacer).
  useEffect(() => {
    if (!isClient) return;
    const updateHeight = () => {
      if (navRef.current) {
        const height = navRef.current.offsetHeight;
        setNavHeight(height);
        setContentNavHeight(height);
      }
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    if (navRef.current && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(navRef.current);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", updateHeight);
      };
    }
    return () => window.removeEventListener("resize", updateHeight);
  }, [setContentNavHeight, isClient, entries.length]);

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
          padding: "0.45rem 1rem",
          position: "fixed",
          top: `${mainNavHeight + rubricNavHeight}px`,
          left: 0,
          right: 0,
          zIndex: 998,
          overflowX: "auto",
        }}
      >
        <InlineStack gap="150">
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
                  padding: "0.4rem 0.75rem",
                  border: isActive ? "2px solid #008060" : "1px solid #c9cccf",
                  borderRadius: "6px",
                  background: isActive ? "#f1f8f5" : !hasAccess ? "#f6f6f7" : "white",
                  cursor: isPlanLocked ? "help" : "pointer",
                  transition: "all 0.15s",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  lineHeight: 1.2,
                  opacity: !hasAccess ? 0.6 : 1,
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

      {/* Single spacer for BOTH the rubric and content-type bars. */}
      <div style={{ height: `${rubricNavHeight + navHeight}px` }} />
    </>
  );
}

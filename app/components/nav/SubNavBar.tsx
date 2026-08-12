/**
 * SubNavBar — shared sub-navigation used by RubricNavigation (the "Inhalte"
 * tab: Katalog / Online Store / Theme / …) and by the SEO layout for BOTH of
 * its levels (rubric bar + section bar). Presentational only: the consumer
 * owns the item list, active id and navigation.
 *
 * `variant` picks the level look: "level2" renders raised card-chips, "level3"
 * renders flat, indented sub-tabs (underline + subdued label) — the same
 * styling ContentTypeNavigation uses for Level 3 in the "Inhalte" tab, so both
 * tabs read as the same hierarchy.
 *
 * Keeps the `.rubric-nav` class so the hover style in responsive.css continues
 * to apply.
 *
 * `placement` decides whether the bar survives on mobile. An `app-nav` bar is a
 * level of the GLOBAL navigation, which the hamburger drawer owns below 900px —
 * it gets `desktop-only` so the two don't both render. An `in-page` bar is a
 * switcher belonging to one page (the keywords Bibliothek/Zuordnungen tabs, the
 * sitemap resource-type picker inside a card); the drawer navigates between
 * routes and has no business carrying page state, so those stay visible at every
 * width. `in-page` is the default on purpose: forgetting the prop leaves a
 * control visible, which is the far better failure than silently hiding it.
 */

import { InlineStack, Text } from "@shopify/polaris";
import { useEffect, useRef, type ReactNode } from "react";

export interface SubNavBarItem {
  id: string;
  label: string;
  icon?: string;
  /** Greys the chip out and shows `lockIcon` next to the label. */
  locked?: boolean;
  /**
   * Marker for a locked chip. Defaults to 🔒 (plan gate). Pass something else
   * when the chip is unavailable for a different reason — e.g. 🌐 for a section
   * that needs a second shop language — so a padlock never implies "upgrade".
   */
  lockIcon?: string;
  /** Native tooltip (upgrade hint, etc.). Also used as aria title. */
  tooltip?: string;
}

export interface SubNavBarProps {
  items: SubNavBarItem[];
  activeId: string | null;
  onSelect: (item: SubNavBarItem) => void;
  ariaLabel?: string;
  /** When set, the bar is `position: sticky` with this top offset (px). */
  stickyTop?: number;
  /** Called with the bar's measured height (mount + resize). */
  onMeasure?: (height: number) => void;
  /** Optional content pinned to the far right of the bar (e.g. a HelpTooltip). */
  trailing?: ReactNode;
  /** Visual level: raised card-chips (default) or flat indented sub-tabs. */
  variant?: "level2" | "level3";
  /**
   * `app-nav` = a level of the global navigation, hidden below 900px because the
   * hamburger drawer renders it there. `in-page` (default) = a page-local
   * switcher, visible at every width.
   */
  placement?: "app-nav" | "in-page";
}

export function SubNavBar({
  items,
  activeId,
  onSelect,
  ariaLabel,
  stickyTop,
  onMeasure,
  trailing,
  variant = "level2",
  placement = "in-page",
}: SubNavBarProps) {
  const isL3 = variant === "level3";
  // Hover styling lives in responsive.css per level: `.rubric-nav` (grey chip
  // fill) vs `.content-type-nav` (subtle tint for the flat sub-tabs).
  const levelClass = [
    placement === "app-nav" ? "desktop-only" : "",
    isL3 ? "content-type-nav" : "rubric-nav",
  ]
    .filter(Boolean)
    .join(" ");
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onMeasure) return;
    const update = () => {
      if (navRef.current) onMeasure(navRef.current.offsetHeight);
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
      // Publish 0 on unmount so downstream sticky offsets don't leak the
      // last measured value onto pages that don't render this bar.
      onMeasure(0);
    };
  }, [onMeasure, items.length]);

  return (
    <div
      ref={navRef}
      className={levelClass}
      role="navigation"
      aria-label={ariaLabel}
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: isL3 ? "white" : "#fafbfb",
        // The L3 indent only exists to nest the bar under the L2 bar above it
        // (same offset as ContentTypeNavigation) — an in-page picker has no L2
        // above it and sits inside a card that brings its own padding, so it
        // aligns with the card's own content instead of hanging 2rem inside it.
        padding: isL3
          ? placement === "app-nav"
            ? "0.2rem 1rem 0.2rem 2rem"
            : "0.2rem 0"
          : "0.25rem 1rem",
        ...(stickyTop != null
          ? {
              position: "sticky",
              top: `${stickyTop}px`,
              left: 0,
              right: 0,
              zIndex: isL3 ? 998 : 999,
            }
          : {}),
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <div style={{ overflowX: "auto", flex: 1, minWidth: 0 }}>
      <InlineStack gap={isL3 ? "100" : "150"}>
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item)}
              aria-current={isActive ? "page" : undefined}
              title={item.tooltip}
              style={
                isL3
                  ? {
                      // Flat sub-tab: only the bottom edge marks the active
                      // state, so the L2 card-chips above stay dominant. The
                      // 2px transparent border on all sides prevents layout
                      // shift when that edge turns green.
                      padding: "0.2rem 0.55rem",
                      border: "2px solid transparent",
                      borderBottom: isActive ? "2px solid #008060" : "2px solid transparent",
                      borderRadius: "4px",
                      background: isActive ? "#f1f8f5" : "transparent",
                      cursor: item.locked ? "help" : "pointer",
                      transition: "all 0.15s",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      lineHeight: 1.1,
                      opacity: item.locked ? 0.55 : 1,
                    }
                  : {
                      // 2px transparent border on inactive avoids any layout shift
                      // when switching to the 2px green active border.
                      padding: "0.25rem 0.75rem",
                      border: isActive ? "2px solid #008060" : "2px solid #e1e3e5",
                      borderRadius: "6px",
                      background: isActive ? "#f1f8f5" : "white",
                      cursor: item.locked ? "help" : "pointer",
                      transition: "all 0.15s",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      lineHeight: 1.1,
                    }
              }
            >
              {item.icon && (
                <span style={{ fontSize: isL3 ? "0.85rem" : "1rem" }}>{item.icon}</span>
              )}
              <Text
                as="span"
                variant="bodySm"
                fontWeight={isActive ? "semibold" : "regular"}
                tone={isL3 && !isActive ? "subdued" : "base"}
              >
                {item.label}
              </Text>
              {item.locked && (
                <span style={{ marginLeft: "0.15rem", fontSize: isL3 ? "0.8rem" : "0.85rem" }}>
                  {item.lockIcon ?? "🔒"}
                </span>
              )}
            </button>
          );
        })}
      </InlineStack>
      </div>
      {trailing && <div style={{ flexShrink: 0 }}>{trailing}</div>}
    </div>
  );
}

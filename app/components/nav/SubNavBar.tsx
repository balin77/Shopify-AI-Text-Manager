/**
 * SubNavBar — shared Level-2 sub-navigation used by RubricNavigation (the
 * "Inhalte" tab: Katalog / Online Store / Theme / …) and the SEO layout's
 * section bar (Übersicht / Structured Data / …). Presentational only: the
 * consumer owns the item list, active id and navigation.
 *
 * Keeps the `.rubric-nav` class so the hover style in responsive.css continues
 * to apply. `desktop-only` hides the bar on mobile — the drawer/hamburger
 * handles those levels on small screens.
 */

import { InlineStack, Text } from "@shopify/polaris";
import { useEffect, useRef, type ReactNode } from "react";

export interface SubNavBarItem {
  id: string;
  label: string;
  icon?: string;
  /** Shows a 🔒 next to the label. */
  locked?: boolean;
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
}

export function SubNavBar({
  items,
  activeId,
  onSelect,
  ariaLabel,
  stickyTop,
  onMeasure,
  trailing,
}: SubNavBarProps) {
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
      className="desktop-only rubric-nav"
      role="navigation"
      aria-label={ariaLabel}
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: "#fafbfb",
        padding: "0.25rem 1rem",
        ...(stickyTop != null
          ? { position: "sticky", top: `${stickyTop}px`, left: 0, right: 0, zIndex: 999 }
          : {}),
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <div style={{ overflowX: "auto", flex: 1, minWidth: 0 }}>
      <InlineStack gap="150">
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item)}
              aria-current={isActive ? "page" : undefined}
              title={item.tooltip}
              style={{
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
              }}
            >
              {item.icon && <span style={{ fontSize: "1rem" }}>{item.icon}</span>}
              <Text
                as="span"
                variant="bodySm"
                fontWeight={isActive ? "semibold" : "regular"}
              >
                {item.label}
              </Text>
              {item.locked && (
                <span style={{ marginLeft: "0.15rem", fontSize: "0.85rem" }}>🔒</span>
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

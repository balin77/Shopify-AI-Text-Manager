/**
 * SidebarTabBar — the underlined tab row used by the content editor's right
 * sidebar, at both of its levels:
 *
 *   [ SEO Score | Image processing ]        ← size "md" (the section switch)
 *     [ Score | Keywords | JSON-LD ]  ?     ← size "sm" (inside the SEO card)
 *     [ Bulk upload | Bulk alt text ]  ?    ← size "sm" (image processing)
 *
 * Before this component the three bars were three copies of the same inline
 * styles that had already drifted apart — different font sizes, different
 * padding, auto-width buttons on one side and `flex: 1` on the others, and a
 * help "?" on exactly one of them. Sharing the markup is what keeps the two
 * halves of the sidebar looking like one thing.
 *
 * This is deliberately NOT SubNavBar: that one is the app's page-level
 * navigation (raised chips, green accent). This is the in-card tab look (flat,
 * blue underline) and mixing the two is what made the sidebar look assembled
 * from parts.
 *
 * With a single item the buttons and the divider are dropped — a lone
 * permanently-active tab is noise — but the row survives so the "?" keeps its
 * place.
 */

import type { CSSProperties } from "react";
import { HelpTooltip } from "./HelpTooltip";

export interface SidebarTabBarItem {
  id: string;
  label: string;
}

interface SidebarTabBarProps {
  items: SidebarTabBarItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /**
   * `t.help` key for the "?" pinned to the right. Usually the ACTIVE tab's key
   * — the popover explains what you are looking at. Omit for no help button.
   */
  helpKey?: string;
  /** "md" = the section switch, "sm" = a tab row inside a section. */
  size?: "md" | "sm";
  /** Margin nudges for the specific slot the bar sits in. */
  containerStyle?: CSSProperties;
}

const ACTIVE_COLOR = "#005bd3";

export function SidebarTabBar({
  items,
  activeId,
  onSelect,
  helpKey,
  size = "sm",
  containerStyle,
}: SidebarTabBarProps) {
  const showTabs = items.length > 1;
  if (!showTabs && !helpKey) return null;

  const fontSize = size === "md" ? 13 : 12;
  const padding = size === "md" ? "8px 4px" : "6px 4px";

  return (
    <div
      // role="tablist"/"tab" rather than aria-current: these switch panes
      // inside the sidebar, they do not navigate, and "page" would tell a
      // screen-reader user they are on a different page. aria-controls is
      // omitted deliberately — the panes are rendered by three different
      // callers and carry no stable ids to point at.
      role="tablist"
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: showTabs ? "1px solid #e1e3e5" : undefined,
        flexShrink: 0,
        ...containerStyle,
      }}
    >
      {showTabs &&
        items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(item.id)}
              style={{
                flex: 1,
                padding,
                border: "none",
                background: "none",
                borderBottom: isActive ? `2px solid ${ACTIVE_COLOR}` : "2px solid transparent",
                cursor: "pointer",
                fontWeight: isActive ? 600 : 400,
                fontSize,
                color: isActive ? ACTIVE_COLOR : "#616161",
              }}
            >
              {item.label}
            </button>
          );
        })}
      {helpKey && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <HelpTooltip helpKey={helpKey} position="below" />
        </div>
      )}
    </div>
  );
}

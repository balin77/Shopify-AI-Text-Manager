/**
 * Mobile Menu Component
 *
 * The hamburger drawer is the ONLY place the navigation levels live on mobile —
 * the desktop L2/L3 bars (SubNavBar, ContentTypeNavigation) are hidden below
 * 900px, so everything below Level 1 has to be reachable from here.
 *
 * It therefore renders the full 3-level tree, with each level styled distinctly
 * so the hierarchy is readable at a glance:
 *
 *   LEVEL 1  tab rows            — 15px, medium/semibold, dark, 4px active rail
 *   LEVEL 2  rubric headers      — 11px uppercase, subdued, indented, own rail
 *   LEVEL 3  entry rows          — 14px, indented again, green active marker
 *
 * A Level-1 tab that owns rubrics (Inhalte, SEO) expands instead of navigating —
 * its destination is always one of the Level-3 entries below it. A Level-2
 * rubric with a single entry (e.g. Direkte Übersetzungen, SEO-Übersicht) is
 * rendered as a direct link instead of an accordion that reveals its own name.
 */

import { useState, useEffect } from "react";
import { useLocation } from "react-router";
import { Icon } from "@shopify/polaris";
import { MenuIcon, XIcon, ChevronRightIcon, ChevronDownIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useAppNavigation } from "../hooks/useAppNavigation";

/** One Level-3 entry (a route). */
export interface MobileNavEntry {
  id: string;
  label: string;
  icon?: string;
  path: string;
  /** Shows `lockIcon` and dims the row; the row still navigates (upsell page). */
  locked?: boolean;
  /**
   * Marker for a locked row. Defaults to 🔒 (plan gate). Pass something else
   * when the row is unavailable for another reason — e.g. 🌐 for a section that
   * needs a second shop language — so a padlock never implies "upgrade".
   */
  lockIcon?: string;
  /** Small trailing number (product count). */
  count?: number;
  /** Renders `count` in the critical tone (plan limit reached). */
  countCritical?: boolean;
}

/** One Level-2 rubric grouping several Level-3 entries. */
export interface MobileNavGroup {
  id: string;
  label: string;
  icon?: string;
  entries: MobileNavEntry[];
}

interface MobileMenuProps {
  /** Id of the active Level-1 tab. */
  activeTab?: string;
  /** Level-2 rubrics (with their Level-3 entries) of the "Inhalte" tab. */
  contentGroups?: MobileNavGroup[];
  /** Level-2 rubrics (with their Level-3 entries) of the SEO tab. */
  seoGroups?: MobileNavGroup[];
}

/** Same matcher the route configs use — a plain startsWith would over-match. */
const pathMatches = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(path + "/");

const ACTIVE_L1 = "#303030"; // matches the desktop Level-1 tab underline
const ACTIVE_L3 = "#008060"; // matches the desktop Level-3 chip underline

export function MobileMenu({ activeTab, contentGroups = [], seoGroups = [] }: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  /** Which Level-1 tab is unfolded (accordion — at most one). */
  const [openTab, setOpenTab] = useState<string | null>(activeTab ?? null);
  /** Which Level-2 rubrics are unfolded, by `${tabId}:${groupId}`. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const location = useLocation();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { getPlanDisplayName } = usePlan();
  const { runningTaskCount } = useTaskCount();

  const navContentLabel = (t.nav as unknown as Record<string, string>).content || t.nav.otherContent;
  const tabs = [
    { id: "content", label: navContentLabel, path: "/app/products", groups: contentGroups },
    { id: "bulk", label: t.nav.bulk, path: "/app/bulk", groups: [] as MobileNavGroup[] },
    { id: "seo", label: t.nav.seo, path: "/app/seo", groups: seoGroups },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks", groups: [] as MobileNavGroup[] },
    { id: "settings", label: t.nav.settings, path: "/app/settings", groups: [] as MobileNavGroup[] },
  ];

  // Unfold the branch the merchant is currently standing in: the active tab and,
  // inside it, the rubric that owns the current route. Re-runs on navigation so
  // the drawer always opens showing "where am I".
  useEffect(() => {
    setOpenTab(activeTab ?? null);
    const owning = [...contentGroups, ...seoGroups].find((g) =>
      g.entries.some((e) => pathMatches(location.pathname, e.path)),
    );
    if (owning && activeTab) {
      setOpenGroups({ [`${activeTab}:${owning.id}`]: true });
    }
    // contentGroups/seoGroups are rebuilt on every render of the parent, so they
    // must not be dependencies — pathname + activeTab fully describe the branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, location.pathname]);

  // Escape closes the drawer (the backdrop handles pointer dismissal).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  const handleNavigation = (path: string) => {
    setIsOpen(false);
    handleNavigate(path);
  };

  const handlePlanNavigation = () => {
    const searchParams = new URLSearchParams();
    searchParams.set("tab", "plan");
    setIsOpen(false);
    handleNavigate("/app/settings", { searchParams });
  };

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  /** Level-3 row — the deepest level, so it carries the real active marker. */
  const renderEntry = (entry: MobileNavEntry) => {
    const isActive = pathMatches(location.pathname, entry.path);
    return (
      <button
        key={entry.id}
        onClick={() => handleNavigation(entry.path)}
        className={`mobile-menu-item ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "9px 12px 9px 14px",
          border: "none",
          borderLeft: isActive ? `3px solid ${ACTIVE_L3}` : "3px solid transparent",
          background: isActive ? "#f1f8f5" : "transparent",
          cursor: "pointer",
          fontSize: "14px",
          fontWeight: isActive ? 600 : 400,
          color: isActive ? "#202223" : "#5c5f62",
          textAlign: "left",
          opacity: entry.locked ? 0.6 : 1,
          transition: "background-color 150ms ease",
        }}
      >
        {entry.icon && <span style={{ fontSize: "13px" }}>{entry.icon}</span>}
        <span style={{ flex: 1, minWidth: 0 }}>{entry.label}</span>
        {entry.count !== undefined && (
          <span
            style={{
              fontSize: "12px",
              fontWeight: 500,
              color: entry.countCritical ? "#d72c0d" : "#6d7175",
            }}
          >
            {entry.count}
          </span>
        )}
        {entry.locked && (
          <span style={{ fontSize: "12px" }} aria-hidden="true">
            {entry.lockIcon ?? "🔒"}
          </span>
        )}
      </button>
    );
  };

  /** Level-2 rubric — an accordion header, or a direct link when it owns one entry. */
  const renderGroup = (tabId: string, group: MobileNavGroup) => {
    const key = `${tabId}:${group.id}`;
    const containsActive = group.entries.some((e) => pathMatches(location.pathname, e.path));

    // A one-entry rubric would open to reveal nothing but its own name — link
    // straight to the entry instead (Direkte Übersetzungen, SEO-Übersicht).
    if (group.entries.length === 1) {
      const only = group.entries[0];
      return (
        <button
          key={group.id}
          onClick={() => handleNavigation(only.path)}
          className={`mobile-menu-item ${containsActive ? "active" : ""}`}
          aria-current={containsActive ? "page" : undefined}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 12px",
            border: "none",
            background: containsActive ? "#f6f6f7" : "transparent",
            cursor: "pointer",
            textAlign: "left",
            transition: "background-color 150ms ease",
          }}
        >
          {group.icon && <span style={{ fontSize: "13px" }}>{group.icon}</span>}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: containsActive ? "#202223" : "#6d7175",
            }}
          >
            {group.label}
          </span>
          {only.locked && (
            <span style={{ fontSize: "12px" }} aria-hidden="true">
              {only.lockIcon ?? "🔒"}
            </span>
          )}
        </button>
      );
    }

    const expanded = !!openGroups[key];
    return (
      <div key={group.id}>
        <button
          onClick={() => toggleGroup(key)}
          className="mobile-menu-item"
          aria-expanded={expanded}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 12px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            transition: "background-color 150ms ease",
          }}
        >
          {group.icon && <span style={{ fontSize: "13px" }}>{group.icon}</span>}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: containsActive ? "#202223" : "#6d7175",
            }}
          >
            {group.label}
          </span>
          <span style={{ display: "flex", opacity: 0.6 }}>
            <Icon source={expanded ? ChevronDownIcon : ChevronRightIcon} />
          </span>
        </button>

        {/* Level 3 — a second rail marks one more step of nesting. */}
        {expanded && (
          <div style={{ marginLeft: "12px", borderLeft: "1px solid #ebecef" }}>
            {group.entries.map(renderEntry)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Hamburger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="mobile-menu-toggle"
        aria-label={isOpen ? "Close menu" : "Open menu"}
        aria-expanded={isOpen}
        style={{
          background: "none",
          border: "none",
          padding: "8px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon source={isOpen ? XIcon : MenuIcon} />
      </button>

      {/* Mobile Menu Overlay */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="mobile-menu-backdrop"
            onClick={() => setIsOpen(false)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              zIndex: 1001,
            }}
            aria-hidden="true"
          />

          {/* Slide-in Menu */}
          <nav
            className="mobile-menu-panel"
            role="navigation"
            aria-label="Mobile navigation menu"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              // Wider than before: three indent steps plus the longest labels
              // ("Direkte Übersetzungen") no longer have to wrap.
              width: "300px",
              maxWidth: "88vw",
              backgroundColor: "white",
              zIndex: 1002,
              overflowY: "auto",
              boxShadow: "2px 0 8px rgba(0, 0, 0, 0.15)",
              animation: "slideInLeft 250ms ease-out",
            }}
          >
            {/* Menu Header */}
            <div
              style={{
                padding: "16px",
                borderBottom: "1px solid #e1e3e5",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontSize: "18px", fontWeight: "600" }}>Menu</span>
              <button
                onClick={() => setIsOpen(false)}
                aria-label="Close menu"
                style={{
                  background: "none",
                  border: "none",
                  padding: "8px",
                  cursor: "pointer",
                }}
              >
                <Icon source={XIcon} />
              </button>
            </div>

            {/* Level 1 — main tabs */}
            <div style={{ padding: "8px 0" }}>
              {tabs.map((tab) => {
                const isActive = activeTab
                  ? tab.id === activeTab
                  : pathMatches(location.pathname, tab.path);
                const showTaskCount = tab.id === "tasks" && runningTaskCount > 0;
                const hasGroups = tab.groups.length > 0;
                const expanded = hasGroups && openTab === tab.id;

                return (
                  <div key={tab.id}>
                    <button
                      // A tab that owns rubrics unfolds them; its own landing
                      // page is always one of the Level-3 entries below.
                      onClick={() =>
                        hasGroups
                          ? setOpenTab(expanded ? null : tab.id)
                          : handleNavigation(tab.path)
                      }
                      className={`mobile-menu-item ${isActive ? "active" : ""}`}
                      aria-current={isActive && !hasGroups ? "page" : undefined}
                      aria-expanded={hasGroups ? expanded : undefined}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "12px 16px",
                        border: "none",
                        borderLeft: isActive
                          ? `4px solid ${ACTIVE_L1}`
                          : "4px solid transparent",
                        background: isActive ? "#f6f6f7" : "transparent",
                        cursor: "pointer",
                        fontSize: "15px",
                        fontWeight: isActive ? 600 : 500,
                        color: isActive ? "#202223" : "#5c5f62",
                        textAlign: "left",
                        transition: "background-color 150ms ease",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>{tab.label}</span>
                      {showTaskCount && (
                        <span
                          style={{
                            backgroundColor: "#0066CC",
                            color: "white",
                            borderRadius: "10px",
                            padding: "2px 8px",
                            fontSize: "12px",
                            fontWeight: 600,
                            minWidth: "20px",
                            textAlign: "center",
                          }}
                        >
                          {runningTaskCount}
                        </span>
                      )}
                      {hasGroups && (
                        <span style={{ display: "flex", opacity: 0.6 }}>
                          <Icon source={expanded ? ChevronDownIcon : ChevronRightIcon} />
                        </span>
                      )}
                    </button>

                    {/* Level 2 — a rail plus indent marks the step down. */}
                    {expanded && (
                      <div
                        style={{
                          margin: "2px 0 6px 20px",
                          borderLeft: "1px solid #e1e3e5",
                        }}
                      >
                        {tab.groups.map((group) => renderGroup(tab.id, group))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Plan Link */}
            <div style={{ padding: "8px 0", borderTop: "1px solid #e1e3e5" }}>
              <button
                onClick={handlePlanNavigation}
                className="mobile-menu-item"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  border: "none",
                  background: "transparent",
                  borderLeft: "4px solid transparent",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: "400",
                  color: "#5c5f62",
                  textAlign: "left",
                }}
              >
                <span>{getPlanDisplayName()}</span>
              </button>
            </div>

            {/* The drawer is viewport-fixed, so the app shell's bottom inset
                does not apply to it. A real spacer (rather than padding on the
                scroll container, which some engines drop) keeps the last row
                scrollable clear of the Shopify mobile button bar. */}
            <div aria-hidden="true" style={{ height: "var(--app-bottom-inset)" }} />
          </nav>
        </>
      )}

      <style>{`
        @keyframes slideInLeft {
          from {
            transform: translateX(-100%);
          }
          to {
            transform: translateX(0);
          }
        }

        .mobile-menu-item:hover:not(:disabled) {
          background-color: #f6f6f7 !important;
        }

        .mobile-menu-item:active:not(:disabled) {
          background-color: #e4e5e7 !important;
        }
      `}</style>
    </>
  );
}

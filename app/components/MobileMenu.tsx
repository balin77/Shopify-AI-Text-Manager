/**
 * Mobile Menu Component
 *
 * Hamburger menu for mobile devices that includes:
 * - Main navigation tabs (Products, Content, Tasks, Settings)
 * - Content type navigation (Collections, Blogs, Pages, etc.)
 * - Plan selector (shows only current plan, expandable)
 */

import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "@remix-run/react";
import { Icon } from "@shopify/polaris";
import { MenuIcon, XIcon, ChevronRightIcon, ChevronDownIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import type { Plan } from "../config/plans";

interface MobileMenuProps {
  /** Current active tab */
  activeTab?: string;
  /** Product count for display */
  productCount?: number;
  /** Maximum products allowed */
  maxProducts?: number;
  /** Content types for secondary navigation */
  contentTypes?: Array<{
    id: string;
    label: string;
    icon: string;
    path: string;
    comingSoon?: boolean;
  }>;
  /** Show content type navigation */
  showContentTypes?: boolean;
}

export function MobileMenu({
  activeTab,
  productCount,
  maxProducts,
  contentTypes = [],
  showContentTypes = false,
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isContentExpanded, setIsContentExpanded] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { plan, getPlanDisplayName } = usePlan();
  const { runningTaskCount } = useTaskCount();

  // Auto-expand content submenu when on a content page
  useEffect(() => {
    if (showContentTypes) {
      setIsContentExpanded(true);
    }
  }, [showContentTypes]);

  // Level 1 slimmed to match desktop (Plan §3.4): a single "Inhalte" entry
  // (lands on Produkte); the full content list lives in the expandable section
  // below.
  const navContentLabel = (t.nav as unknown as Record<string, string>).content || t.nav.otherContent;
  const tabs = [
    { id: "content", label: navContentLabel, path: "/app/products" },
    { id: "seo", label: t.nav.seo, path: "/app/seo" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const plans: Plan[] = ["free", "basic", "pro", "max"];

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
              width: "280px",
              maxWidth: "85vw",
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

            {/* Main Navigation Tabs */}
            <div style={{ padding: "8px 0" }}>
              {tabs.map((tab) => {
                // Use the content-aware activeTab from the parent (lights "Inhalte"
                // on every content page, not just /app/products); fall back to a
                // path match for tasks/settings.
                const isActive = activeTab ? tab.id === activeTab : location.pathname.startsWith(tab.path);
                const showTaskCount = tab.id === "tasks" && runningTaskCount && runningTaskCount > 0;
                const isContentTab = tab.id === "content";
                const hasContentTypes = contentTypes.length > 0;

                return (
                  <div key={tab.id}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <button
                        onClick={() => handleNavigation(tab.path)}
                        className={`mobile-menu-item ${isActive ? "active" : ""}`}
                        aria-current={isActive ? "page" : undefined}
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "12px 16px",
                          border: "none",
                          background: isActive ? "#f6f6f7" : "transparent",
                          borderLeft: isActive ? "4px solid #0066CC" : "4px solid transparent",
                          cursor: "pointer",
                          fontSize: "15px",
                          fontWeight: isActive ? "600" : "400",
                          color: isActive ? "#202223" : "#5c5f62",
                          textAlign: "left",
                          transition: "background-color 150ms ease",
                        }}
                      >
                        <span>{tab.label}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {showTaskCount && (
                            <div
                              style={{
                                backgroundColor: "#0066CC",
                                color: "white",
                                borderRadius: "10px",
                                padding: "2px 8px",
                                fontSize: "12px",
                                fontWeight: "600",
                                minWidth: "20px",
                                textAlign: "center",
                              }}
                            >
                              {runningTaskCount}
                            </div>
                          )}
                        </div>
                      </button>

                      {/* Toggle button for content submenu */}
                      {isContentTab && hasContentTypes && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsContentExpanded(!isContentExpanded);
                          }}
                          aria-label={isContentExpanded ? "Collapse content types" : "Expand content types"}
                          aria-expanded={isContentExpanded}
                          style={{
                            background: "none",
                            border: "none",
                            padding: "12px 16px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                          }}
                        >
                          <Icon source={isContentExpanded ? ChevronDownIcon : ChevronRightIcon} />
                        </button>
                      )}
                    </div>

                    {/* Content Types Submenu - collapsible */}
                    {isContentTab && hasContentTypes && isContentExpanded && (
                      <div style={{ paddingLeft: "12px" }}>
                        {contentTypes.map((type) => {
                          const isContentTypeActive = location.pathname === type.path || location.pathname.startsWith(type.path);

                          return (
                            <button
                              key={type.id}
                              onClick={() => !type.comingSoon && handleNavigation(type.path)}
                              disabled={type.comingSoon}
                              className={`mobile-menu-item ${isContentTypeActive ? "active" : ""}`}
                              style={{
                                width: "100%",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "10px 16px",
                                border: "none",
                                background: isContentTypeActive ? "#f6f6f7" : "transparent",
                                borderLeft: isContentTypeActive ? "4px solid #0066CC" : "4px solid transparent",
                                cursor: type.comingSoon ? "not-allowed" : "pointer",
                                fontSize: "14px",
                                fontWeight: isContentTypeActive ? "600" : "400",
                                color: type.comingSoon ? "#b5b5b5" : isContentTypeActive ? "#202223" : "#5c5f62",
                                textAlign: "left",
                                opacity: type.comingSoon ? 0.5 : 1,
                                transition: "background-color 150ms ease",
                              }}
                            >
                              <span>{type.icon}</span>
                              <span style={{ flex: 1 }}>{type.label}</span>
                              {type.id === "products" && productCount !== undefined && (
                                <span
                                  style={{
                                    fontSize: "12px",
                                    fontWeight: "500",
                                    color:
                                      maxProducts !== undefined && maxProducts !== Infinity && productCount >= maxProducts
                                        ? "#d72c0d"
                                        : "#6d7175",
                                  }}
                                >
                                  {productCount}
                                </span>
                              )}
                              {type.comingSoon && (
                                <span style={{ fontSize: "11px", color: "#6d7175" }}>Soon</span>
                              )}
                            </button>
                          );
                        })}
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

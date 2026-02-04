/**
 * Mobile Menu Component
 *
 * Hamburger menu for mobile devices that includes:
 * - Main navigation tabs (Products, Content, Tasks, Settings)
 * - Content type navigation (Collections, Blogs, Pages, etc.)
 * - Plan selector (shows only current plan, expandable)
 */

import { useState } from "react";
import { useLocation, useNavigate } from "@remix-run/react";
import { Icon } from "@shopify/polaris";
import { MenuIcon, XIcon, ChevronRightIcon, ChevronDownIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import type { Plan } from "../config/plans";

interface MobileMenuProps {
  /** Current active tab */
  activeTab?: string;
  /** Product count for display */
  productCount?: number;
  /** Maximum products allowed */
  maxProducts?: number;
  /** Running task count */
  runningTaskCount?: number;
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
  runningTaskCount,
  contentTypes = [],
  showContentTypes = false,
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPlanExpanded, setIsPlanExpanded] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { plan, getPlanDisplayName } = usePlan();

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app/products" },
    { id: "content", label: t.nav.otherContent, path: "/app/collections" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  const handleNavigation = (path: string) => {
    const searchParams = new URLSearchParams(location.search);
    const newPath = `${path}?${searchParams.toString()}`;
    navigate(newPath);
    setIsOpen(false);
  };

  const handlePlanNavigation = (planOption?: Plan) => {
    const searchParams = new URLSearchParams(location.search);
    searchParams.set("tab", "plan");
    navigate(`/app/settings?${searchParams.toString()}`);
    setIsOpen(false);
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
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "#6d7175",
                  padding: "8px 16px",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {t.nav.mainNavigation || "Navigation"}
              </div>
              {tabs.map((tab) => {
                const isActive = location.pathname.startsWith(tab.path);
                const showProductCount = tab.id === "products" && productCount !== undefined;
                const isAtLimit = showProductCount && productCount >= (maxProducts || Infinity);
                const showTaskCount = tab.id === "tasks" && runningTaskCount && runningTaskCount > 0;

                return (
                  <button
                    key={tab.id}
                    onClick={() => handleNavigation(tab.path)}
                    className={`mobile-menu-item ${isActive ? "active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    style={{
                      width: "100%",
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
                    {showProductCount && (
                      <span
                        style={{
                          fontSize: "13px",
                          color: isAtLimit ? "#d72c0d" : "#6d7175",
                          fontWeight: "500",
                        }}
                      >
                        {productCount}
                      </span>
                    )}
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
                  </button>
                );
              })}
            </div>

            {/* Content Type Navigation (if provided) */}
            {showContentTypes && contentTypes.length > 0 && (
              <div style={{ padding: "8px 0", borderTop: "1px solid #e1e3e5" }}>
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#6d7175",
                    padding: "8px 16px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  {t.content?.contentTypes || "Content Types"}
                </div>
                {contentTypes.map((type) => {
                  const isActive = location.pathname === type.path || location.pathname.startsWith(type.path);

                  return (
                    <button
                      key={type.id}
                      onClick={() => !type.comingSoon && handleNavigation(type.path)}
                      disabled={type.comingSoon}
                      className={`mobile-menu-item ${isActive ? "active" : ""}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "12px 16px",
                        border: "none",
                        background: isActive ? "#f6f6f7" : "transparent",
                        borderLeft: isActive ? "4px solid #0066CC" : "4px solid transparent",
                        cursor: type.comingSoon ? "not-allowed" : "pointer",
                        fontSize: "15px",
                        fontWeight: isActive ? "600" : "400",
                        color: type.comingSoon ? "#b5b5b5" : isActive ? "#202223" : "#5c5f62",
                        textAlign: "left",
                        opacity: type.comingSoon ? 0.5 : 1,
                        transition: "background-color 150ms ease",
                      }}
                    >
                      <span>{type.icon}</span>
                      <span style={{ flex: 1 }}>{type.label}</span>
                      {type.comingSoon && (
                        <span style={{ fontSize: "11px", color: "#6d7175" }}>Soon</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Plan Selector (Collapsible) */}
            <div style={{ padding: "8px 0", borderTop: "1px solid #e1e3e5" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "#6d7175",
                  padding: "8px 16px",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {t.settings?.subscriptionPlan || "Plan"}
              </div>

              {/* Current Plan - Always Visible */}
              <button
                onClick={() => setIsPlanExpanded(!isPlanExpanded)}
                className="mobile-menu-item"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  border: "none",
                  background: "#f6f6f7",
                  borderLeft: "4px solid #0066CC",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: "600",
                  color: "#202223",
                  textAlign: "left",
                }}
              >
                <span>{getPlanDisplayName(plan)}</span>
                <Icon source={isPlanExpanded ? ChevronDownIcon : ChevronRightIcon} />
              </button>

              {/* Other Plans - Expandable */}
              {isPlanExpanded && (
                <div style={{ paddingLeft: "12px" }}>
                  {plans.filter(p => p !== plan).map((planOption) => (
                    <button
                      key={planOption}
                      onClick={() => handlePlanNavigation(planOption)}
                      className="mobile-menu-item"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        padding: "10px 16px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: "14px",
                        fontWeight: "400",
                        color: "#5c5f62",
                        textAlign: "left",
                      }}
                    >
                      {planOption.charAt(0).toUpperCase() + planOption.slice(1)}
                    </button>
                  ))}
                </div>
              )}
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

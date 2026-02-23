import { useLocation, useNavigate, useMatches, useNavigation } from "@remix-run/react";
import { InlineStack, Text, Banner, ButtonGroup, Button, Tooltip, Spinner, Popover, Scrollable, Icon } from "@shopify/polaris";
import { NotificationIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { MobileMenu } from "./MobileMenu";
import { UnifiedItemSelectorCompact } from "./unified/UnifiedItemSelectorCompact";
import { type Plan, PLAN_DISPLAY_NAMES } from "../config/plans";
import { extractReadableName } from "../utils/templates-field-factory";
import { useState, useEffect, useRef, useCallback } from "react";
import type { InfoBoxTone } from "../contexts/InfoBoxContext";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { infoBox, hideInfoBox, showInfoBox, isGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory } = useInfoBox();
  const [popoverActive, setPopoverActive] = useState(false);
  const { plan, getPlanDisplayName, getMaxProducts } = usePlan();
  const { setMainNavHeight } = useNavigationHeight();
  const { items, selectedItemId, onItemSelect, resourceName, t: itemSelectorT } = useItemSelector();
  const { runningTaskCount, recentlyCompletedTasks } = useTaskCount();
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(73);
  const notifiedTaskIds = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  // Show notifications for newly completed tasks (from context)
  useEffect(() => {
    if (!recentlyCompletedTasks.length || !isMountedRef.current) return;

    for (const task of recentlyCompletedTasks) {
      if (notifiedTaskIds.current.has(task.id)) continue;

      notifiedTaskIds.current.add(task.id);

      let message = "";
      const resourceTitle = task.resourceTitle || "";

      if (task.type === "bulkTranslation") {
        if (task.fieldType === "all") {
          message = t.tasks?.translationCompleted?.replace("{title}", resourceTitle) || `Translation completed for "${resourceTitle}"`;
        } else {
          const rawFieldType = task.fieldType || "field";
          const fieldName = (rawFieldType.includes('.') || rawFieldType.includes(':'))
            ? extractReadableName(rawFieldType)
            : rawFieldType;
          message = t.tasks?.fieldTranslationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
            || `Translation completed for ${fieldName} in "${resourceTitle}"`;
        }
      } else if (task.type === "aiGeneration") {
        const rawFieldType = task.fieldType || "content";
        const fieldName = (rawFieldType.includes('.') || rawFieldType.includes(':'))
          ? extractReadableName(rawFieldType)
          : rawFieldType;
        message = t.tasks?.generationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
          || `AI generation completed for ${fieldName} in "${resourceTitle}"`;
      } else {
        message = t.tasks?.taskCompleted?.replace("{title}", resourceTitle) || `Task completed for "${resourceTitle}"`;
      }

      if (isMountedRef.current) {
        showInfoBox(message, "success", t.tasks?.completedTitle || "✓ Completed");
      }
    }

    // Cleanup old task IDs after 5 minutes
    const cleanupTimeout = setTimeout(() => {
      for (const task of recentlyCompletedTasks) {
        notifiedTaskIds.current.delete(task.id);
      }
    }, 300000);

    return () => clearTimeout(cleanupTimeout);
  }, [recentlyCompletedTasks, showInfoBox, t]);

  // Track component mount status to prevent state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Show loading indicator only if loading takes longer than 1 second
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;

    if (navigation.state === "loading" || navigation.state === "submitting") {
      timer = setTimeout(() => {
        if (isMountedRef.current) {
          setShowLoadingIndicator(true);
        }
      }, 1000);
    } else {
      if (isMountedRef.current) {
        setShowLoadingIndicator(false);
      }
      if (timer) {
        clearTimeout(timer);
      }
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [navigation.state]);

  // Dynamically measure navigation height and update spacer + context
  useEffect(() => {
    const updateHeight = () => {
      if (navRef.current && isMountedRef.current) {
        const height = navRef.current.offsetHeight;
        setNavHeight(height);
        setMainNavHeight(height); // Update context for other components
      }
    };

    // Update height on mount and when window resizes
    updateHeight();
    window.addEventListener('resize', updateHeight);

    // Use ResizeObserver for more precise tracking (if available)
    if (navRef.current && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(navRef.current);

      return () => {
        observer.disconnect();
        window.removeEventListener('resize', updateHeight);
      };
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
    };
  }, [infoBox, showLoadingIndicator, isGlobalLoading, setMainNavHeight]); // Re-measure when infoBox or loading indicator changes

  const togglePopover = useCallback(() => {
    setPopoverActive(prev => {
      if (!prev) markAllRead();
      return !prev;
    });
  }, [markAllRead]);

  const closePopover = useCallback(() => setPopoverActive(false), []);

  const toneColor = (tone: InfoBoxTone) =>
    tone === "success" ? "#4caf50" :
    tone === "critical" ? "#f44336" :
    tone === "warning" ? "#ff9800" :
    "#2196f3";

  const toneBg = (tone: InfoBoxTone) =>
    tone === "success" ? "#e8f5e9" :
    tone === "critical" ? "#ffebee" :
    tone === "warning" ? "#fff3e0" :
    "#e3f2fd";

  const formatTime = (date: Date) => {
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  };

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app/products" },
    { id: "content", label: t.nav.otherContent, path: "/app/collections" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleClick = (path: string, tabId: string) => {
    handleNavigate(path);
  };

  // Navigate to settings/plan page when any plan button is clicked
  const handlePlanNavigation = () => {
    const searchParams = new URLSearchParams();
    searchParams.set("tab", "plan");
    handleNavigate("/app/settings", { searchParams });
  };

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  // Content types for mobile menu (wenn auf Content-Seiten)
  const isOnContentPage = location.pathname.startsWith("/app/collections") ||
    location.pathname.startsWith("/app/blog") ||
    location.pathname.startsWith("/app/metaobjects") ||
    location.pathname.startsWith("/app/pages") ||
    location.pathname.startsWith("/app/policies") ||
    location.pathname.startsWith("/app/menus") ||
    location.pathname.startsWith("/app/templates") ||
    location.pathname.startsWith("/app/content");

  const contentTypes = [
    { id: "collections", label: t.content.collections, icon: "📂", path: "/app/collections" },
    { id: "blogs", label: t.content.blogs, icon: "📝", path: "/app/blog" },
    { id: "metaobjects", label: t.content.metaobjects || "Metaobjects", icon: "🔷", path: "/app/metaobjects" },
    { id: "pages", label: t.content.pages, icon: "📄", path: "/app/pages" },
    { id: "policies", label: t.content.policies, icon: "📋", path: "/app/policies" },
    { id: "menus", label: t.content.menus, icon: "🍔", path: "/app/menus" },
    { id: "templates", label: t.content.templates, icon: "🧪", path: "/app/templates" },
  ];

  return (
    <>
      {/* Fixed Navigation */}
      <nav
        ref={navRef}
        role="navigation"
        aria-label="Main navigation"
        style={{
          background: "white",
          borderBottom: "1px solid #e1e3e5",
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
        }}
      >
        {/* Einzeilige Leiste mit Navigation, InfoBox und Plan Selector */}
        <div className="main-navigation" style={{ display: "flex", alignItems: "center", padding: "1rem", gap: "2rem", flexWrap: "wrap" }}>
          {/* Mobile Menu (Hamburger) - nur auf Mobile sichtbar */}
          <div className="mobile-only">
            <MobileMenu
              activeTab={tabs.find(tab => location.pathname.startsWith(tab.path))?.id}
              productCount={productCount}
              maxProducts={maxProducts}
              contentTypes={contentTypes}
              showContentTypes={isOnContentPage}
            />
          </div>

          {/* Compact Item Selector - nur auf Mobile sichtbar und nur wenn Items vorhanden */}
          {items.length > 0 && onItemSelect && (
            <div className="mobile-only" style={{ flex: 1, minWidth: 0 }}>
              <UnifiedItemSelectorCompact
                items={items}
                selectedItemId={selectedItemId}
                onItemSelect={onItemSelect}
                resourceName={resourceName}
                t={itemSelectorT}
              />
            </div>
          )}

          {/* Navigation Tabs - versteckt auf Mobile */}
          <div className="desktop-only">
          <InlineStack gap="400" blockAlign="center">
            {tabs.map((tab) => {
              const isActive = location.pathname.startsWith(tab.path);
              const showProductCount = tab.id === "products" && productCount !== undefined;
              const isAtLimit = showProductCount && productCount >= maxProducts && maxProducts !== Infinity;
              const showTaskCount = tab.id === "tasks" && runningTaskCount > 0;

              const tabContent = (
                <button
                  key={tab.id}
                  onClick={() => handleClick(tab.path, tab.id)}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`Navigate to ${tab.label}${showProductCount ? ` (${productCount} products)` : ''}${showTaskCount ? ` (${runningTaskCount} running tasks)` : ''}`}
                  aria-current={isActive ? "page" : undefined}
                  style={{
                    textDecoration: "none",
                    padding: "1rem 0.5rem",
                    transition: "border-color 0.2s",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                    cursor: "pointer",
                  }}
                >
                  <InlineStack gap="200" blockAlign="center">
                    <Text
                      as="span"
                      variant="bodyMd"
                      fontWeight={isActive ? "bold" : "regular"}
                      tone="base"
                    >
                      {tab.label}
                    </Text>
                    {showProductCount && (
                      <Text
                        as="span"
                        variant="bodySm"
                        tone={isAtLimit ? "critical" : "subdued"}
                      >
                        ({productCount})
                      </Text>
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
                  </InlineStack>
                </button>
              );

              // Wrap with tooltip if at product limit
              if (isAtLimit && plan === "free") {
                return (
                  <Tooltip key={tab.id} content={t.products.upgradeForMoreProducts}>
                    {tabContent}
                  </Tooltip>
                );
              }

              return tabContent;
            })}
          </InlineStack>
          </div>

          {/* Loading Indicator - shows for navigation or global loading state */}
          {(showLoadingIndicator || isGlobalLoading) && (
            <div
              className="desktop-only"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Spinner size="small" />
              <Text as="span" variant="bodySm" tone="subdued">
                {t.common.loading}
              </Text>
            </div>
          )}

          {/* InfoBox with Popover History */}
          {(infoBox || messageHistory.length > 0) && (
            <div className="nav-infobox-wrapper" style={{ flex: 1, maxWidth: "600px" }}>
              <Popover
                active={popoverActive}
                onClose={closePopover}
                preferredPosition="below"
                preferredAlignment="center"
                zIndexOverride={1100}
                activator={
                  <div>
                    {/* Desktop: full info banner when active message */}
                    {infoBox && (
                      <div className="desktop-only">
                        <div
                          className="info-box"
                          role="status"
                          aria-live="polite"
                          aria-label={`${infoBox.tone === "success" ? "Success" : infoBox.tone === "critical" ? "Error" : infoBox.tone === "warning" ? "Warning" : "Information"} notification`}
                          onClick={togglePopover}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: "0.5rem 1rem",
                            borderRadius: "4px",
                            backgroundColor: toneBg(infoBox.tone),
                            border: `1px solid ${toneColor(infoBox.tone)}`,
                            fontSize: "14px",
                            gap: "0.5rem",
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ flex: 1, color: "#202223" }}>
                            {infoBox.message}
                          </span>
                          {messageHistory.length > 1 && (
                            <span style={{
                              backgroundColor: "#303030",
                              color: "white",
                              borderRadius: "10px",
                              padding: "1px 6px",
                              fontSize: "11px",
                              fontWeight: "600",
                              minWidth: "18px",
                              textAlign: "center",
                            }}>
                              {messageHistory.length}
                            </span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); hideInfoBox(); }}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "0.25rem",
                              display: "flex",
                              alignItems: "center",
                              color: "#202223",
                              opacity: 0.6,
                              fontSize: "18px",
                              lineHeight: 1,
                            }}
                            aria-label="Schließen"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Bell icon: always on mobile, only when no active infoBox on desktop */}
                    <div className={infoBox ? "mobile-only" : undefined}>
                      <button
                        onClick={togglePopover}
                        style={{
                          position: "relative",
                          background: "none",
                          border: "1px solid #c9cccf",
                          borderRadius: "8px",
                          cursor: "pointer",
                          padding: "6px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                        aria-label={`${messageHistory.length} Nachrichten`}
                      >
                        <Icon source={NotificationIcon} tone="base" />
                        {unreadCount > 0 && (
                          <span style={{
                            position: "absolute",
                            top: "-4px",
                            right: "-4px",
                            backgroundColor: "#f44336",
                            color: "white",
                            borderRadius: "10px",
                            padding: "0 5px",
                            fontSize: "10px",
                            fontWeight: "700",
                            minWidth: "16px",
                            height: "16px",
                            lineHeight: "16px",
                            textAlign: "center",
                          }}>
                            {unreadCount}
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                }
              >
                <div style={{ width: "380px" }}>
                  <div style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid #e1e3e5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}>
                    <Text as="span" variant="headingSm">Nachrichten</Text>
                    {messageHistory.length > 0 && (
                      <Button
                        variant="plain"
                        size="slim"
                        onClick={() => { clearHistory(); closePopover(); }}
                      >
                        Alle löschen
                      </Button>
                    )}
                  </div>
                  <Scrollable style={{ maxHeight: "300px" }}>
                    {messageHistory.length === 0 ? (
                      <div style={{ padding: "24px 16px", textAlign: "center" }}>
                        <Text as="p" variant="bodySm" tone="subdued">Keine Nachrichten</Text>
                      </div>
                    ) : (
                      messageHistory.map((entry) => (
                        <div
                          key={entry.id}
                          style={{
                            padding: "10px 16px",
                            borderBottom: "1px solid #f1f2f3",
                            display: "flex",
                            gap: "10px",
                            alignItems: "flex-start",
                          }}
                        >
                          <span style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            backgroundColor: toneColor(entry.tone),
                            flexShrink: 0,
                            marginTop: "6px",
                          }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Text as="p" variant="bodySm">
                              {entry.message}
                            </Text>
                          </div>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {formatTime(entry.timestamp)}
                          </Text>
                        </div>
                      ))
                    )}
                  </Scrollable>
                </div>
              </Popover>
            </div>
          )}

          {/* Plan Buttons - alle Pläne auf Desktop, nur aktiver Plan auf Mobile */}
          <div style={{ marginLeft: "auto" }}>
            {/* Desktop: alle Pläne als segmented ButtonGroup */}
            <div className="desktop-only">
              <ButtonGroup variant="segmented">
                {plans.map((p) => (
                  <Button
                    key={p}
                    onClick={handlePlanNavigation}
                    pressed={p === plan}
                    size="slim"
                    accessibilityLabel={`Plan: ${PLAN_DISPLAY_NAMES[p]}${p === plan ? " (active)" : ""}`}
                  >
                    {PLAN_DISPLAY_NAMES[p]}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
            {/* Mobile: nur aktiver Plan */}
            <div className="mobile-only">
              <Button
                onClick={handlePlanNavigation}
                pressed
                accessibilityLabel={`Current plan: ${getPlanDisplayName()}`}
              >
                {getPlanDisplayName()}
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Dynamic spacer to prevent content from going under fixed navigation */}
      <div style={{ height: `${navHeight}px` }} aria-hidden="true" />
    </>
  );
}

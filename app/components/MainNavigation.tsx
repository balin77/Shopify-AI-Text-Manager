import { useLocation, useMatches, useNavigation } from "@remix-run/react";
import { InlineStack, Text, ButtonGroup, Button, Spinner, Popover, Scrollable, Icon } from "@shopify/polaris";
import { NotificationIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { confirmNavigation } from "../hooks/useSaveBar";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { MobileMenu } from "./MobileMenu";
import { UnifiedItemSelectorCompact } from "./unified/UnifiedItemSelectorCompact";
import { type Plan, PLAN_DISPLAY_NAMES } from "../config/plans";
import { CONTENT_RUBRICS, isContentPath } from "../config/content-rubrics";
import { extractReadableName } from "../utils/templates-field-factory";
import { useState, useEffect, useRef, useCallback } from "react";
import type { InfoBoxTone } from "../contexts/InfoBoxContext";

export function MainNavigation() {
  const location = useLocation();
  const navigation = useNavigation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { infoBox, hideInfoBox, showInfoBox, isGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress } = useInfoBox();
  const [popoverActive, setPopoverActive] = useState(false);
  const { plan, getPlanDisplayName, getMaxProducts } = usePlan();
  const { setMainNavHeight } = useNavigationHeight();
  const { items, selectedItemId, onItemSelect, resourceName, t: itemSelectorT } = useItemSelector();
  const { runningTaskCount, recentlyCompletedTasks } = useTaskCount();
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const notifiedTaskIds = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  // Show notifications for newly completed/failed tasks (from context).
  // Tone is derived from status + processed/total so partial failures and
  // outright failures are surfaced as warning/critical instead of silently
  // appearing as success.
  useEffect(() => {
    if (!recentlyCompletedTasks.length || !isMountedRef.current) return;

    for (const task of recentlyCompletedTasks) {
      if (notifiedTaskIds.current.has(task.id)) continue;

      notifiedTaskIds.current.add(task.id);

      const resourceTitle = task.resourceTitle || "";

      const toReadableFieldName = (raw: string) => {
        if (raw === "allAltTexts") return t.tasks?.allAltTexts || "all alt-texts";
        const altMatch = raw.match(/^altText_(\d+)$/);
        if (altMatch) return t.tasks?.imageAltText?.replace("{n}", String(Number(altMatch[1]) + 1)) || `Image ${Number(altMatch[1]) + 1} alt-text`;
        if (raw.includes('.') || raw.includes(':')) return extractReadableName(raw);
        return raw;
      };

      const baseMessage = (() => {
        if (task.type === "bulkTranslation") {
          if (task.fieldType === "all") {
            return t.tasks?.translationCompleted?.replace("{title}", resourceTitle) || `Translation completed for "${resourceTitle}"`;
          }
          const fieldName = toReadableFieldName(task.fieldType || "field");
          return t.tasks?.fieldTranslationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
            || `Translation completed for ${fieldName} in "${resourceTitle}"`;
        }
        if (task.type === "aiGeneration" || task.type === "bulkAIGeneration") {
          const fieldName = toReadableFieldName(task.fieldType || "content");
          return t.tasks?.generationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
            || `AI generation completed for ${fieldName} in "${resourceTitle}"`;
        }
        if (task.type === "altTextTemplateApply") {
          return t.tasks?.altTextTemplateApplied?.replace("{title}", resourceTitle) || `Alt-text templates applied to "${resourceTitle}"`;
        }
        return t.tasks?.taskCompleted?.replace("{title}", resourceTitle) || `Task completed for "${resourceTitle}"`;
      })();

      const total = typeof task.total === "number" ? task.total : null;
      const processed = typeof task.processed === "number" ? task.processed : null;
      const failed = total != null && processed != null ? Math.max(total - processed, 0) : 0;

      let tone: InfoBoxTone = "success";
      let title = t.tasks?.completedTitle || "✓ Completed";
      let message = baseMessage;

      if (task.status === "failed") {
        tone = "critical";
        title = t.tasks?.failedTitle || "✗ Failed";
        const detail = task.error || t.tasks?.taskFailedGeneric || "Task failed — please retry.";
        message = `${baseMessage}: ${detail}`;
      } else if (total != null && processed != null && processed < total) {
        tone = "warning";
        title = t.tasks?.partialTitle || "⚠ Partially saved";
        const summary = (t.tasks?.partialSummary || "{processed} of {total} saved, {failed} failed")
          .replace("{processed}", String(processed))
          .replace("{total}", String(total))
          .replace("{failed}", String(failed));
        message = `${baseMessage} — ${summary}${task.error ? `: ${task.error}` : ""}`;
      } else if (task.error) {
        // Completed with a soft error recorded — surface as warning.
        tone = "warning";
        title = t.tasks?.partialTitle || "⚠ Partially saved";
        message = `${baseMessage} — ${task.error}`;
      }

      if (isMountedRef.current) {
        showInfoBox(message, tone, title);
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
        setMainNavHeight(height); // Publish for downstream sticky elements
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
  }, [infoBox, syncProgress, showLoadingIndicator, isGlobalLoading, setMainNavHeight]); // Re-measure when infoBox/progress or loading indicator changes

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

  // Level 1 is slimmed to high-level sections (Plan §3.4): "Inhalte" subsumes the
  // old Products + Other-Content tabs; the rubric/content-type structure lives in
  // RubricNavigation (Level 2) + ContentTypeNavigation (Level 3). "Inhalte" lands
  // on Produkte (the first Katalog entry).
  const navContentLabel = (t.nav as unknown as Record<string, string>).content || t.nav.otherContent;
  const tabs = [
    { id: "content", label: navContentLabel, path: "/app/products" },
    { id: "seo", label: t.nav.seo, path: "/app/seo" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleClick = async (path: string, tabId: string) => {
    // Gate navigation on the native save bar: prompts for unsaved changes and
    // resolves only when it is safe to leave.
    await confirmNavigation();
    handleNavigate(path);
  };

  // Navigate from an InfoBox link. Must go through handleNavigate so Shopify
  // session params (host/shop/embedded) are preserved — a raw client-side
  // navigate() drops them and breaks the *next* navigation (blank page).
  const handleInfoBoxLink = (url: string) => {
    const [path, query] = url.split("?");
    const options = query ? { searchParams: new URLSearchParams(query) } : {};
    handleNavigate(path, options);
  };

  // Navigate to settings/plan page when any plan button is clicked
  const handlePlanNavigation = async () => {
    await confirmNavigation();
    const searchParams = new URLSearchParams();
    searchParams.set("tab", "plan");
    handleNavigate("/app/settings", { searchParams });
  };

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  // Content types for the mobile drawer (Plan §3.6: Level 2 + Level 3 collapse
  // into the hamburger menu). Flattened from the shared rubric config so it
  // stays in sync with the desktop bars.
  const isOnContentPage = isContentPath(location.pathname);

  const mobileContentLabels = t.content as unknown as Record<string, string>;
  const contentTypes = CONTENT_RUBRICS.flatMap((r) =>
    r.entries.map((e) => ({
      id: e.id,
      label: mobileContentLabels?.[e.labelKey] || e.id,
      icon: e.icon,
      path: e.path,
    }))
  );

  return (
    <>
      {/* Sticky Navigation — takes real space in document flow, so no spacer
          is needed and the bar doesn't briefly overlap content during hydration
          like a position:fixed bar would. */}
      <nav
        ref={navRef}
        role="navigation"
        aria-label="Main navigation"
        style={{
          background: "white",
          borderBottom: "1px solid #e1e3e5",
          position: "sticky",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
        }}
      >
        {/* Einzeilige Leiste mit Navigation, InfoBox und Plan Selector */}
        <div className="main-navigation" style={{ display: "flex", alignItems: "center", padding: "0.5rem 1rem", gap: "2rem", flexWrap: "wrap" }}>
          {/* Mobile Menu (Hamburger) - nur auf Mobile sichtbar */}
          <div className="mobile-only">
            <MobileMenu
              activeTab={isContentPath(location.pathname) ? "content" : tabs.find(tab => location.pathname.startsWith(tab.path))?.id}
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
              // "Inhalte" is active on ANY content page, not just /app/products.
              const isActive = tab.id === "content"
                ? isContentPath(location.pathname)
                : location.pathname.startsWith(tab.path);
              const showTaskCount = tab.id === "tasks" && runningTaskCount > 0;

              const tabContent = (
                <button
                  key={tab.id}
                  onClick={() => handleClick(tab.path, tab.id)}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`Navigate to ${tab.label}${showTaskCount ? ` (${runningTaskCount} running tasks)` : ''}`}
                  aria-current={isActive ? "page" : undefined}
                  style={{
                    textDecoration: "none",
                    padding: "0.4rem 0.5rem",
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

          {/* Initial-sync progress — occupies the infobox slot until done */}
          {syncProgress && (
            <div className="nav-infobox-wrapper" style={{ flex: 1, maxWidth: "600px" }}>
              <div
                className="info-box"
                role="status"
                aria-live="polite"
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "4px",
                  backgroundColor: toneBg(syncProgress.error ? "critical" : "info"),
                  border: `1px solid ${toneColor(syncProgress.error ? "critical" : "info")}`,
                  fontSize: "14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                <span style={{ color: "#202223" }}>
                  {syncProgress.error
                    ? `${t.settings?.syncingContent || "Sync"}: ${syncProgress.error}`
                    : `${t.settings?.syncingContent || "Setting up your store"}${
                        syncProgress.phase
                          ? ` — ${
                              (t.settings as unknown as Record<string, string>)[
                                `phase${syncProgress.phase.charAt(0).toUpperCase()}${syncProgress.phase.slice(1)}`
                              ] || syncProgress.phase
                            }`
                          : ""
                      } (${syncProgress.percent}%)`}
                </span>
                {!syncProgress.error && (() => {
                  const order = ["products", "collections", "articles", "pages", "policies", "themes", "metaobjects", "menus"];
                  const idx = syncProgress.phase ? order.indexOf(syncProgress.phase) : -1;
                  const overall = syncProgress.phase === "done"
                    ? 100
                    : Math.max(0, Math.min(100, idx >= 0
                        ? Math.round((idx / order.length) * 100 + syncProgress.percent / order.length)
                        : syncProgress.percent));
                  const Bar = ({ value }: { value: number }) => (
                    <div
                      style={{
                        height: "4px",
                        borderRadius: "2px",
                        backgroundColor: "rgba(0,0,0,0.1)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${value}%`,
                          backgroundColor: toneColor("info"),
                          transition: "width 0.4s ease",
                        }}
                      />
                    </div>
                  );
                  const phaseLabel = (p: string) =>
                    (t.settings as unknown as Record<string, string>)[
                      `phase${p.charAt(0).toUpperCase()}${p.slice(1)}`
                    ] || p;
                  const synced = order
                    .filter((p) => (syncProgress.stats?.[p] ?? 0) > 0)
                    .map((p) => `${phaseLabel(p)}: ${syncProgress.stats![p]}`);
                  return (
                    <>
                      <Bar value={syncProgress.percent} />
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.15rem" }}>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {t.settings?.syncTotalLabel || "Total"}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {overall}%
                        </Text>
                      </div>
                      <Bar value={overall} />
                      {synced.length > 0 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {synced.join(" · ")}
                        </Text>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* InfoBox with Popover History */}
          {!syncProgress && (infoBox || messageHistory.length > 0) && (
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
                            {infoBox.link && (
                              <>
                                {" "}
                                <a
                                  href={infoBox.link.url}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleInfoBoxLink(infoBox.link!.url);
                                  }}
                                  style={{ color: "#005bd3", textDecoration: "underline", fontWeight: 600 }}
                                >
                                  {infoBox.link.label}
                                </a>
                              </>
                            )}
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
                            {entry.link && (
                              <a
                                href={entry.link.url}
                                onClick={(e) => {
                                  e.preventDefault();
                                  closePopover();
                                  handleInfoBoxLink(entry.link!.url);
                                }}
                                style={{ color: "#005bd3", textDecoration: "underline", fontWeight: 600, fontSize: "13px" }}
                              >
                                {entry.link.label}
                              </a>
                            )}
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
    </>
  );
}

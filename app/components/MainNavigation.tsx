import { useLocation, useMatches, useNavigation } from "react-router";
import { InlineStack, Text, ButtonGroup, Button, Spinner, Popover, Scrollable, Icon } from "@shopify/polaris";
import { NotificationIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import { confirmNavigation } from "../hooks/useSaveBar";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { MobileMenu, type MobileNavGroup } from "./MobileMenu";
import { UnifiedItemSelectorCompact } from "./unified/UnifiedItemSelectorCompact";
import { RunningTasksPreview } from "./RunningTasksPreview";
import { type Plan, PLAN_DISPLAY_NAMES } from "../config/plans";
import { CONTENT_RUBRICS, isContentPath } from "../config/content-rubrics";
import { isSeoPath, SEO_RUBRICS } from "../config/seo-sections";
import { meetsPlan } from "../utils/planUtils";
import { extractReadableName } from "../utils/templates-field-factory";
import { taskErrorText } from "../utils/task-error-text";
import { SYNC_PHASE_ORDER, overallSyncPercent } from "../services/sync-phases.shared";
import { useState, useEffect, useRef, useCallback } from "react";
import type { InfoBoxTone } from "../contexts/InfoBoxContext";

/**
 * Task types that run across the whole shop rather than on one item, and
 * therefore never write a `resourceTitle`. Each needs its own completion
 * sentence — the generic "Task completed for {title}" rendered them as
 * `Task completed for ""`. Keep in sync when a new site-wide task type is
 * added; the `!resourceTitle` fallback below catches anything missed.
 */
const SITE_WIDE_TASK_MESSAGE_KEY: Record<string, string> = {
  seoCrawl: "crawlCompleted",
  seoAudit: "auditCompleted",
  seoJsonLdAudit: "jsonLdAuditCompleted",
  seoInternalLinks: "internalLinksCompleted",
  seoRobotsAdvice: "robotsAdviceCompleted",
  aiDiscoveryIntro: "discoveryIntroCompleted",
  // The bulk editor's write task. Its type stays `seoBulkMeta` for historical
  // reasons (CLAUDE.md) — the message must not repeat that name at merchants.
  seoBulkMeta: "bulkEditorSaveCompleted",
  bulkEditorTranslate: "bulkEditorTranslateCompleted",
};

/** English fallbacks, mirroring the inline `||` defaults used elsewhere here. */
const SITE_WIDE_TASK_FALLBACK: Record<string, string> = {
  seoCrawl: "Website crawl finished",
  seoAudit: "SEO analysis finished",
  seoJsonLdAudit: "JSON-LD check finished",
  seoInternalLinks: "Internal link suggestions ready",
  seoRobotsAdvice: "robots.txt analysis finished",
  aiDiscoveryIntro: "AI suggestion for the opening text is ready",
  seoBulkMeta: "Bulk editor: changes saved",
  bulkEditorTranslate: "Bulk editor: translation finished",
};

/**
 * Translated name of an initial-sync phase. The `phase<Name>` keys live in the
 * settings section; an unlabelled phase falls back to a humanized key rather
 * than the raw camelCase one ("onlineStoreExtras" is what a merchant saw in a
 * German banner before the labels existed).
 */
function syncPhaseLabel(settings: Record<string, string>, phase: string): string {
  const key = `phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
  return (
    settings[key] ||
    phase.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

export function MainNavigation() {
  const location = useLocation();
  const navigation = useNavigation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { t } = useI18n();
  const { infoBox, hideInfoBox, showInfoBox, isGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress } = useInfoBox();
  const [popoverActive, setPopoverActive] = useState(false);
  const { plan, getPlanDisplayName, getMaxProducts, canAccessContentType } = usePlan();
  const { setMainNavHeight } = useNavigationHeight();
  const { items, selectedItemId, onItemSelect, resourceName, t: itemSelectorT, onAddItem: onAddItemMobile, addDisabledReason, addLabel } = useItemSelector();
  const { runningTaskCount, recentlyCompletedTasks } = useTaskCount();
  // Narrow screens hide the editor's right-hand sidebar entirely; when one is
  // registered its toggle takes the plan button's slot (see below).
  const sidebarPanel = useSidebarPanel();
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const notifiedTaskIds = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  // Published shop locales from the app shell loader — drives the language gate
  // on SEO sections in the mobile drawer (0 = lookup failed / unknown).
  const shellLocaleCount =
    ((matches.find((match) => match.id === "routes/app")?.data as any)?.localeCount as number) ?? 0;
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
        // Site-wide tasks (every SEO scan, both bulk-editor tasks) have no
        // resourceTitle — there is no single item they belong to. The generic
        // message rendered them all as `Task completed for ""`.
        const siteWideKey = SITE_WIDE_TASK_MESSAGE_KEY[task.type];
        if (siteWideKey) {
          const message = (t.tasks as unknown as Record<string, string> | undefined)?.[siteWideKey];
          return typeof message === "string" ? message : SITE_WIDE_TASK_FALLBACK[task.type];
        }
        // seoBulkFix stores a machine string ("metaDescriptionMissing:fr",
        // "fixAllForItem:product:8123") as its resourceTitle — readable to the
        // bulk-fix runner, not to a merchant. Name the problem it fixed
        // instead, using the dashboard's own label for the code.
        if (task.type === "seoBulkFix") {
          const code = resourceTitle.startsWith("fixAllForItem:") ? "" : resourceTitle.split(":")[0];
          const problemLabel = code
            ? (t.seo?.dashboard?.problems as Record<string, string> | undefined)?.[code]
            : undefined;
          const done = t.tasks?.seoBulkFixCompleted || "SEO fix finished";
          return problemLabel ? `${done}: ${problemLabel}` : done;
        }
        // Safety net for any task type that reaches here without a title —
        // never render the `for ""` form.
        if (!resourceTitle) {
          return t.tasks?.taskCompletedGeneric || "Task completed";
        }
        return t.tasks?.taskCompleted?.replace("{title}", resourceTitle) || `Task completed for "${resourceTitle}"`;
      })();

      // Task.error holds a machine code for the task types that write it
      // without a locale context; those must never reach the merchant raw.
      const errorText = taskErrorText(task.error, t);

      const total = typeof task.total === "number" ? task.total : null;
      const processed = typeof task.processed === "number" ? task.processed : null;
      const failed = total != null && processed != null ? Math.max(total - processed, 0) : 0;

      let tone: InfoBoxTone = "success";
      let title = t.tasks?.completedTitle || "✓ Completed";
      let message = baseMessage;

      if (task.status === "failed") {
        tone = "critical";
        title = t.tasks?.failedTitle || "✗ Failed";
        const detail = errorText || t.tasks?.taskFailedGeneric || "Task failed — please retry.";
        message = `${baseMessage}: ${detail}`;
      } else if (total != null && processed != null && processed < total) {
        tone = "warning";
        title = t.tasks?.partialTitle || "⚠ Partially saved";
        const summary = (t.tasks?.partialSummary || "{processed} of {total} saved, {failed} failed")
          .replace("{processed}", String(processed))
          .replace("{total}", String(total))
          .replace("{failed}", String(failed));
        message = `${baseMessage} — ${summary}${errorText ? `: ${errorText}` : ""}`;
      } else if (errorText) {
        // Completed with a soft error recorded — surface as warning.
        tone = "warning";
        title = t.tasks?.partialTitle || "⚠ Partially saved";
        message = `${baseMessage} — ${errorText}`;
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
    { id: "bulk", label: t.nav.bulk, path: "/app/bulk" },
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

  // Mobile drawer data (Plan §3.6: Level 2 + Level 3 collapse into the
  // hamburger menu). Built from the SAME rubric configs the desktop bars read,
  // and kept GROUPED — a flat list would drop the Level-2 rubric that gives the
  // Level-3 entries their context, which is exactly what the drawer needs in
  // order to show the two levels as two levels.
  const mobileContentLabels = t.content as unknown as Record<string, string>;
  const contentRubricLabels = (t as unknown as { rubrics?: Record<string, string> }).rubrics ?? {};

  // Conditional entries (e.g. Abo-Pläne) are dropped on the same terms as the
  // desktop Level-3 bar: hidden only when the plan is entitled AND the shop has
  // no such content — otherwise the upsell lock stays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appRootData = matches.find((m) => m.id === "routes/app")?.data as any;
  const conditionalContent: Record<string, boolean> | undefined = appRootData?.conditionalContent;

  const contentGroups: MobileNavGroup[] = CONTENT_RUBRICS.map((r) => ({
    id: r.id,
    label: contentRubricLabels[r.id] || r.id,
    icon: r.icon,
    entries: r.entries
      .filter((e) => {
        if (!e.conditional) return true;
        const present = conditionalContent?.[e.id];
        return !(present === false && canAccessContentType(e.planContentType));
      })
      .map((e) => ({
        id: e.id,
        label: mobileContentLabels?.[e.labelKey] || e.id,
        icon: e.icon,
        path: e.path,
        locked: !canAccessContentType(e.planContentType),
        count: e.id === "products" ? productCount : undefined,
        countCritical:
          e.id === "products" &&
          productCount !== undefined &&
          maxProducts !== Infinity &&
          productCount >= maxProducts,
      })),
  })).filter((g) => g.entries.length > 0);

  // SEO rubrics + sections mirror the desktop SubNavBar pair so mobile users can
  // jump straight to a sub-section (Übersicht, Strukturierte Daten, …).
  const seoSectionStrings =
    (t.seo as { sections?: Record<string, { label?: string }> }).sections ?? {};
  const seoRubricStrings = (t.seo as { rubrics?: Record<string, string> }).rubrics ?? {};
  // Language gate, mirroring the desktop SubNavBar (app.seo.tsx): a section that
  // only says something with a second shop language is greyed out with a 🌐
  // marker — never 🔒, which would read as "upgrade your plan". `localeCount` 0
  // means the lookup failed → treat as multi-language and gate nothing.
  const singleLocale = shellLocaleCount > 0 && shellLocaleCount <= 1;
  const seoGroups: MobileNavGroup[] = SEO_RUBRICS.map((r) => ({
    id: r.id,
    label: seoRubricStrings[r.id] || r.id,
    icon: r.icon,
    entries: r.entries.map((section) => {
      const planLocked = section.planGate ? !meetsPlan(plan, section.planGate) : false;
      const languageLocked = !!section.requiresMultipleLocales && singleLocale;
      return {
        id: section.id,
        label: seoSectionStrings[section.id]?.label || section.id,
        icon: section.icon,
        path: section.path,
        locked: planLocked || languageLocked,
        // Plan gate wins the marker: an upgrade unlocks the section outright.
        lockIcon: !planLocked && languageLocked ? "🌐" : undefined,
      };
    }),
  }));

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
              activeTab={isContentPath(location.pathname) ? "content" : isSeoPath(location.pathname) ? "seo" : tabs.find(tab => location.pathname.startsWith(tab.path))?.id}
              contentGroups={contentGroups}
              seoGroups={seoGroups}
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
                onAddItem={onAddItemMobile}
                addDisabledReason={addDisabledReason}
                addLabel={addLabel}
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
                : tab.id === "seo"
                ? isSeoPath(location.pathname)
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
                      <RunningTasksPreview count={runningTaskCount} />
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
                          ? ` — ${syncPhaseLabel(
                              t.settings as unknown as Record<string, string>,
                              syncProgress.phase,
                            )}`
                          : ""
                      } (${syncProgress.percent}%)`}
                </span>
                {!syncProgress.error && (() => {
                  const overall = overallSyncPercent(syncProgress.phase, syncProgress.percent);
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
                    syncPhaseLabel(t.settings as unknown as Record<string, string>, p);
                  const synced = SYNC_PHASE_ORDER
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
                          border: "1px solid var(--app-surface-border-color)",
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

          {/* Plan Buttons - alle Pläne auf Desktop, nur aktiver Plan auf Mobile.
              Unter 1100px ist die rechte Editor-Sidebar ausgeblendet: dort
              übernimmt ihr Umschalter diesen Platz (der Plan bleibt über
              Einstellungen → Plan erreichbar). Rein per CSS-Media-Query, damit
              beim Drehen/Resizen kein Re-Render nötig ist. */}
          <div style={{ marginLeft: "auto" }}>
            {sidebarPanel.available && (
              <div className="sidebar-panel-toggle-slot">
                <Button
                  onClick={sidebarPanel.toggle}
                  pressed={sidebarPanel.open}
                  size="slim"
                  // The accessible name has to START with the visible label,
                  // otherwise voice control can't activate the button by what
                  // it says (WCAG 2.5.3).
                  accessibilityLabel={`${t.seo?.title || "SEO Score"} — ${
                    sidebarPanel.open
                      ? (t.seo?.hidePanel || "Back to content")
                      : (t.seo?.showPanel || "Show SEO score")
                  }`}
                >
                  {t.seo?.title || "SEO Score"}
                </Button>
              </div>
            )}
            {/* Desktop: alle Pläne als segmented ButtonGroup */}
            <div className={`desktop-only plan-buttons-slot${sidebarPanel.available ? " has-sidebar-toggle" : ""}`}>
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
            <div className={`mobile-only plan-buttons-slot${sidebarPanel.available ? " has-sidebar-toggle" : ""}`}>
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

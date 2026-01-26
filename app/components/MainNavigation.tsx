import { useLocation, useNavigate, useFetcher, useMatches, useNavigation } from "@remix-run/react";
import { InlineStack, Text, Banner, ButtonGroup, Button, Tooltip, Spinner } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { type Plan } from "../config/plans";
import { useState, useEffect, useRef } from "react";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const matches = useMatches();
  const { t } = useI18n();
  const { infoBox, hideInfoBox, showInfoBox } = useInfoBox();
  const { plan, getPlanDisplayName, getMaxProducts } = usePlan();
  const { setMainNavHeight } = useNavigationHeight();
  const planFetcher = useFetcher<{ success?: boolean; syncStats?: { synced: number }; error?: string }>();
  const tasksFetcher = useFetcher<{ count: number }>();
  const completedTasksFetcher = useFetcher<{ tasks: any[] }>();
  const [isChangingPlan, setIsChangingPlan] = useState(false);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(73);
  const pollIntervalRef = useRef(10000); // Start with 10 seconds, use ref to persist across renders
  const errorCountRef = useRef(0); // Track consecutive errors
  const completedTasksPollIntervalRef = useRef(10000); // Separate interval for completed tasks polling
  const completedTasksErrorCountRef = useRef(0); // Track consecutive errors for completed tasks
  const notifiedTaskIds = useRef<Set<string>>(new Set()); // Track which tasks we've already notified about

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  // Get running task count from dedicated API endpoint (with error handling)
  const runningTaskCount = (tasksFetcher.data?.count !== undefined && !isNaN(tasksFetcher.data.count))
    ? tasksFetcher.data.count
    : 0;

  // Fetch running tasks count with adaptive polling and error handling
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    let interval: NodeJS.Timeout;

    const fetchTaskCount = () => {
      // Only fetch if not already loading to prevent overlapping requests
      if (tasksFetcher.state === "idle") {
        tasksFetcher.load(`/api/running-tasks-count?${searchParams.toString()}`);
      }
    };

    // Load initial count
    fetchTaskCount();

    // Set up interval with current poll interval
    const setupInterval = () => {
      if (interval) {
        clearInterval(interval);
      }
      interval = setInterval(fetchTaskCount, pollIntervalRef.current);
    };

    setupInterval();

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [location.search]); // Re-fetch when search params change (e.g., shop parameter)

  // Poll for recently completed tasks and show notifications with exponential backoff
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    let interval: NodeJS.Timeout;

    const fetchCompletedTasks = () => {
      // Only fetch if not already loading to prevent overlapping requests
      if (completedTasksFetcher.state === "idle") {
        completedTasksFetcher.load(`/api/recently-completed-tasks?${searchParams.toString()}`);
      }
    };

    // Load initial
    fetchCompletedTasks();

    // Set up interval with current poll interval
    const setupInterval = () => {
      if (interval) {
        clearInterval(interval);
      }
      interval = setInterval(fetchCompletedTasks, completedTasksPollIntervalRef.current);
    };

    setupInterval();

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [location.search]);

  // Show notifications for newly completed tasks
  useEffect(() => {
    if (!completedTasksFetcher.data?.tasks) return;

    const tasks = completedTasksFetcher.data.tasks;

    for (const task of tasks) {
      // Skip if we've already notified about this task
      if (notifiedTaskIds.current.has(task.id)) continue;

      // Mark as notified
      notifiedTaskIds.current.add(task.id);

      // Build notification message based on task type
      let message = "";
      const resourceTitle = task.resourceTitle || "";

      if (task.type === "bulkTranslation") {
        if (task.fieldType === "all") {
          message = t.tasks?.translationCompleted || `Translation completed for "${resourceTitle}"`;
        } else {
          const fieldName = task.fieldType || "field";
          message = t.tasks?.fieldTranslationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
            || `Translation completed for ${fieldName} in "${resourceTitle}"`;
        }
      } else if (task.type === "aiGeneration") {
        const fieldName = task.fieldType || "content";
        message = t.tasks?.generationCompleted?.replace("{field}", fieldName).replace("{title}", resourceTitle)
          || `AI generation completed for ${fieldName} in "${resourceTitle}"`;
      } else {
        message = t.tasks?.taskCompleted || `Task completed for "${resourceTitle}"`;
      }

      showInfoBox(message, "success", t.tasks?.completedTitle || "✓ Completed");
    }

    // Cleanup old task IDs after 5 minutes
    setTimeout(() => {
      for (const task of tasks) {
        notifiedTaskIds.current.delete(task.id);
      }
    }, 300000);
  }, [completedTasksFetcher.data, showInfoBox, t]);

  // Monitor fetcher state and implement exponential backoff on errors for running tasks
  useEffect(() => {
    // Check if fetcher encountered an error (including 429, 502, etc.)
    const hasError = tasksFetcher.state === "idle" &&
      (tasksFetcher.data === undefined || (tasksFetcher.data as any)?.error);

    if (hasError) {
      // Likely an error occurred
      errorCountRef.current += 1;

      // Exponential backoff: double the interval on each consecutive error, max 60 seconds
      const newInterval = Math.min(pollIntervalRef.current * 2, 60000);

      if (newInterval !== pollIntervalRef.current) {
        console.warn(`⚠️ [MainNavigation] Running tasks error detected (502/429/etc). Increasing poll interval to ${newInterval}ms`);
        pollIntervalRef.current = newInterval;
      }
    } else if (tasksFetcher.state === "idle" && tasksFetcher.data !== undefined && !(tasksFetcher.data as any)?.error) {
      // Successful fetch - reset error count and gradually reduce interval
      if (errorCountRef.current > 0) {
        errorCountRef.current = 0;

        // Gradually reduce interval back to 10 seconds
        const newInterval = Math.max(pollIntervalRef.current / 2, 10000);
        if (newInterval !== pollIntervalRef.current) {
          console.log(`✅ [MainNavigation] Running tasks connection restored. Reducing poll interval to ${newInterval}ms`);
          pollIntervalRef.current = newInterval;
        }
      }
    }
  }, [tasksFetcher.state, tasksFetcher.data]);

  // Monitor completed tasks fetcher and implement exponential backoff on errors
  useEffect(() => {
    // Check if fetcher encountered an error (including 429, 502, etc.)
    // Also check for warning flag (rate limited but returned 200)
    const data = completedTasksFetcher.data as any;
    const hasError = completedTasksFetcher.state === "idle" &&
      (completedTasksFetcher.data === undefined || data?.error || data?.warning);

    if (hasError) {
      // Likely an error occurred or rate limited
      completedTasksErrorCountRef.current += 1;

      // Exponential backoff: double the interval on each consecutive error, max 60 seconds
      const newInterval = Math.min(completedTasksPollIntervalRef.current * 2, 60000);

      if (newInterval !== completedTasksPollIntervalRef.current) {
        const errorType = data?.warning ? "Rate limited" : "Error";
        console.warn(`⚠️ [MainNavigation] Completed tasks ${errorType}. Increasing poll interval to ${newInterval}ms`);
        completedTasksPollIntervalRef.current = newInterval;
      }
    } else if (completedTasksFetcher.state === "idle" && completedTasksFetcher.data !== undefined && !data?.error && !data?.warning) {
      // Successful fetch - reset error count and gradually reduce interval
      if (completedTasksErrorCountRef.current > 0) {
        completedTasksErrorCountRef.current = 0;

        // Gradually reduce interval back to 10 seconds
        const newInterval = Math.max(completedTasksPollIntervalRef.current / 2, 10000);
        if (newInterval !== completedTasksPollIntervalRef.current) {
          console.log(`✅ [MainNavigation] Completed tasks connection restored. Reducing poll interval to ${newInterval}ms`);
          completedTasksPollIntervalRef.current = newInterval;
        }
      }
    }
  }, [completedTasksFetcher.state, completedTasksFetcher.data]);

  // Show loading indicator only if loading takes longer than 1 second
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;

    if (navigation.state === "loading" || navigation.state === "submitting") {
      timer = setTimeout(() => {
        setShowLoadingIndicator(true);
      }, 1000);
    } else {
      setShowLoadingIndicator(false);
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
      if (navRef.current) {
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
  }, [infoBox, showLoadingIndicator, setMainNavHeight]); // Re-measure when infoBox or loading indicator changes

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app/products" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleClick = (path: string, tabId: string) => {
    console.log("🖱️ [MainNavigation] Tab clicked:", tabId, "->", path);
    console.log("🎯 [MainNavigation] Using client-side navigation (SPA)");

    // Preserve critical URL parameters for Shopify embedded app session
    const searchParams = new URLSearchParams(location.search);
    const newPath = `${path}?${searchParams.toString()}`;

    console.log("🖱️ [MainNavigation] Navigating to:", newPath);
    navigate(newPath);
  };

  const handlePlanChange = async (newPlan: Plan) => {
    if (newPlan === plan || isChangingPlan) return;

    console.log("🔄 [MainNavigation] Changing plan:", plan, "->", newPlan);
    setIsChangingPlan(true);

    planFetcher.submit(
      { plan: newPlan },
      { method: "POST", action: "/api/update-plan", encType: "application/json" }
    );
  };

  // Debug: Log fetcher state changes
  useEffect(() => {
    if (isChangingPlan) {
      console.log("🔍 [MainNavigation] planFetcher state:", planFetcher.state, "data:", planFetcher.data);
    }
  }, [planFetcher.state, planFetcher.data, isChangingPlan]);

  // Handle plan change completion - wait for API response before reloading
  useEffect(() => {
    // Only process when fetcher has finished (went from loading/submitting to idle with data)
    if (planFetcher.state === "idle" && planFetcher.data && isChangingPlan) {
      console.log("📦 [MainNavigation] Plan change response:", planFetcher.data);

      if (planFetcher.data.success) {
        console.log("✅ [MainNavigation] Plan change complete, reloading page...");
        if (planFetcher.data.syncStats?.synced) {
          console.log(`📦 [MainNavigation] Synced ${planFetcher.data.syncStats.synced} additional products`);
        }
        window.location.reload();
      } else {
        console.error("❌ [MainNavigation] Plan change failed:", planFetcher.data.error);
        setIsChangingPlan(false);
      }
    }
  }, [planFetcher.state, planFetcher.data, isChangingPlan]);

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  return (
    <>
      {/* Fixed Navigation */}
      <div
        ref={navRef}
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
        <div style={{ display: "flex", alignItems: "center", padding: "1rem", gap: "2rem", flexWrap: "wrap" }}>
          {/* Navigation Tabs */}
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

          {/* Loading Indicator - nur anzeigen wenn länger als 1 Sekunde */}
          {showLoadingIndicator && (
            <div
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

          {/* InfoBox auf gleicher Ebene - schlanke Variante */}
          {infoBox && (
            <div
              style={{
                flex: 1,
                maxWidth: "600px",
                display: "flex",
                alignItems: "center",
                padding: "0.5rem 1rem",
                borderRadius: "4px",
                backgroundColor:
                  infoBox.tone === "success" ? "#e8f5e9" :
                  infoBox.tone === "critical" ? "#ffebee" :
                  infoBox.tone === "warning" ? "#fff3e0" :
                  "#e3f2fd",
                border: `1px solid ${
                  infoBox.tone === "success" ? "#4caf50" :
                  infoBox.tone === "critical" ? "#f44336" :
                  infoBox.tone === "warning" ? "#ff9800" :
                  "#2196f3"
                }`,
                fontSize: "14px",
                gap: "0.5rem"
              }}
            >
              <span style={{ flex: 1, color: "#202223" }}>
                {infoBox.message}
              </span>
              <button
                onClick={hideInfoBox}
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
                  lineHeight: 1
                }}
                aria-label="Schließen"
              >
                ×
              </button>
            </div>
          )}

          {/* Plan Selector */}
          <div style={{ marginLeft: "auto" }}>
            <ButtonGroup variant="segmented">
              {plans.map((planOption) => (
                <Button
                  key={planOption}
                  pressed={plan === planOption}
                  onClick={() => handlePlanChange(planOption)}
                  disabled={isChangingPlan}
                  size="slim"
                >
                  {planOption.charAt(0).toUpperCase() + planOption.slice(1)}
                </Button>
              ))}
            </ButtonGroup>
          </div>
        </div>
      </div>

      {/* Dynamic spacer to prevent content from going under fixed navigation */}
      <div style={{ height: `${navHeight}px` }} />
    </>
  );
}

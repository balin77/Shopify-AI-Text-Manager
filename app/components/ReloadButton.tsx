import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import { useFetcher } from "@remix-run/react";

interface ReloadButtonProps {
  resourceId: string;
  resourceType: "product" | "collection" | "article" | "page" | "policy" | "templates";
  locale: string;
  onReloadComplete?: () => void;
  onReloadSuccess?: () => void;
  revalidator?: {
    revalidate: () => void;
    state: 'idle' | 'loading';
  };
}

export function ReloadButton({
  resourceId,
  resourceType,
  locale,
  onReloadComplete,
  onReloadSuccess,
  revalidator,
}: ReloadButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [waitingForRevalidation, setWaitingForRevalidation] = useState(false);
  const fetcher = useFetcher();

  // Monitor fetcher state
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && isLoading) {
      console.log("🔄 [RELOAD-BUTTON] Sync complete, fetcher data:", fetcher.data);

      const data = fetcher.data as any;
      if (data.success) {
        console.log("✅ [RELOAD-BUTTON] Sync successful!");
        console.log("🔄 [RELOAD-BUTTON] Resource:", { resourceId, resourceType, locale });

        if (revalidator) {
          // Use revalidation approach (non-destructive)
          setTimeout(() => {
            console.log("🔄 [RELOAD-BUTTON] Triggering revalidation...");
            console.log("🔍 [RELOAD-BUTTON] Revalidator state before:", revalidator.state);

            // Cache-bust: Add timestamp to URL to force Remix to reload data
            const url = new URL(window.location.href);
            url.searchParams.set('_reload', Date.now().toString());
            window.history.replaceState({}, '', url.toString());
            console.log("🔄 [RELOAD-BUTTON] Added cache-busting timestamp to URL");

            setWaitingForRevalidation(true);
            revalidator.revalidate();

            console.log("🔍 [RELOAD-BUTTON] Revalidator state after trigger:", revalidator.state);
          }, 1000); // Wait 1 second for DB write to complete
        } else {
          // Fallback to page reload if revalidator not available
          setTimeout(() => {
            console.log("🔄 [RELOAD-BUTTON] Reloading page to show updated data...");

            // Store the selected product ID in URL to restore selection after reload
            const url = new URL(window.location.href);
            url.searchParams.set('selected', resourceId);
            url.searchParams.set('_t', Date.now().toString()); // Cache bust

            console.log("💾 [RELOAD-BUTTON] Saving selection for restoration:", {
              resourceId,
              resourceType,
              currentUrl: window.location.href,
              newUrl: url.toString(),
            });

            // Navigate to URL with selected parameter (forces full reload with selection preserved)
            console.log("🌐 [RELOAD-BUTTON] Navigating to:", url.toString());
            window.location.href = url.toString();
          }, 500);

          if (onReloadComplete) {
            onReloadComplete();
          }
        }
      } else {
        console.error("❌ [RELOAD-BUTTON] Sync failed:", data.error);
        setIsLoading(false);
        alert(`Fehler beim Neuladen: ${data.error || "Unbekannter Fehler"}`);
      }
    }
  }, [fetcher.state, fetcher.data, isLoading, onReloadComplete, resourceId, resourceType, locale, revalidator]);

  // Monitor revalidation state
  useEffect(() => {
    if (!waitingForRevalidation || !revalidator) return;

    console.log("🔍 [RELOAD-BUTTON] Monitoring revalidation, current state:", revalidator.state);

    // Revalidation completed
    if (revalidator.state === 'idle') {
      console.log("✅ [RELOAD-BUTTON] Revalidation completed!");
      setWaitingForRevalidation(false);
      setIsLoading(false);

      // Trigger data refresh in the parent component (e.g., useUnifiedContentEditor)
      // This calls triggerDataRefresh() which increments dataRefreshTrigger
      // which causes the editor to reload editableValues from the fresh data
      if (onReloadComplete) {
        console.log("🔄 [RELOAD-BUTTON] Calling onReloadComplete to refresh frontend data");
        onReloadComplete();
      }
      if (onReloadSuccess) {
        onReloadSuccess();
      }
    }
  }, [revalidator?.state, waitingForRevalidation, onReloadComplete, onReloadSuccess, revalidator]);

  const handleReload = () => {
    if (isLoading) {
      console.log("⚠️ [RELOAD-BUTTON] Already loading, ignoring click");
      return;
    }

    console.log("🔄 [RELOAD-BUTTON] Reload button clicked:", { resourceId, resourceType, locale });
    setIsLoading(true);

    // Call the sync API endpoint
    fetcher.submit(
      {
        resourceId,
        resourceType,
        locale,
      },
      {
        method: "post",
        action: "/api/sync-single-resource",
      }
    );
    console.log("🔄 [RELOAD-BUTTON] Fetch submitted to /api/sync-single-resource");
  };

  return (
    <Tooltip content="Daten von Shopify neu laden">
      <Button
        icon={RefreshIcon}
        onClick={handleReload}
        loading={isLoading}
        disabled={isLoading}
        accessibilityLabel="Daten von Shopify neu laden"
        size="slim"
      />
    </Tooltip>
  );
}

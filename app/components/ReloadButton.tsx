import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import { useFetcher } from "@remix-run/react";

interface ReloadButtonProps {
  resourceId: string;
  resourceType: "product" | "collection" | "article" | "page" | "policy" | "templates";
  locale: string;
  onReloadComplete?: () => void;
}

export function ReloadButton({
  resourceId,
  resourceType,
  locale,
  onReloadComplete,
}: ReloadButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const fetcher = useFetcher();

  // Monitor fetcher state
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && isLoading) {
      console.log("🔄 [RELOAD-BUTTON] Sync complete, fetcher data:", fetcher.data);

      const data = fetcher.data as any;
      if (data.success) {
        console.log("✅ [RELOAD-BUTTON] Sync successful!");
        console.log("🔄 [RELOAD-BUTTON] Resource:", { resourceId, resourceType, locale });

        // Save selected resource ID to restore after reload
        setTimeout(() => {
          console.log("🔄 [RELOAD-BUTTON] Reloading page to show updated data...");

          // Store the selected product ID in URL to restore selection after reload
          const url = new URL(window.location.href);
          url.searchParams.set('selected', resourceId);
          url.searchParams.set('_t', Date.now().toString()); // Cache bust

          // Also store in localStorage as fallback
          try {
            localStorage.setItem('lastSelectedResource', JSON.stringify({
              id: resourceId,
              type: resourceType,
              timestamp: Date.now()
            }));
          } catch (e) {
            console.warn('[RELOAD-BUTTON] Failed to save to localStorage:', e);
          }

          // Navigate to URL with selected parameter (forces full reload with selection preserved)
          window.location.href = url.toString();
        }, 500);

        if (onReloadComplete) {
          onReloadComplete();
        }
      } else {
        console.error("❌ [RELOAD-BUTTON] Sync failed:", data.error);
        setIsLoading(false);
        alert(`Fehler beim Neuladen: ${data.error || "Unbekannter Fehler"}`);
      }
    }
  }, [fetcher.state, fetcher.data, isLoading, onReloadComplete, resourceId, resourceType, locale]);

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

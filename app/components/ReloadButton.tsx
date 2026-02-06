import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import { useFetcher, useNavigate } from "@remix-run/react";

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
  const navigate = useNavigate();

  // Monitor fetcher state
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && isLoading) {
      console.log("🔄 [RELOAD-BUTTON] Sync complete, fetcher data:", fetcher.data);
      setIsLoading(false);

      const data = fetcher.data as any;
      if (data.success) {
        console.log("✅ [RELOAD-BUTTON] Sync successful, navigating to force reload...");
        console.log("🔄 [RELOAD-BUTTON] Resource:", { resourceId, resourceType, locale });

        // BETTER FIX: Navigate to same page with cache-busting parameter
        // This forces the loader to run again without losing too much state
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('_reload', Date.now().toString());

        // Use replace: true to avoid adding to history
        navigate(currentUrl.pathname + currentUrl.search, { replace: true });

        console.log("✅ [RELOAD-BUTTON] Navigation triggered with cache-bust parameter");

        if (onReloadComplete) {
          onReloadComplete();
        }
      } else {
        console.error("❌ [RELOAD-BUTTON] Sync failed:", data.error);
        // Error
        alert(`Fehler beim Neuladen: ${data.error || "Unbekannter Fehler"}`);
      }
    }
  }, [fetcher.state, fetcher.data, isLoading, onReloadComplete, navigate, resourceId, resourceType, locale]);

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

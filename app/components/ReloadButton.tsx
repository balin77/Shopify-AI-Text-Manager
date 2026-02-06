import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import { useFetcher } from "@remix-run/react";

interface ReloadButtonProps {
  resourceId: string;
  resourceType: "product" | "collection" | "article" | "page" | "policy" | "templates";
  locale: string;
  onReloadComplete?: () => void;
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
  revalidator,
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

        // Wait a bit to ensure DB write is complete, then revalidate
        setTimeout(() => {
          if (revalidator) {
            console.log("🔄 [RELOAD-BUTTON] Revalidating to fetch updated data...");
            revalidator.revalidate();

            // Wait for revalidation to complete, then trigger data refresh
            const checkRevalidation = setInterval(() => {
              if (revalidator.state === 'idle') {
                clearInterval(checkRevalidation);
                console.log("✅ [RELOAD-BUTTON] Revalidation complete");
                setIsLoading(false);

                if (onReloadComplete) {
                  onReloadComplete();
                }
              }
            }, 100);

            // Timeout after 10 seconds
            setTimeout(() => {
              clearInterval(checkRevalidation);
              setIsLoading(false);
              console.warn("⚠️ [RELOAD-BUTTON] Revalidation timeout");
            }, 10000);
          } else {
            // Fallback to full page reload if revalidator not available
            console.log("⚠️ [RELOAD-BUTTON] No revalidator provided, falling back to page reload");
            const url = new URL(window.location.href);
            url.searchParams.set('selected', resourceId);
            url.searchParams.set('_t', Date.now().toString());
            window.location.href = url.toString();
          }
        }, 1000); // Wait 1 second for DB write to complete
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

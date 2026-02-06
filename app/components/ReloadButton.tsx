import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";

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
  const revalidator = useRevalidator();

  // Monitor fetcher state
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && isLoading) {
      console.log("🔄 [RELOAD-BUTTON] Sync complete, fetcher data:", fetcher.data);

      const data = fetcher.data as any;
      if (data.success) {
        console.log("✅ [RELOAD-BUTTON] Sync successful!");
        console.log("🔄 [RELOAD-BUTTON] Resource:", { resourceId, resourceType, locale });

        // Add a small delay before revalidating to ensure DB transaction completed
        setTimeout(() => {
          console.log("🔄 [RELOAD-BUTTON] Triggering revalidation...");
          revalidator.revalidate();
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
  }, [fetcher.state, fetcher.data, isLoading, onReloadComplete, resourceId, resourceType, locale, revalidator]);

  // Monitor revalidator state
  useEffect(() => {
    if (revalidator.state === "idle" && isLoading) {
      console.log("✅ [RELOAD-BUTTON] Revalidation complete, UI should update now");
      setIsLoading(false);
    }
  }, [revalidator.state, isLoading]);

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

import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState, useEffect, useRef } from "react";
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

  // Use ref for revalidator to avoid unstable reference in effect deps
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  // Monitor fetcher state
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether we've actually seen revalidator.state === 'loading' before accepting 'idle'.
  // Without this, the effect below fires immediately when waitingForRevalidation becomes true
  // (revalidator.state is still 'idle' at that point), causing onReloadComplete to be called
  // before fresh data has arrived in React — a race condition that leaves the UI stale.
  const revalidationStartedRef = useRef(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && isLoading) {
      const data = fetcher.data as any;
      if (data.success) {
        if (revalidatorRef.current) {
          // Use revalidation approach (non-destructive)
          timerRef.current = setTimeout(() => {
            // Cache-bust: Add timestamp to URL to force Remix to reload data
            const url = new URL(window.location.href);
            url.searchParams.set('_reload', Date.now().toString());
            window.history.replaceState({}, '', url.toString());

            setWaitingForRevalidation(true);
            revalidatorRef.current?.revalidate();
          }, 1000); // Wait 1 second for DB write to complete
        } else {
          // Fallback to page reload if revalidator not available
          timerRef.current = setTimeout(() => {
            // Store the selected product ID in URL to restore selection after reload
            const url = new URL(window.location.href);
            url.searchParams.set('selected', resourceId);
            url.searchParams.set('_t', Date.now().toString()); // Cache bust

            // Navigate to URL with selected parameter (forces full reload with selection preserved)
            window.location.href = url.toString();
          }, 500);

          if (onReloadComplete) {
            onReloadComplete();
          }
          onReloadSuccess?.();
        }
      } else {
        setIsLoading(false);
        alert(`Error reloading: ${data.error || "Unknown error"}`);
      }
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetcher.state, fetcher.data, isLoading, onReloadComplete, resourceId, resourceType, locale, onReloadSuccess]);

  // Monitor revalidation state
  useEffect(() => {
    if (!waitingForRevalidation || !revalidatorRef.current) return;

    if (revalidatorRef.current.state === 'loading') {
      // Revalidation has actually started — mark it so we don't fire too early
      revalidationStartedRef.current = true;
      return;
    }

    // Only fire onReloadComplete after we've confirmed revalidation started AND completed.
    // This prevents the race condition where this effect fires when waitingForRevalidation
    // first becomes true but revalidator.state is still 'idle' (Remix hasn't processed
    // revalidate() yet), which would call onReloadComplete before fresh data arrives.
    if (revalidationStartedRef.current && revalidatorRef.current.state === 'idle') {
      revalidationStartedRef.current = false;
      setWaitingForRevalidation(false);
      setIsLoading(false);

      if (onReloadComplete) {
        onReloadComplete();
      }
      if (onReloadSuccess) {
        onReloadSuccess();
      }
    }
  }, [revalidator?.state, waitingForRevalidation, onReloadComplete, onReloadSuccess]);

  const handleReload = () => {
    if (isLoading) {
      return;
    }

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

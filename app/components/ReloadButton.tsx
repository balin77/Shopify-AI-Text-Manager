import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useEffect, useRef } from "react";
import {
  useIsReloading,
  useCompletedReload,
  consumeCompleted,
  startReload,
  clearReloading,
} from "../hooks/useReloadingResources";

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
  const isLoading = useIsReloading(resourceId);
  const completedData = useCompletedReload(resourceId);

  // Use ref for revalidator to avoid unstable reference in effect deps
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const onReloadCompleteRef = useRef(onReloadComplete);
  onReloadCompleteRef.current = onReloadComplete;
  const onReloadSuccessRef = useRef(onReloadSuccess);
  onReloadSuccessRef.current = onReloadSuccess;

  // Track whether we've actually seen revalidator.state === 'loading' before accepting 'idle'.
  const revalidationStartedRef = useRef(false);
  const waitingForRevalidationRef = useRef(false);

  // Timer ref for cleanup
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle completed reload: trigger revalidation or page reload
  useEffect(() => {
    if (!completedData) return;

    // Consume the data so it's only processed once
    consumeCompleted(resourceId);

    if (!completedData.success) {
      alert(`Error reloading: ${completedData.error || "Unknown error"}`);
      return;
    }

    if (revalidatorRef.current) {
      // Use revalidation approach (non-destructive)
      timerRef.current = setTimeout(() => {
        // Cache-bust: Add timestamp to URL to force Remix to reload data
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', Date.now().toString());
        window.history.replaceState({}, '', url.toString());

        waitingForRevalidationRef.current = true;
        revalidationStartedRef.current = false;
        revalidatorRef.current?.revalidate();
      }, 1000); // Wait 1 second for DB write to complete
    } else {
      // Fallback to page reload if revalidator not available
      timerRef.current = setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('selected', resourceId);
        url.searchParams.set('_t', Date.now().toString());
        window.location.href = url.toString();
      }, 500);

      clearReloading(resourceId);
      onReloadCompleteRef.current?.();
      onReloadSuccessRef.current?.();
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [completedData, resourceId]);

  // Monitor revalidation state
  useEffect(() => {
    if (!waitingForRevalidationRef.current || !revalidatorRef.current) return;

    if (revalidatorRef.current.state === 'loading') {
      revalidationStartedRef.current = true;
      return;
    }

    if (revalidationStartedRef.current && revalidatorRef.current.state === 'idle') {
      revalidationStartedRef.current = false;
      waitingForRevalidationRef.current = false;
      clearReloading(resourceId);

      onReloadCompleteRef.current?.();
      onReloadSuccessRef.current?.();
    }
  }, [revalidator?.state, resourceId]);

  const handleReload = () => {
    if (isLoading) return;
    startReload(resourceId, resourceType, locale);
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

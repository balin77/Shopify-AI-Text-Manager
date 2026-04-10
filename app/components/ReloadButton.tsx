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

  // Ref to track which completedData we've already processed (avoids re-processing
  // if the component re-renders before the data is consumed from the store).
  const processedCompletedRef = useRef<object | null>(null);
  const prevResourceIdRef = useRef(resourceId);
  if (prevResourceIdRef.current !== resourceId) {
    prevResourceIdRef.current = resourceId;
    processedCompletedRef.current = null;
    waitingForRevalidationRef.current = false;
    revalidationStartedRef.current = false;
  }

  // Handle completed reload: trigger revalidation or page reload.
  // Uses a ref guard instead of depending on completedData in the dep array,
  // because a parent re-render (e.g. unstable useRevalidator ref) can cause
  // completedData to flip to undefined after consume, which would run the
  // effect cleanup and cancel the pending revalidation timeout.
  useEffect(() => {
    if (!completedData || completedData === processedCompletedRef.current) return;
    processedCompletedRef.current = completedData;

    // Consume the data so it's only processed once
    consumeCompleted(resourceId);

    if (!completedData.success) {
      alert(`Error reloading: ${completedData.error || "Unknown error"}`);
      return;
    }

    if (revalidatorRef.current) {
      // Use revalidation approach (non-destructive)
      // Wait 1 second for DB write to complete, then trigger revalidation
      setTimeout(() => {
        // Cache-bust: Add timestamp to URL to force Remix to reload data
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', Date.now().toString());
        window.history.replaceState({}, '', url.toString());

        waitingForRevalidationRef.current = true;
        revalidationStartedRef.current = false;
        revalidatorRef.current?.revalidate();
      }, 1000);
    } else {
      // Fallback to page reload if revalidator not available
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('selected', resourceId);
        url.searchParams.set('_t', Date.now().toString());
        window.location.href = url.toString();
      }, 500);

      clearReloading(resourceId);
      onReloadCompleteRef.current?.();
      onReloadSuccessRef.current?.();
    }
    // No cleanup — the timeout must survive parent re-renders.
    // It fires once (guarded by processedCompletedRef) and is harmless if the
    // component unmounts (revalidate on an unmounted tree is a no-op).
  });

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

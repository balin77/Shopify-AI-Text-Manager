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

  // Stable refs for values used inside setTimeout callbacks
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const onReloadCompleteRef = useRef(onReloadComplete);
  onReloadCompleteRef.current = onReloadComplete;
  const onReloadSuccessRef = useRef(onReloadSuccess);
  onReloadSuccessRef.current = onReloadSuccess;

  // Ref guard: track which completedData we've already processed.
  // Prevents re-processing when parent re-renders cause the effect to re-run.
  const processedCompletedRef = useRef<object | null>(null);
  const prevResourceIdRef = useRef(resourceId);
  if (prevResourceIdRef.current !== resourceId) {
    prevResourceIdRef.current = resourceId;
    processedCompletedRef.current = null;
  }

  // Tracks that we triggered a revalidation. Set just before revalidate() is called;
  // cleared when the revalidation-completion effect below detects idle.
  const reloadTriggeredRef = useRef(false);
  const reloadRidRef = useRef<string>('');

  // Detect revalidation completion via React's render cycle.
  // Replaces the old waitForIdle() setTimeout polling which had a race: the first poll
  // at +500ms could see state='idle' BEFORE React processed the 'loading' state from
  // revalidate(), causing triggerDataRefresh() to fire with stale item data. If translations
  // hadn't changed, the data-loading effect would never re-run for the fresh content.
  // React guarantees that when this effect fires with state='idle', the loader data
  // (and therefore selectedItemRef in the editor) already reflects the fresh response.
  useEffect(() => {
    if (!reloadTriggeredRef.current) return;
    if (revalidator?.state === 'idle') {
      const rid = reloadRidRef.current;
      reloadTriggeredRef.current = false;
      clearReloading(rid);
      onReloadCompleteRef.current?.();
      onReloadSuccessRef.current?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidator?.state]);

  // Handle completed reload: cache-bust, then trigger revalidation.
  useEffect(() => {
    if (!completedData || completedData === processedCompletedRef.current) return;
    processedCompletedRef.current = completedData;

    consumeCompleted(resourceId);

    if (!completedData.success) {
      alert(`Error reloading: ${completedData.error || "Unknown error"}`);
      return;
    }

    const rid = resourceId;

    if (revalidatorRef.current) {
      // Wait 1s for DB write to settle, then trigger revalidation.
      setTimeout(() => {
        // Cache-bust: force Remix to reload data
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', Date.now().toString());
        window.history.replaceState({}, '', url.toString());

        // Set the flag BEFORE calling revalidate() so the effect above is ready
        // to handle the idle transition that follows.
        reloadRidRef.current = rid;
        reloadTriggeredRef.current = true;

        revalidatorRef.current?.revalidate();
      }, 1000);
    } else {
      // Fallback: full page reload if revalidator not available
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('selected', rid);
        url.searchParams.set('_t', Date.now().toString());
        window.location.href = url.toString();
      }, 500);

      clearReloading(rid);
      onReloadCompleteRef.current?.();
      onReloadSuccessRef.current?.();
    }
  });

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

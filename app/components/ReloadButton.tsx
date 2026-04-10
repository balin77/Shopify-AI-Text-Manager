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

  // Handle completed reload: trigger revalidation, then clear spinner.
  // The entire post-fetch flow (revalidation + completion) runs inside
  // setTimeout callbacks so it's immune to React re-renders and effect cleanups.
  useEffect(() => {
    if (!completedData || completedData === processedCompletedRef.current) return;
    processedCompletedRef.current = completedData;

    // Consume from the store so it's only processed once
    consumeCompleted(resourceId);

    if (!completedData.success) {
      alert(`Error reloading: ${completedData.error || "Unknown error"}`);
      return;
    }

    // Capture resourceId in closure for the timeout chain
    const rid = resourceId;

    if (revalidatorRef.current) {
      // Wait 1s for DB write to settle, then trigger revalidation
      setTimeout(() => {
        // Cache-bust: force Remix to reload data
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', Date.now().toString());
        window.history.replaceState({}, '', url.toString());

        revalidatorRef.current?.revalidate();

        // Poll until revalidator is idle (revalidation complete), then finish.
        // This replaces the old useEffect-based monitoring which missed fast
        // revalidations due to React batching loading→idle into a single render.
        const waitForIdle = (attempts: number) => {
          if (attempts > 20) {
            // Safety: give up after ~10s to avoid infinite polling
            clearReloading(rid);
            return;
          }
          if (revalidatorRef.current?.state === 'idle') {
            clearReloading(rid);
            onReloadCompleteRef.current?.();
            onReloadSuccessRef.current?.();
          } else {
            setTimeout(() => waitForIdle(attempts + 1), 500);
          }
        };
        // Give revalidation a moment to start before checking for idle
        setTimeout(() => waitForIdle(0), 500);
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

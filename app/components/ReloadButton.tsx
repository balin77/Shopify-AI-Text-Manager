import type { ReloadResourceType } from "../utils/reload-resource-type";
import { useRef } from "react";
import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { startReload, useIsReloading } from "../hooks/useReloadingResources";

interface ReloadButtonProps {
  resourceId: string;
  /** "blog" is the BLOG CONTAINER, not an article — the blogs tab serves both
   *  and they reload through different Shopify resources. */
  resourceType: ReloadResourceType;
  locale: string;
  onReloadComplete?: () => void;
  onReloadSuccess?: () => void;
  revalidator?: {
    revalidate: () => void;
    state: 'idle' | 'loading';
  };
  /** Tooltip + accessibility label. Defaults describe the single-item reload. */
  tooltip?: string;
}

export function ReloadButton({
  resourceId,
  resourceType,
  locale,
  onReloadComplete,
  onReloadSuccess,
  revalidator,
  tooltip = "Nur die Daten dieses Eintrags von Shopify neu laden",
}: ReloadButtonProps) {
  const isLoading = useIsReloading(resourceId);
  // The latest revalidator, read when the reload polls for it to become idle:
  // React Router hands out a NEW object per state change, so one captured at the
  // click stays "idle" for ever and the wait ends after its fallback no matter
  // what the loader is doing.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const handleReload = () => {
    if (isLoading) return;
    void startReload(
      resourceId,
      resourceType,
      locale,
      revalidator
        ? {
            getState: () => revalidatorRef.current?.state ?? "idle",
            revalidate: () => revalidatorRef.current?.revalidate(),
          }
        : null,
      {
        onComplete: onReloadComplete,
        onSuccess: onReloadSuccess,
        onError: (msg) => alert(`Error reloading: ${msg}`),
      },
    );
  };

  return (
    <Tooltip content={tooltip}>
      <Button
        icon={RefreshIcon}
        onClick={handleReload}
        loading={isLoading}
        disabled={isLoading}
        accessibilityLabel={tooltip}
        size="slim"
      />
    </Tooltip>
  );
}

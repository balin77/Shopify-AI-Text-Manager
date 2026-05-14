import { Button, Tooltip } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { startReload, useIsReloading } from "../hooks/useReloadingResources";

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

  const handleReload = () => {
    if (isLoading) return;
    void startReload(
      resourceId,
      resourceType,
      locale,
      revalidator
        ? {
            getState: () => revalidator.state,
            revalidate: () => revalidator.revalidate(),
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

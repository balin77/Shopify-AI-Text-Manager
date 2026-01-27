import { useState, useCallback, useEffect } from "react";
import { Text, BlockStack, ProgressBar, InlineStack, Box, Banner, Button } from "@shopify/polaris";

export interface SyncProgress {
  phase: string;
  message: string;
  current: number;
  total: number;
  completedPhases: string[];
  detailCurrent?: number;
  detailTotal?: number;
  detailMessage?: string;
}

export interface SyncStats {
  products: number;
  collections: number;
  articles: number;
  pages: number;
  policies?: number;
  themes?: number;
}

interface SyncProgressBarProps {
  /** Whether to show the sync button */
  showButton?: boolean;
  /** Button label */
  buttonLabel?: string;
  /** Secondary button label (e.g., "Force Re-Sync") */
  secondaryButtonLabel?: string;
  /** Whether to show secondary button */
  showSecondaryButton?: boolean;
  /** Primary button variant */
  buttonVariant?: "primary" | "secondary" | "tertiary";
  /** Callback when sync completes */
  onComplete?: (stats: SyncStats) => void;
  /** Callback when sync fails */
  onError?: (error: string) => void;
  /** Auto-start sync on mount */
  autoStart?: boolean;
  /** Force full re-sync (delete existing data first) */
  forceSync?: boolean;
  /** Custom title for the progress section */
  title?: string;
}

const phaseLabels: Record<string, string> = {
  products: "Products",
  collections: "Collections",
  articles: "Articles",
  pages: "Pages",
  policies: "Policies",
  themes: "Themes",
};

const phaseOrder = ["products", "collections", "articles", "pages", "policies", "themes"];

export function SyncProgressBar({
  showButton = true,
  buttonLabel = "Sync All Content",
  secondaryButtonLabel = "Force Full Re-Sync",
  showSecondaryButton = false,
  buttonVariant = "primary",
  onComplete,
  onError,
  autoStart = false,
  forceSync = false,
  title = "Syncing Content",
}: SyncProgressBarProps) {
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  const handleSync = useCallback(async (force: boolean = false) => {
    setSyncStatus("");
    setSyncLoading(true);
    setSyncProgress({
      phase: "starting",
      message: "Starting sync...",
      current: 0,
      total: 100,
      completedPhases: []
    });

    try {
      const streamUrl = force ? "/api/sync-all-stream?force=true" : "/api/sync-all-stream";
      const response = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalStats: SyncStats | null = null;
      let completedPhases: string[] = [];
      let lastPhase = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "progress") {
                // Track completed phases
                if (lastPhase && lastPhase !== data.phase && !completedPhases.includes(lastPhase)) {
                  completedPhases = [...completedPhases, lastPhase];
                }
                lastPhase = data.phase;

                // Calculate overall progress based on phase
                const phaseIndex = phaseOrder.indexOf(data.phase);
                const phaseProgress = phaseIndex >= 0 ? phaseIndex : 0;
                const phasePercent = data.current || 0;
                const overallProgress = Math.round((phaseProgress / phaseOrder.length) * 100 + (phasePercent / phaseOrder.length));

                setSyncProgress({
                  phase: data.phase,
                  message: data.message,
                  current: overallProgress,
                  total: 100,
                  completedPhases: [...completedPhases],
                  detailCurrent: data.detailCurrent,
                  detailTotal: data.detailTotal,
                  detailMessage: data.detailMessage,
                });
              } else if (data.type === "complete") {
                finalStats = data.stats;
                setSyncProgress(null);
                setSyncStatus(
                  `Synced ${finalStats!.products} products, ${finalStats!.collections} collections, ${finalStats!.articles} articles, ${finalStats!.pages} pages`
                );
                onComplete?.(finalStats!);
              } else if (data.type === "error") {
                setSyncProgress(null);
                setSyncStatus(`Error: ${data.message}`);
                onError?.(data.message);
              }
            } catch (e) {
              console.error("Failed to parse SSE message:", e);
            }
          }
        }
      }

      // If we finished without receiving a "complete" event, check if we got stats
      if (!finalStats && !syncProgress) {
        setSyncStatus("Sync completed");
      }
    } catch (error: any) {
      setSyncProgress(null);
      setSyncStatus(`Error: ${error.message}`);
      onError?.(error.message);
    } finally {
      setSyncLoading(false);
    }
  }, [onComplete, onError]);

  // Auto-start sync on mount if requested
  useEffect(() => {
    if (autoStart) {
      handleSync(forceSync);
    }
  }, [autoStart, forceSync, handleSync]);

  return (
    <BlockStack gap="400">
      {showButton && (
        <InlineStack gap="200">
          <Button
            onClick={() => handleSync(false)}
            loading={syncLoading}
            variant={buttonVariant}
          >
            {buttonLabel}
          </Button>
          {showSecondaryButton && (
            <Button
              onClick={() => handleSync(true)}
              loading={syncLoading}
              variant="secondary"
            >
              {secondaryButtonLabel}
            </Button>
          )}
        </InlineStack>
      )}

      {syncProgress && (
        <Box padding="400" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {title}
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                {syncProgress.current}%
              </Text>
            </InlineStack>
            <ProgressBar progress={syncProgress.current} size="small" />
            <InlineStack gap="300" wrap={true}>
              {phaseOrder.map((phase) => {
                const isCompleted = syncProgress.completedPhases.includes(phase);
                const isCurrent = syncProgress.phase === phase;
                return (
                  <Text
                    key={phase}
                    as="span"
                    variant="bodySm"
                    tone={isCompleted ? "success" : isCurrent ? "base" : "subdued"}
                    fontWeight={isCurrent ? "semibold" : "regular"}
                  >
                    {isCompleted ? "✓ " : isCurrent ? "● " : "○ "}
                    {phaseLabels[phase]}
                  </Text>
                );
              })}
            </InlineStack>
            {syncProgress.detailTotal && syncProgress.detailTotal > 1 && (
              <Box paddingBlockStart="200">
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {syncProgress.detailMessage || `${syncProgress.detailCurrent}/${syncProgress.detailTotal}`}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {syncProgress.detailCurrent}/{syncProgress.detailTotal}
                    </Text>
                  </InlineStack>
                  <ProgressBar
                    progress={Math.round(((syncProgress.detailCurrent || 0) / syncProgress.detailTotal) * 100)}
                    size="small"
                    tone="highlight"
                  />
                </BlockStack>
              </Box>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              {syncProgress.message}
            </Text>
          </BlockStack>
        </Box>
      )}

      {syncStatus && !syncProgress && (
        <Banner
          tone={syncStatus.startsWith("Error") ? "critical" : "success"}
        >
          {syncStatus.startsWith("Error") ? syncStatus : `✓ ${syncStatus}`}
        </Banner>
      )}
    </BlockStack>
  );
}

/**
 * Hook to programmatically control sync
 */
export function useSyncProgress() {
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncComplete, setSyncComplete] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStats | null>(null);

  const startSync = useCallback(async (force: boolean = false): Promise<SyncStats | null> => {
    setSyncStatus("");
    setSyncLoading(true);
    setSyncComplete(false);
    setSyncStats(null);
    setSyncProgress({
      phase: "starting",
      message: "Starting sync...",
      current: 0,
      total: 100,
      completedPhases: []
    });

    try {
      const streamUrl = force ? "/api/sync-all-stream?force=true" : "/api/sync-all-stream";
      const response = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalStats: SyncStats | null = null;
      let completedPhases: string[] = [];
      let lastPhase = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "progress") {
                if (lastPhase && lastPhase !== data.phase && !completedPhases.includes(lastPhase)) {
                  completedPhases = [...completedPhases, lastPhase];
                }
                lastPhase = data.phase;

                const phaseIndex = phaseOrder.indexOf(data.phase);
                const phaseProgress = phaseIndex >= 0 ? phaseIndex : 0;
                const phasePercent = data.current || 0;
                const overallProgress = Math.round((phaseProgress / phaseOrder.length) * 100 + (phasePercent / phaseOrder.length));

                setSyncProgress({
                  phase: data.phase,
                  message: data.message,
                  current: overallProgress,
                  total: 100,
                  completedPhases: [...completedPhases],
                  detailCurrent: data.detailCurrent,
                  detailTotal: data.detailTotal,
                  detailMessage: data.detailMessage,
                });
              } else if (data.type === "complete") {
                finalStats = data.stats;
                setSyncProgress(null);
                setSyncComplete(true);
                setSyncStats(finalStats);
                setSyncStatus(
                  `Synced ${finalStats!.products} products, ${finalStats!.collections} collections, ${finalStats!.articles} articles, ${finalStats!.pages} pages`
                );
              } else if (data.type === "error") {
                setSyncProgress(null);
                setSyncStatus(`Error: ${data.message}`);
              }
            } catch (e) {
              console.error("Failed to parse SSE message:", e);
            }
          }
        }
      }

      return finalStats;
    } catch (error: any) {
      setSyncProgress(null);
      setSyncStatus(`Error: ${error.message}`);
      return null;
    } finally {
      setSyncLoading(false);
    }
  }, []);

  return {
    syncStatus,
    syncLoading,
    syncProgress,
    syncComplete,
    syncStats,
    startSync,
  };
}

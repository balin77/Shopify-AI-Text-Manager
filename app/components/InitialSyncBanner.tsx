/**
 * InitialSyncBanner
 *
 * Persistent onboarding/re-sync progress banner. Mounted once in the app shell
 * (app.tsx → AppContent), so it survives in-app navigation between
 * /app/products, /app/content, … without resetting its poll state.
 *
 * Polls /api/sync-status (cheap single-row lookup). While a sync is in
 * progress it also revalidates the current route's loader so freshly synced
 * rows appear live. Polls fast while syncing, slow heartbeat otherwise so a
 * Settings "force re-sync" (which re-sets needsSetup) is picked up too.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation, useRevalidator } from "@remix-run/react";
import { Banner, ProgressBar, BlockStack, Text, Box } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

interface SyncStatus {
  needsSetup: boolean;
  phase: string | null;
  percent: number;
  error: string | null;
}

const FAST_MS = 4000;   // actively syncing
const IDLE_MS = 30000;  // heartbeat so a later force re-sync is detected
const MAX_MS = 60000;   // error backoff ceiling

const phaseKeys: Record<string, string> = {
  products: "phaseProducts",
  collections: "phaseCollections",
  articles: "phaseArticles",
  pages: "phasePages",
  policies: "phasePolicies",
  themes: "phaseThemes",
  metaobjects: "phaseMetaobjects",
};

export function InitialSyncBanner() {
  const { t } = useI18n();
  const location = useLocation();
  const revalidator = useRevalidator();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const inflightRef = useRef(false);
  const intervalRef = useRef(IDLE_MS);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search).toString();
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || inflightRef.current) {
        if (!cancelled) timeoutId = setTimeout(poll, intervalRef.current);
        return;
      }
      inflightRef.current = true;
      try {
        const res = await fetch(`/api/sync-status?${searchParams}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SyncStatus;
        if (cancelled) return;
        setStatus(data);
        intervalRef.current = data.needsSetup ? FAST_MS : IDLE_MS;
        // While syncing, refresh the current page's loader so newly synced
        // rows show up live (skip if a revalidation is already running).
        if (data.needsSetup && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      } catch {
        // Back off on error so a flaky endpoint doesn't hammer the server.
        intervalRef.current = Math.min(intervalRef.current * 2, MAX_MS);
      } finally {
        inflightRef.current = false;
        if (!cancelled) timeoutId = setTimeout(poll, intervalRef.current);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // revalidator identity is stable enough; re-arm only on shop/host change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  if (!status || !status.needsSetup) return null;

  if (status.error) {
    return (
      <Box padding="300">
        <Banner tone="critical" title={t.settings?.syncingContent || "Sync"}>
          <p>{status.error}</p>
        </Banner>
      </Box>
    );
  }

  const phaseLabel =
    (status.phase &&
      (t.settings as unknown as Record<string, string>)[phaseKeys[status.phase] ?? ""]) ||
    status.phase ||
    "";
  const percent = Math.max(0, Math.min(100, status.percent || 0));

  return (
    <Box padding="300">
      <Banner tone="info" title={t.settings?.syncingContent || "Setting up your store"}>
        <BlockStack gap="200">
          <Text as="p" variant="bodySm" tone="subdued">
            {phaseLabel ? `${phaseLabel} — ${percent}%` : `${percent}%`}
          </Text>
          <ProgressBar progress={percent} size="small" />
        </BlockStack>
      </Banner>
    </Box>
  );
}

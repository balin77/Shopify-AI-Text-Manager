/**
 * InitialSyncWatcher
 *
 * Headless poller (renders nothing). Mounted once in the app shell
 * (app.tsx → AppContent, inside InfoBoxProvider) so it survives in-app
 * navigation without resetting its poll state.
 *
 * It polls /api/sync-status and feeds progress into InfoBoxContext, which
 * renders it in the navigation's infobox slot (in place of toasts) until the
 * sync finishes. When the sync completes it triggers ONE loader revalidation
 * so freshly synced rows appear — no per-tick revalidation (that caused a
 * revalidation storm / "app unavailable" in the embedded app).
 *
 * Fast poll while syncing, slow heartbeat otherwise so a Settings "force
 * re-sync" (which re-sets needsSetup) is still picked up.
 */

import { useEffect, useRef } from "react";
import { useLocation, useRevalidator } from "@remix-run/react";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface SyncStatus {
  needsSetup: boolean;
  phase: string | null;
  percent: number;
  error: string | null;
  stats: Record<string, number> | null;
}

const FAST_MS = 4000;   // actively syncing
const IDLE_MS = 30000;  // heartbeat so a later force re-sync is detected
const MAX_MS = 60000;   // error backoff ceiling

export function InitialSyncBanner() {
  const location = useLocation();
  const revalidator = useRevalidator();
  const { setSyncProgress } = useInfoBox();
  const inflightRef = useRef(false);
  const intervalRef = useRef(IDLE_MS);
  const wasSyncingRef = useRef(false);

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

        if (data.needsSetup) {
          setSyncProgress({
            phase: data.phase,
            percent: Math.max(0, Math.min(100, data.percent || 0)),
            error: data.error,
            stats: data.stats ?? null,
          });
          wasSyncingRef.current = true;
          intervalRef.current = FAST_MS;
        } else {
          setSyncProgress(null);
          intervalRef.current = IDLE_MS;
          // Sync just finished → refresh the current page's data ONCE.
          if (wasSyncingRef.current && revalidator.state === "idle") {
            wasSyncingRef.current = false;
            revalidator.revalidate();
          }
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
    // Re-arm only on shop/host change; revalidator/setSyncProgress are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  return null;
}

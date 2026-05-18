/**
 * InitialSyncWatcher
 *
 * Headless poller (renders nothing). Mounted once in the app shell
 * (app.tsx → AppContent, inside InfoBoxProvider).
 *
 * Robustness:
 *  - Seeds progress from the shell loader (app.tsx → initialSync) so the
 *    banner shows immediately on any full document load / app reopen,
 *    without waiting for the first poll.
 *  - Runs ONE stable poll loop for the lifetime of the persistent shell
 *    (deps []), so in-app navigation never tears it down / hides the banner.
 *  - On completion it triggers ONE loader revalidation (no per-tick
 *    revalidation — that caused a refetch storm / "app unavailable").
 *
 * Fast poll while syncing, slow heartbeat otherwise so a Settings "force
 * re-sync" (which re-sets needsSetup) is still picked up.
 */

import { useEffect, useRef } from "react";
import { useLocation, useRevalidator, useRouteLoaderData } from "@remix-run/react";
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
  const rootData = useRouteLoaderData("routes/app") as
    | { initialSync?: SyncStatus | null }
    | undefined;

  // Always fetch with the freshest Shopify params without re-subscribing.
  const searchRef = useRef("");
  searchRef.current = new URLSearchParams(location.search).toString();

  const inflightRef = useRef(false);
  const intervalRef = useRef(FAST_MS);
  const wasSyncingRef = useRef(false);

  // Seed once from the shell loader (instant render after reload/reopen).
  useEffect(() => {
    const s = rootData?.initialSync;
    if (s && s.needsSetup) {
      setSyncProgress({
        phase: s.phase,
        percent: Math.max(0, Math.min(100, s.percent || 0)),
        error: s.error,
        stats: s.stats ?? null,
      });
      wasSyncingRef.current = true;
    }
    // Mount-only seed; polling below keeps it fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single stable poll loop for the persistent shell's lifetime.
  useEffect(() => {
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (stopped) return;
      if (inflightRef.current) {
        timeoutId = setTimeout(poll, intervalRef.current);
        return;
      }
      inflightRef.current = true;
      try {
        const res = await fetch(`/api/sync-status?${searchRef.current}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SyncStatus;
        if (stopped) return;

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
        if (!stopped) timeoutId = setTimeout(poll, intervalRef.current);
      }
    };

    poll();
    return () => {
      stopped = true;
      clearTimeout(timeoutId);
    };
    // Mount-once: do NOT depend on location — navigation must not tear this
    // down (that hid the banner on every nav). searchRef stays current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * A background READ of one of this app's JSON routes, with the shape of
 * `fetcher.load` (`state`, `data`, `load`) but over plain `appFetch`.
 *
 * Why not `useFetcher().load`: a router fetcher that gets a non-2xx answer (the
 * rate limiter's 429, a proxy 502) hands it to the nearest route error boundary
 * and REPLACES THE WHOLE PAGE - for a read the merchant did not even ask for
 * (a product switch, a tab). Here a failure stays local: `failed` is true and
 * the caller decides what to show.
 *
 * Not a drop-in for every router fetcher: a router fetcher is re-run by every
 * `revalidate()`, a plain read is not. Only use this for a read nothing relies
 * on being refreshed that way (see CLAUDE.md).
 *
 * Latest wins: a new `load` aborts the one before it (reads only), an
 * answer for an aborted request is ignored, and nothing is set after unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { appFetchJson } from "~/utils/app-fetch";

interface Snapshot<T> {
  state: "idle" | "loading";
  /** The parsed body of the latest answer (also of an error answer that is JSON). */
  data: T | null;
  /** The request failed: network, non-JSON, or a non-2xx status. */
  failed: boolean;
  /** The URL this snapshot was asked for - an answer can be matched to its request. */
  url: string | null;
}

export function useBackgroundJson<T>(): Snapshot<T> & { load: (url: string) => void } {
  const [snap, setSnap] = useState<Snapshot<T>>({ state: "idle", data: null, failed: false, url: null });
  const controllerRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const load = useCallback((url: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSnap({ state: "loading", data: null, failed: false, url });
    appFetchJson<T>(url, { signal: controller.signal }).then(
      ({ response, data }) => {
        if (controller.signal.aborted || !aliveRef.current) return;
        setSnap({ state: "idle", data, failed: !response.ok, url });
      },
      () => {
        if (controller.signal.aborted || !aliveRef.current) return;
        setSnap({ state: "idle", data: null, failed: true, url });
      },
    );
  }, []);

  return { ...snap, load };
}

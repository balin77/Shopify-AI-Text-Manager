/**
 * Loads the tracked keywords of one (resource, locale) for the item sidebar.
 *
 * A plain `appFetch`, never `fetcher.load`: a router fetcher that gets a non-2xx
 * answer (the rate limiter's 429, a proxy 502) hands the error to the nearest
 * route boundary and REPLACES THE WHOLE PAGE, for what is a background read. Here
 * a failure stays local: `onFailed` is called and the caller shows it.
 *
 * Late answers are ignored: each run is cancelled when the (resource, locale)
 * changes or the component unmounts, and an in-flight request for the scope the
 * merchant has left is aborted (reads only).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { appFetchJson } from "~/utils/app-fetch";

export interface KeywordLoadResult<T> {
  keywords: T[];
}

export function useSeoKeywordLoad<T>(args: {
  resourceId: string | null | undefined;
  resourceType: string | null | undefined;
  locale: string;
  onLoaded: (keywords: T[]) => void;
  onFailed: () => void;
}): { retry: () => void } {
  const { resourceId, resourceType, locale } = args;
  const callbacks = useRef(args);
  callbacks.current = args;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!resourceId || !resourceType) return;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const { response, data } = await appFetchJson<KeywordLoadResult<T>>(
          `/api/seo-keyword?resourceId=${encodeURIComponent(resourceId)}&locale=${encodeURIComponent(locale)}`,
          { signal: controller.signal },
        );
        if (cancelled) return;
        // An error answer is NOT an empty list.
        if (!response.ok || !Array.isArray(data?.keywords)) {
          callbacks.current.onFailed();
          return;
        }
        callbacks.current.onLoaded(data.keywords);
      } catch {
        if (!cancelled) callbacks.current.onFailed();
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [resourceId, resourceType, locale, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { retry };
}

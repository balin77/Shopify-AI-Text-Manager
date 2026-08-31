import { useEffect, useState } from "react";

/**
 * `false` on the server AND during the first client render, `true` from the
 * first effect onwards.
 *
 * The one purpose: render values that can only agree between server and client
 * AFTER hydration. Anything derived from the browser's time zone, its default
 * locale or its `localStorage` produces a different string/tree on each side,
 * and React 18 answers that with a hydration mismatch — in production the
 * minified error #418, which throws the whole root away and re-renders it on
 * the client. Sentry saw exactly that on `master`.
 *
 * Why it must stay `false` for the first client render and not just check
 * `typeof window`: hydration compares the server's HTML against the FIRST
 * client render, so a `typeof window` check flips too early and mismatches
 * anyway. The state only turns true in an effect, i.e. after that comparison.
 *
 * Callers pair it with the `formatDateTime`/`formatDate`/`formatTime` helpers
 * in [format.ts](../utils/format.ts), which take the flag and fall back to a
 * deterministic UTC rendering while it is false.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return hydrated;
}

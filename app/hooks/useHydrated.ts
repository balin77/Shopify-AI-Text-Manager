import { useSyncExternalStore } from "react";

/**
 * `false` while the component is being hydrated, `true` otherwise.
 *
 * The one purpose: render values that can only agree between server and client
 * AFTER hydration. Anything derived from the browser's time zone, its default
 * locale or its `localStorage` produces a different string/tree on each side,
 * and React 18 answers that with a hydration mismatch — in production the
 * minified error #418, which throws the whole root away and re-renders it on
 * the client. Sentry saw exactly that on `master`.
 *
 * Why not `typeof window !== "undefined"`: hydration compares the server's
 * HTML against the FIRST client render, and `window` already exists by then.
 * The check would flip too early and mismatch anyway.
 *
 * Why `useSyncExternalStore` and not `useState(false)` + an effect: React reads
 * `getServerSnapshot` on the server and on the MOUNT render while hydrating,
 * then `getSnapshot` for anything mounted later. So this is `false` exactly for
 * the render React compares against the server HTML — and already `true` on
 * the first render of a component mounted by a client-side navigation, which
 * is most of them. The effect-based version returns `false` there too and
 * makes every timestamp paint its UTC form for one frame before flipping.
 *
 * The narrow spot, since the guarantee is about the MOUNT render: React 18's
 * `updateSyncExternalStore` calls `getSnapshot` unconditionally, with no
 * hydration check. A component that does a render-phase `setState` (the
 * re-render dispatcher) while hydration is still in flight would therefore see
 * `true` on that re-render and mismatch anyway. No call site does that today —
 * but do not add one next to a `useHydrated`, and do not read the paragraph
 * above as "true throughout hydration", because it is not.
 *
 * The store never changes, so `subscribe` returns a no-op unsubscribe. All
 * three arguments are module constants: React re-subscribes when `subscribe`
 * changes identity, which an arrow re-created per render would do every time.
 *
 * Callers pair it with the `formatDateTime`/`formatDate`/`formatTime` helpers
 * in [format.ts](../utils/format.ts), which take the flag and fall back to a
 * deterministic UTC rendering while it is false.
 */
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Tracks in-flight Alt-Text Manager operations **per product** so they survive
 * product switches: an apply/translate started on product A keeps running and
 * keeps A's buttons disabled even after the user navigates to product B, and
 * the buttons re-appear blocked when they navigate back to A. Because the async
 * work lives in JS promises (not React lifecycle), the only thing that has to
 * persist across the product change is this flag store — held above the editor
 * route so it is not torn down when the panel re-keys on productId.
 */
export interface AltTextOpState {
  /** Single active-locale "Apply to images in X" is running. */
  applying: boolean;
  /** "Apply to images in all languages" is running. */
  applyingAll: boolean;
  /** Progress of the multi-locale apply, or null when not running. */
  applyAllProgress: { done: number; total: number } | null;
  /** "Translate all positions" is running. */
  translatingAll: boolean;
  /** Stable pos.position values whose individual "Translate" is running. */
  translatingPositions: number[];
}

const EMPTY: AltTextOpState = {
  applying: false,
  applyingAll: false,
  applyAllProgress: null,
  translatingAll: false,
  translatingPositions: [],
};

// True when a product's state carries no in-flight work, so its map entry can
// be dropped (keeps the store from growing one row per visited product).
function isIdle(s: AltTextOpState): boolean {
  return (
    !s.applying &&
    !s.applyingAll &&
    s.applyAllProgress === null &&
    !s.translatingAll &&
    s.translatingPositions.length === 0
  );
}

interface AltTextOpsMutators {
  patchOps: (productId: string, patch: Partial<AltTextOpState>) => void;
  setPositionTranslating: (productId: string, position: number, on: boolean) => void;
}

const AltTextOpsMutatorContext = createContext<AltTextOpsMutators | null>(null);
const AltTextOpsStateContext = createContext<Record<string, AltTextOpState>>({});

export function AltTextOpsProvider({ children }: { children: React.ReactNode }) {
  const [ops, setOps] = useState<Record<string, AltTextOpState>>({});

  const patchOps = useCallback(
    (productId: string, patch: Partial<AltTextOpState>) => {
      setOps((prev) => {
        const next = { ...(prev[productId] ?? EMPTY), ...patch };
        if (isIdle(next)) {
          if (!(productId in prev)) return prev;
          const { [productId]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [productId]: next };
      });
    },
    []
  );

  const setPositionTranslating = useCallback(
    (productId: string, position: number, on: boolean) => {
      setOps((prev) => {
        const current = prev[productId] ?? EMPTY;
        const set = new Set(current.translatingPositions);
        if (on) set.add(position);
        else set.delete(position);
        const next = { ...current, translatingPositions: [...set] };
        if (isIdle(next)) {
          if (!(productId in prev)) return prev;
          const { [productId]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [productId]: next };
      });
    },
    []
  );

  const mutators = useMemo(
    () => ({ patchOps, setPositionTranslating }),
    [patchOps, setPositionTranslating]
  );

  return (
    <AltTextOpsMutatorContext.Provider value={mutators}>
      <AltTextOpsStateContext.Provider value={ops}>{children}</AltTextOpsStateContext.Provider>
    </AltTextOpsMutatorContext.Provider>
  );
}

/** Subscribe to one product's operation state plus the mutators. */
export function useAltTextOps(productId: string) {
  const mutators = useContext(AltTextOpsMutatorContext);
  const state = useContext(AltTextOpsStateContext);
  if (!mutators) throw new Error("useAltTextOps must be used within AltTextOpsProvider");
  const ops = state[productId] ?? EMPTY;
  return {
    ops,
    patch: useCallback(
      (patch: Partial<AltTextOpState>) => mutators.patchOps(productId, patch),
      [mutators, productId]
    ),
    setPositionTranslating: useCallback(
      (position: number, on: boolean) =>
        mutators.setPositionTranslating(productId, position, on),
      [mutators, productId]
    ),
  };
}

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

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
  /** Position indices whose individual "Translate" is running. */
  translatingPositions: number[];
}

const EMPTY: AltTextOpState = {
  applying: false,
  applyingAll: false,
  applyAllProgress: null,
  translatingAll: false,
  translatingPositions: [],
};

interface AltTextOpsContextType {
  getOps: (productId: string) => AltTextOpState;
  patchOps: (productId: string, patch: Partial<AltTextOpState>) => void;
  setPositionTranslating: (productId: string, positionIndex: number, on: boolean) => void;
}

const AltTextOpsContext = createContext<AltTextOpsContextType | null>(null);

export function AltTextOpsProvider({ children }: { children: React.ReactNode }) {
  const [ops, setOps] = useState<Record<string, AltTextOpState>>({});
  // A ref mirror lets mutators compose without stale-closure reads when several
  // updates land in the same tick (e.g. parallel per-locale progress bumps).
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const patchOps = useCallback((productId: string, patch: Partial<AltTextOpState>) => {
    setOps((prev) => {
      const current = prev[productId] ?? EMPTY;
      return { ...prev, [productId]: { ...current, ...patch } };
    });
  }, []);

  const setPositionTranslating = useCallback(
    (productId: string, positionIndex: number, on: boolean) => {
      setOps((prev) => {
        const current = prev[productId] ?? EMPTY;
        const set = new Set(current.translatingPositions);
        if (on) set.add(positionIndex);
        else set.delete(positionIndex);
        return { ...prev, [productId]: { ...current, translatingPositions: [...set] } };
      });
    },
    []
  );

  const getOps = useCallback((productId: string): AltTextOpState => {
    return opsRef.current[productId] ?? EMPTY;
  }, []);

  const value = useMemo(
    () => ({ getOps, patchOps, setPositionTranslating }),
    [getOps, patchOps, setPositionTranslating]
  );

  // Re-render consumers when the store changes by threading `ops` through a
  // second context value the hook subscribes to.
  return (
    <AltTextOpsContext.Provider value={value}>
      <AltTextOpsStateContext.Provider value={ops}>{children}</AltTextOpsStateContext.Provider>
    </AltTextOpsContext.Provider>
  );
}

const AltTextOpsStateContext = createContext<Record<string, AltTextOpState>>({});

/** Subscribe to one product's operation state plus the mutators. */
export function useAltTextOps(productId: string) {
  const ctx = useContext(AltTextOpsContext);
  const state = useContext(AltTextOpsStateContext);
  if (!ctx) throw new Error("useAltTextOps must be used within AltTextOpsProvider");
  const opState = state[productId] ?? EMPTY;
  return {
    ops: opState,
    patch: useCallback(
      (patch: Partial<AltTextOpState>) => ctx.patchOps(productId, patch),
      [ctx, productId]
    ),
    setPositionTranslating: useCallback(
      (positionIndex: number, on: boolean) =>
        ctx.setPositionTranslating(productId, positionIndex, on),
      [ctx, productId]
    ),
  };
}

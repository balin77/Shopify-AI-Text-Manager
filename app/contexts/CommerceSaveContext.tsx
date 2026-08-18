/**
 * Lets the stock/channels panel be driven by the editor's ONE save bar.
 *
 * Phase 4 gave that panel its own Save button, for a reason that still holds:
 * a stock quantity must not travel in the editor's flat value map, because it
 * is volatile — orders and other apps move it between two page loads, and a
 * number carried along with the text would be stale by the time anyone pressed
 * save. The panel therefore keeps its own state, its own endpoint and its own
 * compare-and-swap (`compareQuantity`), and none of that changes here.
 *
 * What changes is only WHO presses the button. Two save buttons on one screen
 * is a question the merchant has to answer ("did that one include my text?"),
 * and the answer was "no". So the panel REGISTERS itself, and the save bar —
 * which already drives the content save and the sub-resource save — drives this
 * one too. Same three writes, one button.
 *
 * The registration is a callback rather than a prop chain because the panel is
 * rendered deep inside `UnifiedFieldRenderer`'s field loop; threading a save
 * function through every field's props would put it on controls that have
 * nothing to do with it.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface CommerceSaveApi {
  /** True while the panel holds unsaved stock, item-field or channel edits. */
  hasChanges: boolean;
  /** Runs the panel's own save. Never throws — failures surface in the panel. */
  save: () => Promise<void>;
  /** Throws the panel's unsaved edits away, for the save bar's Discard. */
  discard: () => void;
}

interface CommerceSaveContextValue {
  register: (api: CommerceSaveApi | null) => void;
}

const CommerceSaveContext = createContext<CommerceSaveContextValue | null>(null);

/** Used by the panel. A no-op outside the provider, so the component still
 *  renders standalone (the create modal, tests). */
export function useRegisterCommerceSave(): (api: CommerceSaveApi | null) => void {
  const ctx = useContext(CommerceSaveContext);
  return ctx?.register ?? NOOP;
}
const NOOP = () => undefined;

/**
 * Provides the registry AND reports what is registered.
 *
 * ── Why the functions live in a REF and only the flag is state ──────────────
 * The first cut kept the whole api in state and compared identities before
 * setting it. That looked careful and was a render loop: the editor builds the
 * panel's `t` bag inline, so it is a new object every render; the panel's
 * `save` closes over `t`, so it is a new function every render; the effect that
 * registers depends on `save`, so it runs every render; and the identity
 * compare could therefore never match. Each registration set state, which
 * re-rendered the editor, which built a new `t` — until React gave up and the
 * editor dropped into its error boundary. Opening any product did it.
 *
 * A ref for the functions and a BOOLEAN for the flag removes the cycle by
 * construction: `setHasChanges(false)` when it is already false is a no-op in
 * React, so a re-registration that changes nothing observable renders nothing.
 * There is no identity to compare and nothing to get wrong later.
 *
 * Reading the functions through a ref is safe here because they are only ever
 * called from an event handler (the save bar's buttons), never during render.
 */
export function useCommerceSaveRegistry() {
  const apiRef = useRef<CommerceSaveApi | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const register = useCallback((next: CommerceSaveApi | null) => {
    apiRef.current = next;
    setHasChanges(next?.hasChanges === true);
  }, []);

  const value = useMemo(() => ({ register }), [register]);

  // Stable identities: the save bar's props must not change every render
  // either, and reading through the ref keeps these two functions constant for
  // the lifetime of the editor.
  const save = useCallback(async () => {
    await apiRef.current?.save();
  }, []);
  const discard = useCallback(() => {
    apiRef.current?.discard();
  }, []);

  return {
    /** Wrap the editor subtree in this. */
    Provider: CommerceSaveContext.Provider,
    value,
    hasChanges,
    save,
    discard,
  };
}

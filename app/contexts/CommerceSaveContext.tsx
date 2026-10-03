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
  /**
   * True while this panel's own writes are in flight.
   *
   * The bar has to show it: a stock save is several sequential calls to
   * Shopify and can take seconds, and for that whole time the bar looked
   * exactly as it had before the click — the merchant's question was whether
   * anything was happening at all. It also disables the buttons, which is the
   * same double-submit guard the content and sub-resource saves already have
   * (the panel's own `savingRef` refuses the second write, but it refuses it
   * silently, which reads as a click that did nothing).
   */
  saving: boolean;
  /** Runs the panel's own save. Never throws — failures surface in the panel. */
  save: () => Promise<void>;
  /** Throws the panel's unsaved edits away, for the save bar's Discard. */
  discard: () => void;
}

interface CommerceSaveContextValue {
  /** `key` names the registrant: several writers (the stock panel, the per-language media drafts) share the one save bar. */
  register: (api: CommerceSaveApi | null, key: string) => void;
  /**
   * Bumped by the editor's own reload buttons.
   *
   * The panel used to carry a Reload of its own, which made three of them on
   * one screen — one over the item list, one in the language bar, one here.
   * The panel still has to re-read (it loads live and the editor's cache
   * refresh does not touch it), so the signal travels DOWN instead: the
   * editor bumps this, the panel watches it.
   */
  reloadNonce: number;
}

const CommerceSaveContext = createContext<CommerceSaveContextValue | null>(null);

/** Used by a writer behind the save bar. A no-op outside the provider, so the
 *  component still renders standalone (the create modal, tests). The returned
 *  function is stable for a given key (effects depend on it). `key` defaults to
 *  the stock panel's slot; a second writer passes its own, or it would replace
 *  the first one's registration. */
export function useRegisterCommerceSave(key: string = DEFAULT_KEY): (api: CommerceSaveApi | null) => void {
  const register = useContext(CommerceSaveContext)?.register;
  return useMemo(() => (register ? (api: CommerceSaveApi | null) => register(api, key) : NOOP), [register, key]);
}
const DEFAULT_KEY = "commerce";

/** Changes whenever the editor's reload ran. `0` outside the provider. */
export function useCommerceReloadNonce(): number {
  return useContext(CommerceSaveContext)?.reloadNonce ?? 0;
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
  // One slot per registrant: the stock panel and the media drafts both drive
  // the ONE save bar, and a single slot would let the second one replace the
  // first (its unsaved stock edits silently dropped from Save and Discard).
  const apisRef = useRef<Map<string, CommerceSaveApi>>(new Map());
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const register = useCallback((next: CommerceSaveApi | null, key: string) => {
    if (next) apisRef.current.set(key, next);
    else apisRef.current.delete(key);
    // Booleans for the same reason `hasChanges` is one: setting a flag to the
    // value it already holds renders nothing, so a re-registration that
    // changes nothing observable cannot start the loop this file documents.
    const all = [...apisRef.current.values()];
    setHasChanges(all.some((a) => a.hasChanges === true));
    setSaving(all.some((a) => a.saving === true));
  }, []);

  const value = useMemo(() => ({ register, reloadNonce }), [register, reloadNonce]);

  /** Called from the editor's reload handler. */
  const requestReload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Stable identities: the save bar's props must not change every render
  // either, and reading through the ref keeps these two functions constant for
  // the lifetime of the editor.
  const save = useCallback(async () => {
    // Every registrant's own save; each never throws and reports in its own place.
    await Promise.all([...apisRef.current.values()].map((a) => a.save()));
  }, []);
  const discard = useCallback(() => {
    for (const a of apisRef.current.values()) a.discard();
  }, []);

  return {
    /** Wrap the editor subtree in this. */
    Provider: CommerceSaveContext.Provider,
    value,
    hasChanges,
    saving,
    save,
    discard,
    requestReload,
  };
}

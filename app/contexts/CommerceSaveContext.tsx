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

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface CommerceSaveApi {
  /** True while the panel holds unsaved stock, item-field or channel edits. */
  hasChanges: boolean;
  /** Runs the panel's own save. Never throws — failures surface in the panel. */
  save: () => Promise<void>;
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
 * Returns the current api as state rather than a ref: the save bar's `hasChanges`
 * has to RE-RENDER when the panel becomes dirty, which a ref cannot do.
 */
export function useCommerceSaveRegistry() {
  const [api, setApi] = useState<CommerceSaveApi | null>(null);

  const register = useCallback((next: CommerceSaveApi | null) => {
    // Compared field by field: the panel re-registers on every keystroke (its
    // `hasChanges` is derived), and storing a fresh object each time would
    // re-render the whole editor per character.
    setApi((prev) => {
      if (prev === next) return prev;
      if (prev && next && prev.hasChanges === next.hasChanges && prev.save === next.save) return prev;
      return next;
    });
  }, []);

  const value = useMemo(() => ({ register }), [register]);

  return {
    /** Wrap the editor subtree in this. */
    Provider: CommerceSaveContext.Provider,
    value,
    hasChanges: api?.hasChanges === true,
    save: api?.save,
  };
}

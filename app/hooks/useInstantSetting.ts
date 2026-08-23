/**
 * A shop setting that saves the MOMENT it is changed.
 *
 * That is the rule for every switch and every discrete choice in Settings: a
 * toggle is not a draft. It shows a state, and a state that is only true after
 * a second click somewhere else is a state the merchant has to remember they
 * have not committed yet — which is exactly the "did that save?" question the
 * save bar was meant to answer for TEXT. Free text keeps its Save button;
 * anything with two or a handful of positions saves itself.
 *
 * The three rules that make an instant save honest, and each one exists
 * because the naive version is a lie on screen:
 *
 *  - **Optimistic, then REVERTED on refusal.** Several of these switches are
 *    plan-gated and the server answers 403. A switch left in the position the
 *    merchant clicked, over a value the server never stored, is worse than no
 *    feedback at all — it will still be sitting there on the next page load
 *    saying the opposite of the truth.
 *  - **Its OWN fetcher.** Sharing the page's fetcher would make a toggle's
 *    answer look like the answer to the card's Save button: the settings route
 *    clears `hasChanges` on any `success`, so saving a switch would hide the
 *    save bar over a merchant's unsaved text.
 *  - **It follows the stored value again once it is idle.** A revalidation
 *    after some other save must not be overwritten by a stale local state, and
 *    a value changed in another tab should win.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, type FetcherWithComponents } from "react-router";

export type InstantSettingResponse = {
  success?: boolean;
  error?: string;
  actionType?: string;
};

export interface UseInstantSettingOptions<T> {
  /** The value as the loader last reported it. */
  stored: T;
  /**
   * Fire the request. Given the new value and this setting's own fetcher, so a
   * caller can post a form field, a JSON body or a whole neighbouring group —
   * the shapes differ per route and pretending otherwise would mean one route
   * having to accept a payload it does not.
   */
  submit: (value: T, fetcher: FetcherWithComponents<InstantSettingResponse>) => void;
  /** Told when the server refused, so the caller can say so in its own voice.
   *  The value has already been put back by then. */
  onError?: (error?: string) => void;
  /** Told when the server accepted. For the one setting that has to act on it:
   *  changing the app's language only shows once the page is re-rendered. */
  onSaved?: (value: T) => void;
}

export interface InstantSetting<T> {
  value: T;
  set: (next: T) => void;
  saving: boolean;
}

export function useInstantSetting<T>({
  stored,
  submit,
  onError,
  onSaved,
}: UseInstantSettingOptions<T>): InstantSetting<T> {
  const fetcher = useFetcher<InstantSettingResponse>();
  const [value, setValue] = useState<T>(stored);
  /** What to go back to if the server refuses. */
  const previous = useRef<T>(stored);
  /** Our own submission is in flight or its answer is unread. Without this the
   *  effect below would consume a stale answer from before this component
   *  existed, and revert a switch nobody had touched. */
  const awaiting = useRef(false);
  /**
   * The router has actually PICKED UP our submission.
   *
   * Between `set()` and the router flipping the fetcher out of "idle" there is
   * at least one render where the state is still idle and no answer exists —
   * resolving there would revert every switch the moment it was clicked.
   */
  const started = useRef(false);
  const idle = fetcher.state === "idle";

  // Follow the loader again whenever nothing of ours is in flight.
  useEffect(() => {
    if (!awaiting.current) {
      setValue(stored);
      previous.current = stored;
    }
  }, [stored]);

  useEffect(() => {
    if (!awaiting.current) return;
    if (!idle) {
      started.current = true;
      return;
    }
    if (!started.current) return;
    awaiting.current = false;
    started.current = false;
    /**
     * Idle again with NO answer: a redirect (a re-authentication), an HTML
     * error page, a dropped connection. We do not know that anything was
     * stored, so the switch goes back — an unresolvable outcome must not leave
     * the control asserting a value, nor leave `awaiting` stuck, which would
     * silence this setting's resync for the rest of the page's life.
     */
    if (!fetcher.data) {
      setValue(previous.current);
      onError?.(undefined);
      return;
    }
    if (fetcher.data.success === false) {
      setValue(previous.current);
      onError?.(fetcher.data.error);
    } else {
      onSaved?.(value);
    }
    // `onError` / `onSaved` are typically inline arrows; depending on them
    // would re-run this on every render of the host and consume the answer
    // twice. `value` likewise — it is read at answer time on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle, fetcher.state, fetcher.data]);

  const set = useCallback(
    (next: T) => {
      // The revert target is the last CONFIRMED value, so a second click while
      // the first answer is still out does not make the optimistic value the
      // thing we fall back to — a refusal would then restore a state that was
      // never stored anywhere.
      if (!awaiting.current) previous.current = value;
      setValue(next);
      awaiting.current = true;
      submit(next, fetcher);
    },
    [value, submit, fetcher],
  );

  return { value, set, saving: !idle };
}

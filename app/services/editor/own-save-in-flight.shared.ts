/**
 * An AI or copy button's OWN save, while it is on its way to Shopify.
 *
 * The owner's rule (2026-10-02): those buttons save their field at once, and
 * plain typing stays a draft for the Save button. The save bar is the one
 * place that says "this screen holds something unsaved", so a field whose
 * value is already being written by such a save must not light it: the
 * merchant pressed "Übernehmen", not "make this a draft".
 *
 * Before this, the change detection compared the field against a baseline
 * that only moves once the RESPONSE lands. A primary product save is not a
 * quick call — the product write, the shop-locale lookup and the purge or the
 * re-translation hand-off all run before the answer comes back — so the bar
 * appeared on every accept and stood there with its spinner for the whole
 * save, which reads as exactly what the merchant reported: "it did not save,
 * the save bar is still there".
 *
 * A field is covered only while its value is EXACTLY what the in-flight save
 * sent, in the view it was sent from (item, locale, market). A keystroke on
 * top of it is a draft again; a failed save drops the entry and the field
 * reads dirty against its unchanged baseline, so the text can be saved again.
 *
 * Pure and import-free: unit-tested, and read by the change detection.
 */

export interface OwnSaveInFlight {
  itemId: string;
  locale: string;
  /** The market the save was scoped to ("" = global). */
  marketId: string;
  /** Field key → the value the save SENT. */
  values: Record<string, string>;
  /** Image index → the alt text the save SENT. */
  altValues?: Record<number, string>;
  /** Identifies the request this entry belongs to (the editor uses the
   *  partial-save object that travels with it), so its answer settles it. */
  token?: unknown;
}

/** Drop the entry of the request whose answer just landed (success or not). */
export function settleOwnSave(
  entries: readonly OwnSaveInFlight[],
  token: unknown,
): OwnSaveInFlight[] {
  if (token == null) return entries as OwnSaveInFlight[];
  const next = entries.filter((entry) => entry.token !== token);
  return next.length === entries.length ? (entries as OwnSaveInFlight[]) : next;
}

export interface OwnSaveView {
  itemId: string | null | undefined;
  locale: string;
  marketId: string;
}

function inView(entry: OwnSaveInFlight, view: OwnSaveView): boolean {
  return (
    !!view.itemId &&
    entry.itemId === view.itemId &&
    entry.locale === view.locale &&
    (entry.marketId ?? "") === (view.marketId ?? "")
  );
}

/** Is this field's current value the one an in-flight own save is writing? */
export function isFieldCoveredByOwnSave(
  entries: readonly OwnSaveInFlight[],
  view: OwnSaveView,
  key: string,
  value: string,
): boolean {
  return entries.some(
    (entry) => inView(entry, view) && Object.prototype.hasOwnProperty.call(entry.values, key) && entry.values[key] === value,
  );
}

/** The same question for an image's alt text. */
export function isAltCoveredByOwnSave(
  entries: readonly OwnSaveInFlight[],
  view: OwnSaveView,
  index: number,
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  return entries.some(
    (entry) => inView(entry, view) && entry.altValues !== undefined && entry.altValues[index] === value,
  );
}

/**
 * A view switch (item, language, market) while an own save is in flight is
 * REFUSED, never queued: the cover above keeps such a save out of
 * `hasChanges`, so no save bar shows and no confirmation could ask, and a
 * switch that waited for the answer kept producing ordering bugs (an older
 * switch overriding a newer one, a draft typed during the wait never asked
 * about). The editor shows a short "still saving" message instead; the
 * merchant switches again once the answer has landed.
 */
export function hasOwnSaveInFlight(entries: readonly OwnSaveInFlight[]): boolean {
  return entries.length > 0;
}

/**
 * The idle backstop: the fetcher is idle with nothing queued, so no own save
 * is on its way any more — except the one submitted in this very effect flush
 * (`justSubmittedToken`, the in-flight partial while the submit has not yet
 * moved the fetcher state), whose entry must survive or its field would read
 * as a draft for the whole round trip.
 */
export function backstopOwnSaves(
  entries: OwnSaveInFlight[],
  justSubmittedToken: unknown,
): OwnSaveInFlight[] {
  if (entries.length === 0) return entries;
  if (justSubmittedToken == null) return [];
  const kept = entries.filter((entry) => entry.token === justSubmittedToken);
  return kept.length === entries.length ? entries : kept;
}

/** A ref-shaped slot (React's MutableRefObject, without importing React). */
interface Slot<T> {
  current: T;
}

/**
 * A save whose `submit` THREW (anything but an AbortError) never left: no
 * answer will ever settle what was staged for it. Settle it here, or the
 * own-save entry (and with it the view-switch refusal), the in-flight slots
 * and the pending flag stick for good. The ONE implementation behind both
 * submit sites -- the direct one (`safeSubmit`, useEditorAutoSave) and the
 * queued-save drain (useUnifiedContentEditor) -- so the two cannot come to
 * clean up different things.
 *
 * A slot is cleared only while it still holds THIS request's value, so a
 * newer request's state is never wiped by an older failure.
 */
export function settleUnsentSave(args: {
  partial: unknown;
  successToast: unknown;
  setOwnSavesInFlight?: (update: (prev: OwnSaveInFlight[]) => OwnSaveInFlight[]) => void;
  inFlightPartialRef: Slot<unknown>;
  inFlightToastRef: Slot<unknown>;
  inFlightScopeRef?: Slot<unknown>;
  isSavePendingRef?: Slot<boolean>;
}): void {
  const { partial, successToast } = args;
  if (partial != null && args.setOwnSavesInFlight) {
    args.setOwnSavesInFlight((prev) => settleOwnSave(prev, partial));
  }
  if (args.inFlightPartialRef.current === partial) args.inFlightPartialRef.current = null;
  if (args.inFlightToastRef.current === successToast) args.inFlightToastRef.current = null;
  if (args.inFlightScopeRef) args.inFlightScopeRef.current = null;
  if (args.isSavePendingRef) args.isSavePendingRef.current = false;
}

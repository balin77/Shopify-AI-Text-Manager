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

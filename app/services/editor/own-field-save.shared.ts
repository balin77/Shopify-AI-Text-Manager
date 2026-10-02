/**
 * "An AI or copy button saves its OWN field immediately, and only it."
 *
 * The owner's rule (2026-10-02): the ✨/🎨/keyword suggestion's Accept, the
 * foreign 📋 copy, the single-language 🌍 translate and the alt-text AI actions
 * write straight away — while plain typing stays a draft for the Save button.
 * The danger in that is a button whose save CARRIES the merchant's other
 * unsaved edits: an autosave they never asked for, and on the primary locale
 * one that would purge (or re-translate) the translations of fields they were
 * only half-way through. So every such save is built here, from exactly the
 * field / alt indices the button produced, and nothing else.
 *
 * The second half of the rule lives here too: a button that takes an UNSAVED
 * primary value as its SOURCE (copy-to-all, translate-to-all) is refused until
 * that value is saved, because the later primary Save would purge what the
 * button had just written into every language.
 *
 * Pure and import-free: unit-tested, and shared by the field and alt hooks.
 */

export interface OwnSaveFormInput {
  itemId: string;
  locale: string;
  primaryLocale: string;
  /** The market of the view ("" = global). Sent for a FOREIGN save only — the
   *  primary locale is always global. */
  marketId: string;
  /** Field key → value. Only these fields go into the form. */
  fields?: Record<string, string>;
  /** Image index → alt text. Only these indices go into the form. */
  altTexts?: Record<number, string>;
  /** Primary only: the fields the merchant's change made stale (subset of `fields`). */
  changedFields?: readonly string[];
  /** Primary only: the merchandising attributes among them. */
  changedAttributeFields?: readonly string[];
  /** Primary only: the alt indices whose primary text changed (subset of `altTexts`). */
  changedAltTextIndices?: readonly number[];
  /** ShopPolicy needs its type on a primary write. */
  policyType?: string;
}

/** The `updateContent` form for a save that carries ONE button's result. */
export function buildOwnSaveForm(input: OwnSaveFormInput): Record<string, string> {
  const isPrimary = input.locale === input.primaryLocale;
  const form: Record<string, string> = {
    action: "updateContent",
    itemId: input.itemId,
    locale: input.locale,
    primaryLocale: input.primaryLocale,
  };
  if (!isPrimary && input.marketId) form.marketId = input.marketId;
  if (input.policyType) form.policyType = input.policyType;

  const fields = input.fields ?? {};
  for (const [key, value] of Object.entries(fields)) form[key] = value;

  const alts = input.altTexts ?? {};
  if (Object.keys(alts).length > 0) form.imageAltTexts = JSON.stringify(alts);

  if (isPrimary) {
    const changed = (input.changedFields ?? []).filter((k) => k in fields);
    if (changed.length > 0) form.changedFields = JSON.stringify(changed);
    const attrs = (input.changedAttributeFields ?? []).filter((k) => changed.includes(k));
    if (attrs.length > 0) form.changedAttributeFields = JSON.stringify(attrs);
    const altChanged = (input.changedAltTextIndices ?? []).filter((i) => alts[i] !== undefined);
    if (altChanged.length > 0) form.changedAltTextIndices = JSON.stringify(altChanged);
  }
  return form;
}

/**
 * The alt-text baseline after a PARTIAL save: only the indices that save
 * carried take the new value; every other index keeps the baseline it had, so
 * an alt the merchant typed and has not saved stays dirty. `carried === null`
 * is a full save (everything takes the new baseline).
 */
export function restrictAltBaseline(
  update: (prev: Record<number, string>) => Record<number, string>,
  carried: readonly number[] | null,
): (prev: Record<number, string>) => Record<number, string> {
  if (carried === null) return update;
  return (prev) => {
    const full = update(prev);
    const out = { ...prev };
    for (const i of carried) {
      if (i in full) out[i] = full[i];
      else delete out[i];
    }
    return out;
  };
}

/**
 * Is the PRIMARY value a button would take as its source still unsaved?
 * Only ever true on the primary locale. `baseline === undefined` means the
 * field has no baseline yet (nothing loaded), which is not a draft.
 */
export function isUnsavedPrimarySource(input: {
  currentLanguage: string;
  primaryLocale: string;
  value: string | undefined;
  baseline: string | undefined;
}): boolean {
  if (input.currentLanguage !== input.primaryLocale) return false;
  if (input.baseline === undefined) return false;
  return (input.value ?? "") !== input.baseline;
}

/**
 * The same question for an ALT text: the editor tracks a primary alt as a draft
 * when `imageAltTexts[i]` differs from `originalAltTexts[i]` (both may be absent
 * — an untouched image shows the stored alt and holds no entry at all).
 */
export function isUnsavedPrimaryAlt(input: {
  currentLanguage: string;
  primaryLocale: string;
  value: string | undefined;
  original: string | undefined;
}): boolean {
  if (input.currentLanguage !== input.primaryLocale) return false;
  return input.value !== input.original;
}

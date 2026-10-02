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
 * The alt texts a save response is read against: the live field map, with the
 * indices a PARTIAL save carried replaced by the values it actually SENT. A
 * merchant may keep typing in that field while the save is in flight; the
 * typed text was not sent and must stay a draft. `altValues` absent (a full
 * save, or an older caller) reads the live map as before.
 */
export function altValuesForSaveResponse(
  live: Record<number, string>,
  partial: { altValues?: Record<number, string> } | null | undefined,
): Record<number, string> {
  if (!partial?.altValues) return live;
  return { ...live, ...partial.altValues };
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

/**
 * The whole-item "Translate all" (primary locale) takes the SAVED primary
 * values as its source and writes every language; a primary field or alt text
 * that is still an unsaved draft would then be saved later, and that Save
 * purges (or re-translates) exactly what the button just wrote. So the button
 * waits, like the per-field translate-to-all, until every primary draft the
 * run would cover is saved. `fieldKeys` are the TRANSLATABLE fields only — a
 * merchandising attribute is not translated and its save purges nothing.
 * Always false on a foreign locale.
 */
export function hasUnsavedPrimaryTranslateSource(input: {
  currentLanguage: string;
  primaryLocale: string;
  fieldKeys: readonly string[];
  values: Record<string, string | undefined>;
  baseline: Record<string, string | undefined>;
  alts: Record<number, string>;
  originalAlts: Record<number, string>;
}): boolean {
  if (input.currentLanguage !== input.primaryLocale) return false;
  for (const key of input.fieldKeys) {
    if (
      isUnsavedPrimarySource({
        currentLanguage: input.currentLanguage,
        primaryLocale: input.primaryLocale,
        value: input.values[key],
        baseline: input.baseline[key],
      })
    ) {
      return true;
    }
  }
  const altKeys = new Set([...Object.keys(input.alts), ...Object.keys(input.originalAlts)]);
  for (const k of altKeys) {
    const i = Number(k);
    if (
      isUnsavedPrimaryAlt({
        currentLanguage: input.currentLanguage,
        primaryLocale: input.primaryLocale,
        value: input.alts[i],
        original: input.originalAlts[i],
      })
    ) {
      return true;
    }
  }
  return false;
}

/** What a save request was SENT under: its locale, its market and the alt
 *  texts it carried. Captured at submit time (the response arrives later, and
 *  the merchant may have switched view or kept typing in between). */
export interface SentSaveScope {
  locale: string;
  marketId: string;
  sentAlts: Record<number, string>;
}

/** Reads the alt texts a save form carried (`imageAltTexts`, a JSON object). */
export function sentAltsFromForm(raw: unknown): Record<number, string> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const i = Number(k);
      if (Number.isInteger(i) && typeof v === "string") out[i] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A foreign alt Shopify could not store because the image has no PRIMARY alt
 * (`altTextNoPrimaryIndices`): no retry can store it, so the field goes back
 * to what the language held before the edit — but only where the answer still
 * describes what is on screen. The editor's twin of the image manager's
 * `revertAltDraftsWithoutPrimary`:
 *  - the view must still be the save's locale AND market (another view's
 *    fields hold another language's text — reverting them would discard it);
 *  - an index whose text is no longer what was SENT holds a newer draft the
 *    merchant typed after Save and is left alone;
 *  - an index the save did not carry is left alone.
 * `scope === null` (unknown) reverts nothing: the draft stays, which costs a
 * save bar, never a merchant's text.
 */
export function revertAltsWithoutPrimary(args: {
  current: Readonly<Record<number, string>>;
  baseline: Readonly<Record<number, string>>;
  indices: readonly number[];
  scope: SentSaveScope | null;
  view: { locale: string; marketId: string };
}): { next: Record<number, string>; reverted: number[] } {
  const next: Record<number, string> = { ...args.current };
  const reverted: number[] = [];
  const scope = args.scope;
  if (!scope) return { next, reverted };
  if (scope.locale !== args.view.locale || (scope.marketId ?? "") !== (args.view.marketId ?? "")) {
    return { next, reverted };
  }
  for (const i of args.indices) {
    if (!(i in scope.sentAlts)) continue;
    if ((args.current[i] ?? "") !== scope.sentAlts[i]) continue;
    if (args.baseline[i] === undefined) delete next[i];
    else next[i] = args.baseline[i];
    reverted.push(i);
  }
  return { next, reverted };
}

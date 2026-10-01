/**
 * A foreign save can answer `success: true` with a warning because a CLEARED
 * field's removal was not confirmed by Shopify: the translation is still live
 * there. The server names those FIELD keys (`unconfirmedClearedFields`); the
 * page must not accept them into its saved cache / baseline, or the field reads
 * clean and empty while Shopify keeps serving the old text. Pure, client-safe.
 */

/**
 * The field keys the save response names as NOT confirmed: a cleared field whose
 * removal Shopify did not confirm (`unconfirmedClearedFields`) AND a written
 * field whose register Shopify did not echo (`unconfirmedFields`). Both are kept
 * dirty with the merchant's typed value.
 */
export function unconfirmedClearedFieldSet(data: unknown): Set<string> {
  const d = data as
    | { unconfirmedClearedFields?: unknown; unconfirmedFields?: unknown; skippedFields?: unknown }
    | null
    | undefined;
  const out = new Set<string>();
  for (const raw of [d?.unconfirmedClearedFields, d?.unconfirmedFields, d?.skippedFields]) {
    if (!Array.isArray(raw)) continue;
    for (const k of raw) if (typeof k === "string" && k.length > 0) out.add(k);
  }
  return out;
}

/**
 * The alt-text baseline after a save: `base` (what the save sent) except for
 * every index whose write FAILED, which keeps the baseline it had before. An
 * index the base already rolled back (a failed copy) is left as it is.
 * Meant for a functional `setState` updater, so a second call is idempotent.
 */
export function keepFailedAltsDirty(
  base: Record<number, string>,
  failed: readonly number[],
  typed: Record<number, string>,
): (prev: Record<number, string>) => Record<number, string> {
  return (prev) => {
    if (failed.length === 0) return base;
    const out = { ...base };
    for (const i of failed) {
      if (base[i] !== typed[i]) continue;
      if (prev[i] === undefined) delete out[i];
      else out[i] = prev[i];
    }
    return out;
  };
}

/**
 * The `onlyKeys` the save's cache overlay may touch: what the save carried
 * (`carried`, null = every field) minus the unconfirmed ones. `null` stays
 * `null` when nothing is excluded, so an ordinary save behaves exactly as before.
 */
export function unconfirmedClearedOnlyKeys(
  carried: ReadonlySet<string> | null,
  allKeys: readonly string[],
  unconfirmed: ReadonlySet<string>,
): ReadonlySet<string> | null {
  if (unconfirmed.size === 0) return carried;
  const base = carried ?? new Set(allKeys);
  return new Set([...base].filter((k) => !unconfirmed.has(k)));
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && k.length > 0) : [];
}

/**
 * The merchant-language sentence for a save that stored only part of what was
 * typed: names the FIELD LABELS (never translation keys) of the fields Shopify
 * did not confirm (`unconfirmedFields`) and of those the server refused to write
 * (`skippedFields`, a handle equal to the primary one). Empty string when the
 * response names neither.
 */
export function unconfirmedFieldsMessage(
  data: unknown,
  labelOf: (fieldKey: string) => string,
  templates: { unconfirmed: string; skipped: string },
): string {
  const d = data as { unconfirmedFields?: unknown; skippedFields?: unknown } | null | undefined;
  const names = (keys: string[]) => keys.map(labelOf).join(", ");
  const parts: string[] = [];
  const unconfirmed = stringList(d?.unconfirmedFields);
  const skipped = stringList(d?.skippedFields);
  if (unconfirmed.length > 0) parts.push(templates.unconfirmed.replace("{fields}", names(unconfirmed)));
  if (skipped.length > 0) parts.push(templates.skipped.replace("{fields}", names(skipped)));
  return parts.join(" ");
}

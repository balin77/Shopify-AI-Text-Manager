/**
 * A foreign save can answer `success: true` with a warning because a CLEARED
 * field's removal was not confirmed by Shopify: the translation is still live
 * there. The server names those FIELD keys (`unconfirmedClearedFields`); the
 * page must not accept them into its saved cache / baseline, or the field reads
 * clean and empty while Shopify keeps serving the old text. Pure, client-safe.
 */

/** The field keys the save response names as "cleared but not confirmed". */
export function unconfirmedClearedFieldSet(data: unknown): Set<string> {
  const raw = (data as { unconfirmedClearedFields?: unknown } | null | undefined)?.unconfirmedClearedFields;
  return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && k.length > 0) : []);
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

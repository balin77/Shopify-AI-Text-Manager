/**
 * The keys whose foreign-translation purge was NOT confirmed on Shopify.
 *
 * `warnings` holds resource ids (a removal on that resource was unconfirmed or
 * threw) and the markers "locales" / "local" (the locale lookup or the local
 * delete failed - no resource can be singled out, so every changed key counts).
 * Import-free: the server builds the list and the client filters its cache
 * invalidation with it.
 */
export function unconfirmedPurgeKeys(
  warnings: readonly string[],
  keysByResource: ReadonlyMap<string, readonly string[]>,
  allChangedKeys: readonly string[],
): string[] {
  if (warnings.includes("locales") || warnings.includes("local")) return [...allChangedKeys];
  const out = new Set<string>();
  for (const w of warnings) for (const key of keysByResource.get(w) ?? []) out.add(key);
  return [...out];
}

/** Changed keys the client may drop from its translation cache. */
export function keysSafeToInvalidate(
  changedKeys: ReadonlySet<string>,
  unconfirmedKeys: readonly string[] | undefined,
): Set<string> {
  if (!unconfirmedKeys || unconfirmedKeys.length === 0) return new Set(changedKeys);
  const skip = new Set(unconfirmedKeys);
  return new Set([...changedKeys].filter((k) => !skip.has(k)));
}

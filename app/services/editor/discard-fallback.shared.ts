/**
 * Discard returns the editor to its BASELINE — and a field whose baseline is
 * an INHERITED value (a market view showing the global translation, a foreign
 * view showing the primary fallback) has to read as inherited again, not as a
 * value of its own: typing into such a field drops it from `fallbackFields`,
 * and Discard used to put the text back without the flag.
 *
 * The load captured which fields were inherited and with what value. A field
 * is inherited after Discard exactly when it was inherited at load AND its
 * baseline still holds that loaded value — a save since then (which moved the
 * baseline to a value of its own) makes it a real value, not a fallback.
 *
 * Pure and import-free.
 */
export interface LoadedFallbackSnapshot {
  fields: ReadonlySet<string>;
  values: Record<string, string>;
}

export function fallbackFieldsAfterDiscard(
  snapshot: LoadedFallbackSnapshot | null,
  baseline: Record<string, string>,
): Set<string> {
  const out = new Set<string>();
  if (!snapshot) return out;
  for (const key of snapshot.fields) {
    if (baseline[key] !== undefined && baseline[key] === snapshot.values[key]) out.add(key);
  }
  return out;
}

/**
 * The plan gate answers 403 `{ error: "gated" }` (planGateRefusal). A client
 * that shows `data.error` verbatim prints the raw code; this maps it to the
 * localized upgrade sentence and leaves every other error text untouched.
 * Import-free so components, hooks and tests can all reach it.
 */
export function gatedAwareError(
  error: string | null | undefined,
  upgradeMessage: string | null | undefined,
  fallback: string,
): string {
  if (error === "gated") return upgradeMessage || "Upgrade required";
  return error || fallback;
}

/** "{count} items skipped" sentence, or null when nothing was skipped. */
export function skippedGatedNote(
  skipped: ReadonlyArray<unknown> | null | undefined,
  template: string | null | undefined,
): string | null {
  const n = skipped?.length ?? 0;
  if (n <= 0 || !template) return null;
  return template.replace("{count}", String(n));
}

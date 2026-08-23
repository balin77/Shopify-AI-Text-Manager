/**
 * "X of Y languages succeeded" — ONE rule, client-safe and pure.
 *
 * Three call sites computed this arithmetic by hand and all three got it
 * wrong in the same way: `total = Object.keys(translations).length +
 * failedLocales.length`. `translateAllContent` SEEDS its translation map with
 * an empty entry per TARGET locale before the first AI call
 * ([shopify-content.service.ts](../../../src/services/shopify-content.service.ts)),
 * so a failed locale is present in BOTH operands and gets counted twice: a
 * three-language run in which every language failed reported
 * "0/6 languages succeeded".
 *
 * The map arrives in two shapes — `Record<locale, Record<field, value>>` from
 * translate-all, `Record<locale, value>` from the single-field path — so the
 * emptiness test has to accept both. It is deliberately a UNION and a
 * SUBTRACTION rather than a sum: a locale is one language whether it appears
 * in one list, the other, or both.
 */

/** A locale entry that carries nothing is not a success — it is the seeded
 *  placeholder, whatever the caller's map shape. */
function carriesValue(entry: unknown): boolean {
  if (typeof entry === "string") return entry.trim().length > 0;
  if (entry && typeof entry === "object") {
    return Object.values(entry as Record<string, unknown>).some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
  }
  return false;
}

export interface PartialLocaleCounts {
  /** Locales that really received something and are not on the failed list. */
  succeeded: number;
  /** Every locale the run touched, counted once. */
  total: number;
}

export function partialLocaleCounts(
  translations: Record<string, unknown> | null | undefined,
  failedLocales: readonly string[] | null | undefined,
): PartialLocaleCounts {
  const map = translations && typeof translations === "object" ? translations : {};
  const failed = new Set(
    (Array.isArray(failedLocales) ? failedLocales : []).filter(
      (l): l is string => typeof l === "string" && l.length > 0,
    ),
  );

  const locales = Object.keys(map);
  const succeeded = locales.filter((l) => !failed.has(l) && carriesValue(map[l])).length;

  // Union: a failed locale usually IS a key of the seeded map, and a locale
  // that only appears on the failed list still belongs in the denominator.
  const total = new Set([...locales, ...failed]).size;

  return { succeeded, total };
}

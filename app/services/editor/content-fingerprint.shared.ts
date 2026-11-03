/**
 * "Did what this view shows move?" -- by CONTENT, not by size.
 *
 * The editor re-resolves its fields when the loader hands it new data. It used
 * to notice that through the SUM OF THE TRANSLATION LENGTHS, so a value that
 * became another value of the same length ("noir" -> "bleu": a save of this
 * session, an AI run, an external edit) never re-resolved: the fields and the
 * comparison baseline stayed on the old text, and retyping it was "unchanged"
 * -- left out of the save, which still answered success.
 *
 * Pure and import-free. Two independent 32-bit hashes plus the length, so an
 * accidental collision between two different states is ~2^-64, not 2^-32.
 */

/** A stable text fingerprint of an ordered list of strings. */
export function fingerprintStrings(parts: Iterable<string>): string {
  let a = 0x811c9dc5; // FNV-1a
  let b = 5381; // djb2
  let length = 0;
  for (const part of parts) {
    // A separator no text part contains on its own, so ["ab","c"] != ["a","bc"].
    const text = part + "\u0000";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a ^= code;
      a = Math.imul(a, 0x01000193);
      b = (Math.imul(b, 33) + code) | 0;
    }
    length += text.length;
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${length.toString(36)}`;
}

interface FingerprintTranslation {
  key?: string;
  locale?: string;
  marketId?: string | null;
  value?: string | null;
}

/**
 * The fingerprint of what one VIEW (an item in one language) resolves from:
 * the item's translations of THAT language, the market overrides of it, and the
 * primary values of the editor's fields (the foreign chain falls back to them).
 * Another language's translations are left out on purpose -- they cannot
 * change what this view shows, and re-resolving for them would only churn.
 */
export function viewContentFingerprint(input: {
  locale: string;
  translations: ReadonlyArray<FingerprintTranslation> | undefined;
  marketTranslations: Record<string, Record<string, Record<string, string>>> | undefined;
  primaryValues: ReadonlyArray<string>;
}): string {
  const parts: string[] = [];
  for (const value of input.primaryValues) parts.push(value);
  parts.push("\u0001");
  for (const t of input.translations ?? []) {
    if (t.locale !== input.locale) continue;
    parts.push(t.key ?? "", t.marketId ?? "", t.value ?? "");
  }
  parts.push("\u0002");
  for (const [marketId, byKey] of Object.entries(input.marketTranslations ?? {})) {
    for (const [key, byLocale] of Object.entries(byKey ?? {})) {
      const value = byLocale?.[input.locale];
      if (value !== undefined) parts.push(marketId, key, String(value));
    }
  }
  return fingerprintStrings(parts);
}

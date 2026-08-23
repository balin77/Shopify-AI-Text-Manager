/**
 * "The language I am working in" — remembered across navigation.
 *
 * The content editor unmounts on every main-nav navigation, and its
 * `currentLanguage` went back to the primary locale each time. For a shop that
 * translates, that is the whole editing context: the merchant working through
 * their catalogue in French landed back in German after one detour into the SEO
 * section, and a pending AI suggestion generated on the French tab was
 * invisible until they clicked their way back (it is stored per locale — see
 * [useAISuggestionStore](../hooks/useAISuggestionStore.ts)).
 *
 * Deliberately APP-WIDE, not per content type: "I am working in French" is one
 * answer, and remembering it per tab would open Collections in German while
 * Products is French. The item id next door
 * ([last-selected-item.ts](./last-selected-item.ts)) is the opposite case and
 * keyed per type for the same reason — there is no one item that spans them.
 *
 * Two rules copied verbatim from that module, both load-bearing:
 * reads are SSR-safe and a failure quietly answers null (an embedded app must
 * work with third-party storage blocked — Chrome Incognito), and writes are
 * USER-ACTION-driven only. A restore effect that writes back what it just read
 * turns any transient state into the new stored answer.
 *
 * A stored locale is never trusted on its own: the caller checks it against the
 * shop's published locales, because a language can be unpublished between two
 * sessions and reopening the editor in a locale the shop no longer serves would
 * offer to write translations nobody can see.
 */

const KEY = "contentpilot_last_content_locale";

export function readLastContentLocale(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeLastContentLocale(locale: string): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {}
}

/**
 * Which language the editor should open in — the whole rule, in one pure
 * function so it can be read and tested without mounting the editor.
 *
 * Returns `null` for "keep the primary locale", which is also the answer for
 * every doubtful case: a deep link that already named a language, an empty
 * locale list (a FAILED lookup, not a single-language shop), a language the
 * shop no longer publishes, and the primary locale itself.
 */
export function pickRestoredLocale(input: {
  /** `?locale=` from the URL, already applied by the caller when present. */
  initialLocale?: string;
  stored: string | null;
  primaryLocale: string;
  shopLocales: Array<{ locale: string; primary?: boolean }>;
}): string | null {
  const { initialLocale, stored, primaryLocale, shopLocales } = input;
  // A deep link names the language explicitly; it outranks what was stored.
  if (initialLocale) return null;
  if (!stored || stored === primaryLocale) return null;
  if (!shopLocales.some((l) => l.locale === stored && !l.primary)) return null;
  return stored;
}

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
 * A stored locale is never trusted on its own: it is checked against the shop's
 * locales, because a language can be removed or unpublished between two
 * sessions, and reopening the editor in one the storefront no longer serves
 * would offer to write translations nobody can see.
 */

const KEY_PREFIX = "contentpilot_last_content_locale_";

/**
 * The key is SHOP-scoped. An embedded app serves every shop from one origin, so
 * one localStorage bucket holds them all — and unlike an item id, which can
 * only ever match the shop it came from, `fr` matches everywhere: an agency
 * that runs two shops would carry the language of one into the other. The shop
 * comes from Shopify's own `?shop=` param, which rides on every embedded
 * request; without it the key falls back to a shared bucket rather than
 * refusing to remember anything, since a lone shop is the common case and the
 * cost of being wrong is one wrong language tab.
 */
function keyForCurrentShop(): string {
  try {
    const shop = new URLSearchParams(window.location.search).get("shop");
    return `${KEY_PREFIX}${shop || "unknown"}`;
  } catch {
    return `${KEY_PREFIX}unknown`;
  }
}

export function readLastContentLocale(): string | null {
  try {
    return localStorage.getItem(keyForCurrentShop());
  } catch {
    return null;
  }
}

export function writeLastContentLocale(locale: string): void {
  try {
    localStorage.setItem(keyForCurrentShop(), locale);
  } catch {}
}

/**
 * Which language the editor should open in — the whole rule, in one pure
 * function so it can be read and tested without mounting the editor.
 *
 * Returns `null` for "keep the primary locale", which is also the answer for
 * every doubtful case: a deep link that already named a language, an empty
 * locale list (a FAILED lookup, not a single-language shop), a language the
 * shop no longer has or no longer publishes, and the primary locale itself.
 *
 * `published` REFUSES where it is present and false; where the flag is missing
 * entirely it decides nothing, because an absent key is not a negative answer
 * (the trap CLAUDE.md names for `translatableContent` and `attributesSyncedAt`
 * alike). Everything the loader factory delivers carries it.
 */
export function pickRestoredLocale(input: {
  /** `?contentLocale=` from the URL. */
  initialLocale?: string;
  stored: string | null;
  primaryLocale: string;
  shopLocales: ShopLocaleLike[];
}): string | null {
  const { initialLocale, stored, primaryLocale, shopLocales } = input;
  // A deep link the editor ACTUALLY OPENS IN outranks what was stored — but
  // only that one, and it is the SAME function that decides both, so the two
  // cannot drift apart. A stale link naming a language this shop no longer has
  // is not applied by the editor either, and stepping aside for it would cost
  // the merchant their working language over an instruction nobody followed.
  if (resolveInitialLocale(initialLocale, primaryLocale, shopLocales) !== primaryLocale) return null;
  return usableForeignLocale(stored, primaryLocale, shopLocales);
}

/**
 * The language a `?contentLocale=` deep link opens the editor in — the editor's
 * own `useState` initializer calls this, which is what keeps the rule above
 * honest about what the link will really do.
 *
 * Answers the primary locale for everything it will not honour: no link, the
 * primary locale itself, and a code this shop does not have or no longer
 * publishes (a stale bookmark must not open an empty editor).
 */
export function resolveInitialLocale(
  initialLocale: string | undefined,
  primaryLocale: string,
  shopLocales: ShopLocaleLike[],
): string {
  return usableForeignLocale(initialLocale, primaryLocale, shopLocales) ?? primaryLocale;
}

interface ShopLocaleLike {
  locale: string;
  primary?: boolean;
  published?: boolean;
}

/** A locale this shop really serves and that is not the primary one; else null. */
function usableForeignLocale(
  locale: string | null | undefined,
  primaryLocale: string,
  shopLocales: ShopLocaleLike[],
): string | null {
  if (!locale || locale === primaryLocale) return null;
  const known = shopLocales.some((l) => l.locale === locale && !l.primary && l.published !== false);
  return known ? locale : null;
}

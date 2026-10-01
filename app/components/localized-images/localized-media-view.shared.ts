/**
 * The pure half of the per-language media UI on the product page: which of the
 * product's media carry a replacement for the language (+ market) the editor is
 * showing, and which stored entries nothing can reach any more.
 *
 * Import-light on purpose (types + the storefront's own precedence function):
 * the tile mark, the replace panel and the orphan notice all ask these two
 * questions, and a second copy of the precedence rule is exactly how the
 * editor, the snippet and the storefront asset would come to disagree.
 */
import {
  marketNumericId,
  normalizeLocale,
  resolveLocalizedMedia,
  type LocalizedMediaEntry,
} from "../../services/localized-media/localized-media.shared";

/** One product medium as `localizedMediaLoad` reports it (ProductMediaItem). */
export interface LocalizedMediaItem {
  id: string;
  kind: "image" | "video" | "external";
  url: string;
  alt: string | null;
  /** Null = the storefront key could not be derived; such a medium is listed but not replaceable. */
  key: string | null;
  poster: string;
  stamp: string;
}

/**
 * The media (by GID) a visitor in (locale, market) would see REPLACED. An
 * every-market entry counts from a specific market too (that is what the
 * storefront serves), so "inherited" and "own" are marked alike.
 * The primary locale (`locale` = "") never has one.
 */
export function replacedMediaIds(
  entries: LocalizedMediaEntry[],
  mediaIds: Iterable<string>,
  locale: string,
  marketNumeric: string,
): Set<string> {
  const out = new Set<string>();
  if (!locale) return out;
  for (const id of mediaIds) {
    if (resolveLocalizedMedia(entries, id, locale, marketNumeric)) out.add(id);
  }
  return out;
}

/**
 * An entry nothing in the editor can reach any more: its original is gone, its
 * market is not an active one, or its language is no longer on the shop.
 * Markets and languages are judged only when their lists answered (an empty
 * language list is a failed lookup, never "no languages"), so a failed lookup
 * cannot offer every entry for removal.
 */
export function findOrphanEntries(
  entries: LocalizedMediaEntry[],
  mediaIds: ReadonlySet<string>,
  markets: ReadonlyArray<{ id: string }>,
  shopLocales: ReadonlyArray<{ locale: string; primary?: boolean }>,
): LocalizedMediaEntry[] {
  const activeMarkets = new Set(markets.map((mk) => marketNumericId(mk.id)).filter((k): k is string => !!k));
  const foreign = new Set(shopLocales.filter((l) => !l.primary).map((l) => normalizeLocale(l.locale)));
  return entries.filter(
    (e) =>
      !mediaIds.has(e.m) ||
      (!!e.k && markets.length > 0 && !activeMarkets.has(e.k)) ||
      (shopLocales.length > 0 && !foreign.has(e.l)),
  );
}

/** Whether `locale` is a non-primary language of the shop (and so may carry a replacement). */
export function isForeignShopLocale(
  locale: string | undefined,
  shopLocales: ReadonlyArray<{ locale: string; primary?: boolean }>,
): boolean {
  if (!locale) return false;
  return shopLocales.some((l) => l.locale === locale && !l.primary);
}

/**
 * The editor's "deleted" marks (`deletedTranslationKeysRef`) come in two kinds,
 * and mixing them up made one language's clear reach every other language.
 *
 *  - A LAYER mark (`translationKey`, or `translationKey@@<market>`) says the
 *    translations of that key are gone in EVERY locale of that layer. A primary
 *    save sets it: the server purges the changed field's translations in all
 *    languages.
 *  - A LOCALE mark (`<layer mark>##<locale>`) says one locale's value was
 *    cleared. A foreign "clear" (one field, or "clear all") sets it.
 *
 * The foreign clears used to set the LAYER mark, so "clear all" in Italian
 * showed French empty until the clear's save answered, and a late "translate
 * all" answer for French -- which drops the marks of the fields it answered --
 * took Italian's marks with it: the next re-read put Italian's old values back
 * on screen while its removal was still on its way, and the save's answer then
 * staged them as Italian's saved values.
 *
 * Client-safe and import-free.
 */

/** Same spelling as `LOCALE_MARKET_SEP` in useUiDataLoader. */
const MARKET_SEP = "@@";
export const LOCALE_MARK_SEP = "##";

function layerMark(translationKey: string, marketId: string): string {
  return marketId ? `${translationKey}${MARKET_SEP}${marketId}` : translationKey;
}

/** The mark of ONE locale's cleared value of `translationKey` in a layer. */
export function buildLocaleDeletedKey(translationKey: string, marketId: string, locale: string): string {
  return `${layerMark(translationKey, marketId)}${LOCALE_MARK_SEP}${locale}`;
}

/** Whether `translationKey` reads as deleted in (locale, market) -- by a layer
 *  mark of that layer or by that locale's own mark. */
export function isMarkedDeleted(
  marks: ReadonlySet<string>,
  translationKey: string,
  marketId: string,
  locale: string,
): boolean {
  return marks.has(layerMark(translationKey, marketId)) || marks.has(buildLocaleDeletedKey(translationKey, marketId, locale));
}

export function isLocaleMark(mark: string): boolean {
  return mark.includes(LOCALE_MARK_SEP);
}

/** Whether `mark` is a locale mark of exactly (locale, market). */
export function isLocaleMarkOf(mark: string, locale: string, marketId: string): boolean {
  const at = mark.lastIndexOf(LOCALE_MARK_SEP);
  if (at < 0 || mark.slice(at + LOCALE_MARK_SEP.length) !== locale) return false;
  const layer = mark.slice(0, at);
  const marketAt = layer.lastIndexOf(MARKET_SEP);
  const markMarket = marketAt < 0 ? "" : layer.slice(marketAt + MARKET_SEP.length);
  return markMarket === (marketId || "");
}

/**
 * What a confirmed save leaves behind. A PRIMARY save (`locale` null) drops
 * every layer mark; a FOREIGN save drops the layer marks and the locale marks
 * of its own (locale, market). Another locale's mark stays: its own clear is
 * still on its way, and dropping it lets a re-read show the values that clear
 * is removing.
 */
export function dropMarksAfterSave(
  marks: Set<string>,
  saved: { locale: string; marketId: string } | null,
  /** A PARTIAL save: only these translation keys' locale marks go -- a clear
   *  of the same language still waiting behind it keeps the others. */
  onlyTranslationKeys?: ReadonlySet<string> | null,
): void {
  for (const mark of [...marks]) {
    if (!isLocaleMark(mark)) {
      marks.delete(mark);
      continue;
    }
    if (!saved || !isLocaleMarkOf(mark, saved.locale, saved.marketId)) continue;
    if (onlyTranslationKeys && !onlyTranslationKeys.has(translationKeyOfMark(mark))) continue;
    marks.delete(mark);
  }
}

/** Every locale mark of exactly (locale, market) goes (a discarded or
 *  abandoned clear) -- except the ones in `keep`: a save that is out or queued
 *  still carries that clear, and its answer settles the mark. */
export function dropLocaleMarks(
  marks: Set<string> | null | undefined,
  locale: string,
  marketId: string,
  keep?: ReadonlySet<string> | null,
): void {
  if (!marks) return;
  for (const mark of [...marks]) {
    if (keep?.has(mark)) continue;
    if (isLocaleMarkOf(mark, locale, marketId)) marks.delete(mark);
  }
}

function translationKeyOfMark(mark: string): string {
  const at = mark.lastIndexOf(LOCALE_MARK_SEP);
  const layer = at < 0 ? mark : mark.slice(0, at);
  const marketAt = layer.indexOf(MARKET_SEP);
  return marketAt < 0 ? layer : layer.slice(0, marketAt);
}

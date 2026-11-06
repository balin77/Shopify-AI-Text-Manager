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
 * A STAGE mark is a fourth kind (see `buildStageMark`): it exempts ONE locale
 * from a LAYER mark while a freshly staged value of that locale stands.
 *
 * Client-safe and import-free.
 */

/** Same spelling as `LOCALE_MARKET_SEP` in useUiDataLoader. */
const MARKET_SEP = "@@";
export const LOCALE_MARK_SEP = "##";

function layerMark(translationKey: string, marketId: string): string {
  return marketId ? `${translationKey}${MARKET_SEP}${marketId}` : translationKey;
}

/**
 * A PURGE mark says a primary save's purge removed the MARKET override of
 * (key, market, locale) on Shopify while the loaded item still carries it. It
 * is a third kind and none of the clearing rules touch it: a language, market
 * or discard switch (`dropLocaleMarks`) and any save's `dropMarksAfterSave`
 * leave it alone -- only its own lifecycle retires it (the re-read item no
 * longer carries the row, or a later save of that very layer writes the
 * field). It reads as deleted in exactly its (market, locale).
 */
const PURGE_PREFIX = "~purge~";

export function buildPurgeMarketKey(translationKey: string, marketId: string, locale: string): string {
  return `${PURGE_PREFIX}${buildLocaleDeletedKey(translationKey, marketId, locale)}`;
}

export function isPurgeMark(mark: string): boolean {
  return mark.startsWith(PURGE_PREFIX);
}

/**
 * A STAGE mark says: a value was just translated/copied INTO (key, market,
 * locale) while a LAYER mark of that key was standing (a primary save whose
 * purge is still on its way). The layer mark must stay -- every OTHER locale
 * still reads the purged key as empty -- but it must not blank the locale that
 * was just written, so its overlay value wins there. It lives exactly as long
 * as the layer marks it exempts from: every `dropMarksAfterSave` drops it with
 * them (a primary answer wipes the overlay of marked keys in the same step), a
 * language/market/discard switch (`dropLocaleMarks`) leaves it alone.
 * A locale mark of the same locale (a later clear) still applies.
 */
const STAGE_PREFIX = "~stage~";

export function buildStageMark(translationKey: string, marketId: string, locale: string): string {
  return `${STAGE_PREFIX}${buildLocaleDeletedKey(translationKey, marketId, locale)}`;
}

export function isStageMark(mark: string): boolean {
  return mark.startsWith(STAGE_PREFIX);
}

/** The LAYER mark a stage mark exempts a locale from (`key` or `key@@market`). */
export function layerMarkOfStage(stageMark: string): string {
  const body = stageMark.slice(STAGE_PREFIX.length);
  const at = body.lastIndexOf(LOCALE_MARK_SEP);
  return at < 0 ? body : body.slice(0, at);
}

/**
 * Wherever a LAYER mark of (key, market) is deleted, the stage marks that
 * exempted a locale from it go too: left behind they would outlive the mark
 * they belong to (and a later layer mark of the same key would be exempted for
 * a locale nobody translated into).
 */
export function dropStageMarksOfLayer(marks: Set<string>, translationKey: string, marketId: string): void {
  const layer = layerMark(translationKey, marketId);
  for (const mark of [...marks]) {
    if (isStageMark(mark) && layerMarkOfStage(mark) === layer) marks.delete(mark);
  }
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
  return (
    (marks.has(layerMark(translationKey, marketId)) &&
      !marks.has(buildStageMark(translationKey, marketId, locale))) ||
    marks.has(buildLocaleDeletedKey(translationKey, marketId, locale)) ||
    (!!marketId && marks.has(buildPurgeMarketKey(translationKey, marketId, locale)))
  );
}

export function isLocaleMark(mark: string): boolean {
  return !isPurgeMark(mark) && !isStageMark(mark) && mark.includes(LOCALE_MARK_SEP);
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
    if (isPurgeMark(mark)) continue;
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
    if (keep?.has(mark) || isPurgeMark(mark) || isStageMark(mark)) continue;
    if (isLocaleMarkOf(mark, locale, marketId)) marks.delete(mark);
  }
}

function translationKeyOfMark(mark: string): string {
  const at = mark.lastIndexOf(LOCALE_MARK_SEP);
  const layer = at < 0 ? mark : mark.slice(0, at);
  const marketAt = layer.indexOf(MARKET_SEP);
  return marketAt < 0 ? layer : layer.slice(0, marketAt);
}

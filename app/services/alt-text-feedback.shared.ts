/**
 * What an alt-text answer MEANS, read in one place (import-free: the image
 * manager and the editor hook both pull it into the client bundle, the task
 * writers into the server graph).
 *
 * The routes answer `{ success, error?, code?, failedLocales?, ... }`. A
 * `success: false`, a refusal and a partial answer used to be read as
 * "something came back" -- the image manager cleared its dirty flag before
 * the server answered and ignored every failed AI answer. These helpers turn
 * an answer into a verdict a caller can act on.
 */

/** Coded refusals of the managed-AI / key gate (api-ai-handlers/shared.ts). */
const AI_REFUSAL_CODES = new Set([
  "AI_BUDGET_EXCEEDED",
  "AI_TASTER_EXHAUSTED",
  "AI_CONSENT_REQUIRED",
  "AI_TEMPORARILY_UNAVAILABLE",
  "NO_AI_KEY",
  "INVALID_AI_KEY",
]);

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function errorText(rec: Record<string, unknown> | null): string {
  const e = rec?.error;
  return typeof e === "string" ? e : "";
}

/**
 * The answer code of a FOREIGN `saveImageAltText` that could not be stored
 * because the image has no alt text in the primary language: Shopify then
 * offers no `alt` key (and no digest) to translate, so no retry can ever store
 * it until the primary alt exists.
 */
export const ALT_NO_PRIMARY = "altTextNoPrimary";

export type AltSaveVerdict =
  | { kind: "saved" }
  | { kind: "noPrimary" }
  | { kind: "failed"; message: string };

/** A `saveImageAltText` answer: only an explicit `success: true` is a save. */
export function classifyAltSaveResponse(data: unknown): AltSaveVerdict {
  const rec = asRecord(data);
  if (rec && rec.success === true) return { kind: "saved" };
  if (rec && rec.errorCode === ALT_NO_PRIMARY) return { kind: "noPrimary" };
  return { kind: "failed", message: errorText(rec) };
}

/**
 * Whether a FOREIGN alt box is locked: the image has no saved primary alt, so
 * a translation typed there could never be stored (the save would be refused
 * and the draft would hold the save bar open for good). A value the language
 * already holds stays editable so it can still be cleared, and so does a box
 * the merchant is in the middle of editing (it is dirty), or the lock would
 * snap shut the moment the last character is deleted.
 */
export function foreignAltLocked(args: {
  isPrimaryLocale: boolean;
  primaryAlt: string | null | undefined;
  own: string | null | undefined;
  dirty: boolean;
}): boolean {
  if (args.isPrimaryLocale) return false;
  if (altTranslateSourceText(args.primaryAlt) !== null) return false;
  if ((args.own ?? "") !== "") return false;
  return !args.dirty;
}

/**
 * The SAVED primary alt of the medium a tile shows, or `undefined` when it is
 * not KNOWN on the client. A product image is known (by its url, else by its
 * media GID -- one medium may be shown under several urls); anything else in a
 * variant gallery is a media-library file whose primary alt nothing here
 * holds. Unknown must never lock the foreign box or disable "translate": the
 * server reads the alt itself and answers with noSource / noPrimary.
 */
export function knownPrimaryAlt(args: {
  url: string;
  gid: string | null | undefined;
  images: ReadonlyArray<{ url: string; mediaId?: string | null; altText?: string | null }>;
}): string | undefined {
  const byUrl = args.images.find((img) => img.url === args.url);
  const img = byUrl ?? (args.gid ? args.images.find((i) => i.mediaId === args.gid) : undefined);
  if (!img) return undefined;
  return img.altText ?? "";
}

/**
 * The answer code of a single-language alt translate that had no SOURCE: the
 * image has no saved alt text in the primary language. Refused before any AI
 * call -- an empty (or foreign) text handed to the translate prompt is what
 * made the model answer in prose and every retry fail the same way.
 */
export const ALT_NO_SOURCE_TEXT = "noSourceAltText";

/**
 * The text a single-language alt translate starts from: ALWAYS the image's
 * SAVED primary-language alt, never what the foreign field holds (that is the
 * target language's own draft or translation, and translating it "into" the
 * language it is already in has no answer). `null` = nothing to translate,
 * and the caller must refuse rather than call the AI.
 */
export function altTranslateSourceText(primaryAlt: string | null | undefined): string | null {
  const text = typeof primaryAlt === "string" ? primaryAlt.trim() : "";
  return text === "" ? null : text;
}

/**
 * The server half of a single-language alt translate, decided before any AI
 * work: the source text (trimmed, never empty) and the language it is in.
 * A target equal to the primary language has nothing to translate either.
 */
export type AltTranslatePlan =
  | { ok: true; source: string; fromLang: string }
  | { ok: false; reason: "noSource" | "targetIsPrimary" };

export function planAltTranslate(opts: {
  sourceAltText: string | null | undefined;
  targetLocale: string;
  primaryLocale: string | null | undefined;
}): AltTranslatePlan {
  const source = altTranslateSourceText(opts.sourceAltText);
  if (source === null) return { ok: false, reason: "noSource" };
  const primary = (opts.primaryLocale ?? "").trim();
  if (primary && primary.toLowerCase() === opts.targetLocale.trim().toLowerCase()) {
    return { ok: false, reason: "targetIsPrimary" };
  }
  return { ok: true, source, fromLang: primary || "the source language" };
}

export type AltAiVerdict =
  | { kind: "ok" }
  | { kind: "noSource" }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

/** A generate / translate answer: ok, "no primary alt to translate from",
 *  a coded refusal (its message is the server's localised sentence), or any
 *  other failure. */
export function classifyAltAiResponse(data: unknown): AltAiVerdict {
  const rec = asRecord(data);
  if (rec && rec.errorCode === ALT_NO_SOURCE_TEXT) return { kind: "noSource" };
  if (rec && rec.success !== false && !rec.error) return { kind: "ok" };
  const code = typeof rec?.code === "string" ? rec.code : "";
  if (AI_REFUSAL_CODES.has(code)) return { kind: "refused", message: errorText(rec) };
  return { kind: "error", message: errorText(rec) };
}

export type AltAllLocalesVerdict =
  | { kind: "success"; savedCount: number }
  | { kind: "partial"; savedCount: number; failedLocales: string[] }
  | { kind: "refused"; message: string }
  | { kind: "noSource" }
  | { kind: "error"; message: string };

/** A `translateAltTextToAllLocales` answer: success, partial (named failed
 *  locales), refused, no source (no primary alt), or error. */
export function classifyAllLocalesResponse(data: unknown, targetLocales: string[] = []): AltAllLocalesVerdict {
  const rec = asRecord(data);
  if (!rec || rec.success !== true) {
    const ai = classifyAltAiResponse(data);
    if (ai.kind === "refused") return ai;
    // No primary alt to translate from: the caller words it in the merchant's
    // language (the same sentence as the single-language translate).
    if (ai.kind === "noSource") return ai;
    return { kind: "error", message: errorText(rec) };
  }
  const failed = Array.isArray(rec.failedLocales)
    ? (rec.failedLocales as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  const saved = Array.isArray(rec.savedLocales)
    ? (rec.savedLocales as unknown[]).length
    : Math.max(0, (targetLocales.length || failed.length) - failed.length);
  if (failed.length > 0) return { kind: "partial", savedCount: saved, failedLocales: failed };
  return { kind: "success", savedCount: saved };
}

/** Task status for an alt-translate run: any failed locale or image downgrades
 *  "completed" to "completed_with_errors" (the sub-resource repairs' rule). */
export function altTranslateTaskStatus(failedCount: number): "completed" | "completed_with_errors" {
  return failedCount > 0 ? "completed_with_errors" : "completed";
}

/**
 * Overlay entries to write after a confirmed translate-to-all: the translated
 * value of every locale that was SAVED, so an earlier copy-to-all value for the
 * same image never outlives it. Locales that failed are left out.
 */
export function overlayWritesFromTranslations(
  translatedAltTexts: Record<string, string> | undefined,
  failedLocales: string[],
): Array<{ locale: string; value: string }> {
  if (!translatedAltTexts) return [];
  const failed = new Set(failedLocales);
  const out: Array<{ locale: string; value: string }> = [];
  for (const [locale, value] of Object.entries(translatedAltTexts)) {
    if (failed.has(locale) || typeof value !== "string" || value === "") continue;
    out.push({ locale, value });
  }
  return out;
}

/** Overlay entries (image index -> value) of one locale from a translate-all-
 *  for-locale answer, skipping the images that failed to save. */
export function overlayIndexWrites(
  translated: Record<string, string> | undefined,
  failedImages: number[],
): Record<number, string> {
  const out: Record<number, string> = {};
  if (!translated) return out;
  for (const [idxStr, text] of Object.entries(translated)) {
    const idx = parseInt(idxStr, 10);
    if (Number.isNaN(idx) || failedImages.includes(idx) || typeof text !== "string") continue;
    out[idx] = text;
  }
  return out;
}

/**
 * A "translate every alt text into ONE language" answer (`{index: text}`) in
 * the shape of the every-language answer (`{index: {locale: text}}`), so both
 * are staged and shown by `applyAltTranslateAllAnswer`.
 */
export function forLocaleAltResults(
  translated: Record<string, string> | undefined,
  locale: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [index, text] of Object.entries(translated ?? {})) {
    if (typeof text === "string") out[index] = { [locale]: text };
  }
  return out;
}

/**
 * A "translate every alt text into every language" answer
 * (`translatedResults`: image index -> locale -> saved text), applied by the
 * locale each value was WRITTEN for, never by the view the button was pressed
 * in.
 *
 * Every saved (image, locale) goes into the GLOBAL overlay (`overlay[locale]`),
 * which the alt-text load reads before the loaded item: the answer is often
 * the last thing to land, and the loader data a revalidation brings may have
 * been read before the write — or no revalidation runs at all, because another
 * one was already in flight. Returned are the values of `view.locale` that the
 * caller should put on screen NOW: only for a foreign locale in the global
 * view (a translate writes no market override), and only for images whose
 * field is CLEAN (`current === original`), so a draft the merchant typed while
 * the run worked is never overwritten.
 *
 * The answer used to be applied against the locale captured at CLICK time —
 * the primary one, since the button lives there — so a merchant who switched
 * to a foreign language while it ran never saw it arrive, and the overlay was
 * never written at all on the whole-item "Translate all" path.
 */
export function applyAltTranslateAllAnswer(
  overlay: Record<string, Record<number, string>>,
  translatedResults: Record<string, Record<string, string>> | undefined | null,
  failedImages: number[],
  view: {
    locale: string;
    marketId: string;
    primaryLocale: string;
    current: Record<number, string>;
    original: Record<number, string>;
  },
): Record<number, string> {
  const visible: Record<number, string> = {};
  if (!translatedResults) return visible;
  const failed = new Set(failedImages);
  const showsGlobalForeign = view.locale !== view.primaryLocale && !view.marketId;
  for (const [idxStr, localeMap] of Object.entries(translatedResults)) {
    const idx = parseInt(idxStr, 10);
    if (Number.isNaN(idx) || failed.has(idx)) continue;
    for (const { locale, value } of overlayWritesFromTranslations(localeMap, [])) {
      if (locale === view.primaryLocale) continue;
      (overlay[locale] ??= {})[idx] = value;
      if (showsGlobalForeign && locale === view.locale) {
        const isClean = (view.current[idx] ?? "") === (view.original[idx] ?? "");
        if (isClean) visible[idx] = value;
      }
    }
  }
  return visible;
}

/**
 * The save queue of the image manager. Alt saves share ONE fetcher, so a second
 * save fired before the first answer landed dropped that answer (and its
 * re-translation task ids). Saves are therefore serialised: one in flight, the
 * rest queued, and a newer queued save for the same image and locale replaces
 * the older one.
 */
export interface QueuedAltSave {
  url: string;
  mediaId: string;
  altText: string;
  locale?: string;
  /** The market layer the save belongs to (undefined = global). */
  marketId?: string;
  /** The product the save was made on: a late answer must not touch another product's dirty state. */
  productId?: string;
  productTitle?: string;
  /**
   * Other tiles of the SAME medium that carried a draft when the save was
   * planned (the product gallery and a variant gallery may show one medium
   * under two urls). This save supersedes them: on success a tile still
   * showing the planned text takes over the saved one.
   */
  aliases?: Array<{ url: string; altText: string }>;
  /**
   * Saved at once by an AI button (generate / translate), not by the page
   * Save. Only such a save, queued or in flight, refuses a language, market
   * or product switch; a page Save's alt saves finish on their own.
   */
  immediate?: boolean;
}

export function enqueueAltSave(queue: QueuedAltSave[], entry: QueuedAltSave): QueuedAltSave[] {
  const rest = queue.filter((q) => !(q.mediaId === entry.mediaId && q.locale === entry.locale && (q.marketId ?? "") === (entry.marketId ?? "")));
  return [...rest, entry];
}

/** Does a (late) save answer still belong to what the screen shows? A save with
 *  no recorded product / locale counts as belonging. The market compares as
 *  "" = global, so a failed save of market A never marks market B's field. */
export function altSaveScope(
  entry: Pick<QueuedAltSave, "productId" | "locale" | "marketId">,
  current: { productId?: string; locale?: string; marketId?: string },
): { sameProduct: boolean; sameLocale: boolean; sameMarket: boolean } {
  return {
    sameProduct: !entry.productId || entry.productId === current.productId,
    sameLocale: entry.locale === undefined || entry.locale === current.locale,
    sameMarket: (entry.marketId ?? "") === (current.marketId ?? ""),
  };
}

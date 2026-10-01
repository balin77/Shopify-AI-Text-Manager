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

export type AltSaveVerdict = { kind: "saved" } | { kind: "failed"; message: string };

/** A `saveImageAltText` answer: only an explicit `success: true` is a save. */
export function classifyAltSaveResponse(data: unknown): AltSaveVerdict {
  const rec = asRecord(data);
  if (rec && rec.success === true) return { kind: "saved" };
  return { kind: "failed", message: errorText(rec) };
}

export type AltAiVerdict =
  | { kind: "ok" }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

/** A generate / translate answer: ok, a coded refusal (its message is the
 *  server's localised sentence), or any other failure. */
export function classifyAltAiResponse(data: unknown): AltAiVerdict {
  const rec = asRecord(data);
  if (rec && rec.success !== false && !rec.error) return { kind: "ok" };
  const code = typeof rec?.code === "string" ? rec.code : "";
  if (AI_REFUSAL_CODES.has(code)) return { kind: "refused", message: errorText(rec) };
  return { kind: "error", message: errorText(rec) };
}

export type AltAllLocalesVerdict =
  | { kind: "success"; savedCount: number }
  | { kind: "partial"; savedCount: number; failedLocales: string[] }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

/** A `translateAltTextToAllLocales` answer: success, partial (named failed
 *  locales), refused, or error. */
export function classifyAllLocalesResponse(data: unknown, targetLocales: string[] = []): AltAllLocalesVerdict {
  const rec = asRecord(data);
  if (!rec || rec.success !== true) {
    const ai = classifyAltAiResponse(data);
    if (ai.kind === "refused") return ai;
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
}

export function enqueueAltSave(queue: QueuedAltSave[], entry: QueuedAltSave): QueuedAltSave[] {
  const rest = queue.filter((q) => !(q.mediaId === entry.mediaId && q.locale === entry.locale && (q.marketId ?? "") === (entry.marketId ?? "")));
  return [...rest, entry];
}

/** Does a (late) save answer still belong to what the screen shows? A save with
 *  no recorded product / locale counts as belonging. */
export function altSaveScope(
  entry: Pick<QueuedAltSave, "productId" | "locale">,
  current: { productId?: string; locale?: string },
): { sameProduct: boolean; sameLocale: boolean } {
  return {
    sameProduct: !entry.productId || entry.productId === current.productId,
    sameLocale: entry.locale === undefined || entry.locale === current.locale,
  };
}

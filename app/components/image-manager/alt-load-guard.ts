/**
 * A foreign alt-text LOAD answer reflects the server at the moment the request
 * was made. If an own value of the image was saved (and confirmed) after that
 * moment, applying the answer would delete or overwrite the fresh value with
 * an older one. Client-safe, import-free.
 */
export function answerPredatesSave(confirmedSaveAt: number | undefined, requestedAt: number): boolean {
  return confirmedSaveAt !== undefined && confirmedSaveAt >= requestedAt;
}

/** Monotonic clock for request/confirm stamps (Date.now() can step). */
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** A confirmed save only concerns the answer of the SAME layer (language + market). */
export function altConfirmKey(url: string, locale: string | null | undefined, marketId: string | null | undefined): string {
  return `${url}|${locale ?? ""}|${marketId ?? ""}`;
}

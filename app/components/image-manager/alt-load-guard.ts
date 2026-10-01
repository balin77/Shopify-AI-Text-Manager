/**
 * A foreign alt-text LOAD answer reflects the server at the moment the request
 * was made. If an own value of the image was saved (and confirmed) after that
 * moment, applying the answer would delete or overwrite the fresh value with
 * an older one. Client-safe, import-free.
 */
export function answerPredatesSave(confirmedSaveAt: number | undefined, requestedAt: number): boolean {
  return confirmedSaveAt !== undefined && confirmedSaveAt >= requestedAt;
}

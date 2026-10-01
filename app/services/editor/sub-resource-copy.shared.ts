/**
 * The sub-resource (option / option value) "copy to all languages" saves: how
 * one locale's answer is read, and how the optimistic overlay is taken back.
 *
 * Client-safe; imports only the per-locale helper, so the hook and the tests
 * share it.
 */

import { PLAN_REFUSED, isPlanRefusal, saveAnswerFailed } from "./per-locale-saves.shared";

/**
 * Posts one JSON-answering save and says whether it fully landed: HTTP ok,
 * `success !== false` and no `failedResources` (a partial apply answers
 * `success: true` and names what it refused).
 */
export async function postJsonSave(
  url: string,
  formData: FormData,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | typeof PLAN_REFUSED> {
  try {
    const response = await fetchImpl(url, { method: "POST", body: formData });
    if (!response.ok) return (await isPlanRefusal(response)) ? PLAN_REFUSED : false;
    return !saveAnswerFailed(await response.json().catch(() => null));
  } catch {
    return false;
  }
}

type SubResourceOverlay = Record<string, Record<string, Record<string, string>>>;

/**
 * Removes, for each failed locale, the overlay entries that still hold the
 * value the copy wrote. A value written there since is the merchant's and is
 * not ours to take back; an emptied resource/locale bucket goes with it.
 */
export function rollbackSubResourceCopy(
  overlay: SubResourceOverlay,
  failedLocales: readonly string[],
  entries: ReadonlyArray<{ resourceId: string; value: string }>,
): void {
  for (const locale of failedLocales) {
    const forLocale = overlay[locale];
    if (!forLocale) continue;
    for (const { resourceId, value } of entries) {
      const fields = forLocale[resourceId];
      if (fields && fields["name"] === value) {
        delete fields["name"];
        if (Object.keys(fields).length === 0) delete forLocale[resourceId];
      }
    }
    if (Object.keys(forLocale).length === 0) delete overlay[locale];
  }
}

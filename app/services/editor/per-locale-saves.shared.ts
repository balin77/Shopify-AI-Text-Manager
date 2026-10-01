/**
 * "Copy to all languages" is one save per target locale, and four editor
 * paths (a field, an alt text, a product option, an option's name and values)
 * used to carry their own copy of the same loop: build the request, post it,
 * collect the locales that did not land, take the optimistic value back, tell
 * the merchant. This is the one copy of the loop and of the sentence.
 *
 * Import-free, so hooks and tests can both reach it.
 */

/** Posts one locale's save; `false` = refused/failed, `true`/`null` = landed or unknowable. */
export type PerLocaleSave = (locale: string) => Promise<boolean | null>;

/**
 * Runs one save per locale and returns the locales that FAILED (`=== false`,
 * or a throw; an unknowable `null` answer is not reported as a failure, as
 * everywhere else).
 *
 * `sequential` keeps the order of the locales and one request in flight at a
 * time (the field copy has always worked that way); the default fires them all
 * at once.
 */
export async function runPerLocaleSaves(
  locales: readonly string[],
  save: PerLocaleSave,
  options: { sequential?: boolean } = {},
): Promise<string[]> {
  const attempt = async (locale: string): Promise<string | null> => {
    try {
      return (await save(locale)) === false ? locale : null;
    } catch {
      return locale;
    }
  };
  const results: Array<string | null> = [];
  if (options.sequential) {
    for (const locale of locales) results.push(await attempt(locale));
  } else {
    results.push(...(await Promise.all(locales.map(attempt))));
  }
  return results.filter((l): l is string => l !== null);
}

/** The message and tone a finished copy reports: "copied", or the failed locales named. */
export function copyOutcomeMessage(
  failed: readonly string[],
  strings: { copied?: string; copyFailedLocales?: string },
): { text: string; tone: "success" | "critical" } {
  if (failed.length > 0) {
    return {
      text: String(strings.copyFailedLocales ?? "Copying failed for: {locales}").replace(
        "{locales}",
        failed.map((l) => l.toUpperCase()).join(", "),
      ),
      tone: "critical",
    };
  }
  return { text: strings.copied ?? "Copied", tone: "success" };
}

/**
 * Whether a JSON save answer says the save did NOT fully land: unreadable,
 * `success: false`, or a non-empty `failed*` list (`failedAltTextIndices`,
 * `failedResources`, `failedOptions`, ...) on an answer that is otherwise
 * `success: true` because the rest of the save went through.
 */
export function saveAnswerFailed(body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const record = body as Record<string, unknown>;
  if (record.success === false) return true;
  for (const [key, value] of Object.entries(record)) {
    if (/^failed[A-Z]/.test(key) && Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

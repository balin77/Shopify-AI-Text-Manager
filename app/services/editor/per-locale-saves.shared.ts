/**
 * "Copy to all languages" is one save per target locale, and four editor
 * paths (a field, an alt text, a product option, an option's name and values)
 * used to carry their own copy of the same loop: build the request, post it,
 * collect the locales that did not land, take the optimistic value back, tell
 * the merchant. This is the one copy of the loop and of the sentence.
 *
 * Client-safe; imports nothing, so hooks and tests can both reach it.
 */

/** A save the server refused because the shop's plan lacks the content type (403 `gated`). */
export const PLAN_REFUSED = "gated" as const;

/**
 * Posts one locale's save; `false` = refused/failed, `PLAN_REFUSED` = refused
 * by the plan gate, `true`/`null` = landed or unknowable.
 */
export type PerLocaleSave = (locale: string) => Promise<boolean | null | typeof PLAN_REFUSED>;

/** Whether an HTTP answer is the plan gate's refusal (`planGateRefusal`: 403 `{ error: "gated" }`). */
export async function isPlanRefusal(response: { status?: number; json: () => Promise<unknown> }): Promise<boolean> {
  if (response.status !== 403) return false;
  const body = await response.json().catch(() => null);
  return !!body && typeof body === "object" && (body as { error?: unknown }).error === "gated";
}

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
  return (await runPerLocaleSavesDetailed(locales, save, options)).failed;
}

/** Like {@link runPerLocaleSaves}, and also says whether any refusal was the plan gate. */
export async function runPerLocaleSavesDetailed(
  locales: readonly string[],
  save: PerLocaleSave,
  options: { sequential?: boolean } = {},
): Promise<{ failed: string[]; gated: boolean }> {
  let gated = false;
  const attempt = async (locale: string): Promise<string | null> => {
    try {
      const answer = await save(locale);
      if (answer === PLAN_REFUSED) {
        gated = true;
        return locale;
      }
      return answer === false ? locale : null;
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
  return { failed: results.filter((l): l is string => l !== null), gated };
}

/** The message and tone a finished copy reports: "copied", or the failed locales named. */
export function copyOutcomeMessage(
  failed: readonly string[],
  strings: { copied?: string; copyFailedLocales?: string; upgradeRequired?: string },
  gated = false,
): { text: string; tone: "success" | "critical" } {
  // A plan refusal is not a per-language fault: naming the locales would hide the reason.
  if (failed.length > 0 && gated) {
    return { text: strings.upgradeRequired ?? "Upgrade required", tone: "critical" };
  }
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
 * `success: true` because the rest of the save went through, or a non-empty
 * `warning` (a foreign save that stored a field "locally only" because Shopify
 * had no digest for it answers `{ success: true, warning }`: the storefront
 * does not have the value, so a copy must not report it as landed).
 */
export function saveAnswerFailed(body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const record = body as Record<string, unknown>;
  if (record.success === false) return true;
  if (typeof record.warning === "string" && record.warning.trim() !== "") return true;
  for (const [key, value] of Object.entries(record)) {
    if (/^failed[A-Z]/.test(key) && Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

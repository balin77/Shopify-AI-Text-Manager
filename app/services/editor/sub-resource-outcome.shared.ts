/**
 * What a sub-resource translate / save answer says to the merchant -- ONE pure
 * rule for the single-locale translate, the translate-to-all-locales run and
 * the save, so none of them can read a run in which everything failed as a
 * success. `failedResources` / `failedLocales` are refused or unechoed writes;
 * `notTranslatable` is a field Shopify exposes no digest for (a property of the
 * field, never reverted and never counted as a failure).
 */
import { partialLocaleCounts } from "../translations/partial-result.shared";

export interface SubResourceOutcomeData {
  failedResources?: string[];
  failedLocales?: string[];
  translatedLocales?: string[];
  notTranslatable?: string[];
  translations?: Record<string, unknown>;
}

export interface SubResourceOutcomeStrings {
  /** "{count} field(s) could not be saved in Shopify." */
  translateSubResourcesFailed?: string;
  /** "Translation partially completed: {successCount}/{totalCount} ... {failedLocales} failed." */
  translatePartialLocales?: string;
  /** "This field cannot be translated in Shopify." */
  subResourceNotTranslatable?: string;
}

export interface SubResourceOutcome {
  text: string;
  tone: "critical" | "warning";
}

/** `null` when nothing went wrong (the caller may then report success). */
export function subResourceOutcome(
  data: SubResourceOutcomeData | null | undefined,
  strings: SubResourceOutcomeStrings,
): SubResourceOutcome | null {
  if (!data) return null;
  const failedLocales = Array.isArray(data.failedLocales) ? data.failedLocales : [];
  const failedResources = Array.isArray(data.failedResources) ? data.failedResources : [];
  const notTranslatable = Array.isArray(data.notTranslatable) ? data.notTranslatable : [];

  if (failedLocales.length > 0) {
    // The all-locales run returns no translations map, only the locales it
    // finished: build the counts from those.
    let succeeded: number;
    let total: number;
    if (data.translatedLocales) {
      succeeded = data.translatedLocales.filter((l) => !failedLocales.includes(l)).length;
      total = new Set([...data.translatedLocales, ...failedLocales]).size;
    } else {
      ({ succeeded, total } = partialLocaleCounts(data.translations, failedLocales));
    }
    return {
      text: String(
        strings.translatePartialLocales ??
          "Translation partially completed: {successCount}/{totalCount} language(s) succeeded. Language(s) {failedLocales} failed.",
      )
        .replace("{successCount}", String(succeeded))
        .replace("{totalCount}", String(total))
        .replace("{failedLocales}", failedLocales.join(", ")),
      tone: succeeded === 0 ? "critical" : "warning",
    };
  }

  const parts: string[] = [];
  if (failedResources.length > 0) {
    parts.push(
      String(strings.translateSubResourcesFailed ?? "{count} field(s) could not be saved in Shopify.").replace(
        "{count}",
        String(failedResources.length),
      ),
    );
  }
  if (notTranslatable.length > 0) {
    parts.push(String(strings.subResourceNotTranslatable ?? "This field cannot be translated in Shopify."));
  }
  if (parts.length === 0) return null;
  return { text: parts.join(" "), tone: failedResources.length > 0 ? "critical" : "warning" };
}

import type { VariantSelectedOption } from "../components/image-manager/types";
import { METAOBJECT_LABEL_FIELD_KEYS } from "../constants/shopifyFields";

export interface ResolvedOption {
  name: string;
  value: string;
  fallback: boolean;
}

/**
 * Per-call cache for translatableResource lookups. Maps `${resourceId}|${locale}|${keysCsv}`
 * to either the translated string, or `null` (= looked up, no translation
 * registered). Sharing one of these across all variants in a single apply
 * cuts O(variants × options) GraphQL calls down to O(distinct GIDs) — and
 * silently fixes the "some variants translate, others don't" symptom that
 * came from THROTTLED bursts under the old per-variant lookup loop.
 */
export type TranslationCache = Map<string, string | null>;

export function createTranslationCache(): TranslationCache {
  return new Map();
}

type AdminClient = { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> };

/**
 * Fills a template string with resolved variant option values.
 * e.g. "Eleganter {Farbe} Blumentopf" + {Farbe: "Rot"} → "Eleganter Rot Blumentopf"
 */
export function fillAltTextTemplate(template: string, resolvedOptions: ResolvedOption[]): string {
  let result = template;
  for (const opt of resolvedOptions) {
    result = result.replace(
      new RegExp(`\\{${escapeRegex(opt.name)}\\}`, "g"),
      opt.value
    );
  }
  return result;
}

/**
 * Resolves variant option values for the given locale.
 * For the primary locale, returns values as-is.
 * For foreign locales:
 *   - Metaobject-linked options → fetch the metaobject's `display_name` translation.
 *   - Plain text options       → fetch the ProductOptionValue's `name` translation.
 * Falls back to the original value if no translation is found.
 *
 * Pass a shared `cache` (see createTranslationCache) when calling this in a
 * loop — the same option value typically appears across many variants and
 * we don't want one GraphQL roundtrip per occurrence.
 */
export async function resolveVariableValues(
  selectedOptions: VariantSelectedOption[],
  locale: string,
  isPrimary: boolean,
  admin: AdminClient,
  cache?: TranslationCache,
): Promise<ResolvedOption[]> {
  if (isPrimary) {
    return selectedOptions.map((opt) => ({ name: opt.name, value: opt.value, fallback: false }));
  }

  const resolved: ResolvedOption[] = [];

  for (const opt of selectedOptions) {
    if (opt.metaobjectGid) {
      const translatedValue = await fetchMetaobjectTranslationById(opt.metaobjectGid, locale, admin, cache);
      if (translatedValue) {
        resolved.push({ name: opt.name, value: translatedValue, fallback: false });
        continue;
      }
    }
    if (opt.optionValueGid) {
      const translatedValue = await fetchOptionValueTranslationById(opt.optionValueGid, locale, admin, cache);
      if (translatedValue) {
        resolved.push({ name: opt.name, value: translatedValue, fallback: false });
        continue;
      }
    }
    // Fallback: original value (also covers options without any GID)
    resolved.push({ name: opt.name, value: opt.value, fallback: true });
  }

  return resolved;
}

/**
 * Generic translatable-resource lookup. Returns the translated value for the first
 * matching key in `keys`, or null if none match.
 *
 * Retries on Shopify cost-throttling: the previous implementation swallowed
 * THROTTLED errors as "no translation", which under load looked exactly like
 * a genuinely-missing translation and silently fell back to the primary
 * value for some (but not all) variants.
 */
async function fetchTranslationByAnyKey(
  resourceId: string,
  locale: string,
  keys: readonly string[],
  admin: AdminClient,
  cache?: TranslationCache,
): Promise<string | null> {
  const cacheKey = `${resourceId}|${locale}|${keys.join(",")}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const backoffMs = [400, 1000, 2000];
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const tr = await admin.graphql(
        `#graphql
          query getTranslatableResource($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translations(locale: $locale) {
                key
                value
              }
            }
          }`,
        { variables: { resourceId, locale } }
      );
      const status = tr.status;
      const td = await tr.json() as any;
      const errs: any[] = Array.isArray(td?.errors) ? td.errors : [];
      const throttled =
        status === 429 ||
        errs.some(
          (e: any) =>
            e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message ?? ""),
        );
      if (throttled && attempt < maxAttempts - 1) {
        await new Promise((res) => setTimeout(res, backoffMs[Math.min(attempt, backoffMs.length - 1)]));
        continue;
      }
      const translations: { key: string; value: string }[] = td.data?.translatableResource?.translations ?? [];
      for (const k of keys) {
        const found = translations.find((t) => t.key === k)?.value;
        if (found) {
          cache?.set(cacheKey, found);
          return found;
        }
      }
      cache?.set(cacheKey, null);
      return null;
    } catch {
      if (attempt < maxAttempts - 1) {
        await new Promise((res) => setTimeout(res, backoffMs[Math.min(attempt, backoffMs.length - 1)]));
        continue;
      }
      // Don't poison the cache on a transient failure — leaving the key
      // unset lets a later resolve retry. (Negative hits above DO cache,
      // because "Shopify said no translations" is a real answer.)
      return null;
    }
  }
  return null;
}

export async function fetchMetaobjectTranslationById(
  metaobjectGid: string,
  locale: string,
  admin: AdminClient,
  cache?: TranslationCache,
): Promise<string | null> {
  // Metaobject label is stored under one of these keys depending on the type definition.
  return fetchTranslationByAnyKey(metaobjectGid, locale, METAOBJECT_LABEL_FIELD_KEYS, admin, cache);
}

export async function fetchOptionValueTranslationById(
  optionValueGid: string,
  locale: string,
  admin: AdminClient,
  cache?: TranslationCache,
): Promise<string | null> {
  return fetchTranslationByAnyKey(optionValueGid, locale, ["name"], admin, cache);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

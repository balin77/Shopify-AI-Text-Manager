import type { VariantSelectedOption } from "../components/image-manager/types";
import { METAOBJECT_LABEL_FIELD_KEYS } from "../constants/shopifyFields";

export interface ResolvedOption {
  name: string;
  value: string;
  fallback: boolean;
}

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
 */
export async function resolveVariableValues(
  selectedOptions: VariantSelectedOption[],
  locale: string,
  isPrimary: boolean,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<ResolvedOption[]> {
  if (isPrimary) {
    return selectedOptions.map((opt) => ({ name: opt.name, value: opt.value, fallback: false }));
  }

  const resolved: ResolvedOption[] = [];

  for (const opt of selectedOptions) {
    if (opt.metaobjectGid) {
      const translatedValue = await fetchMetaobjectTranslationById(opt.metaobjectGid, locale, admin);
      if (translatedValue) {
        resolved.push({ name: opt.name, value: translatedValue, fallback: false });
        continue;
      }
    }
    if (opt.optionValueGid) {
      const translatedValue = await fetchOptionValueTranslationById(opt.optionValueGid, locale, admin);
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
 */
async function fetchTranslationByAnyKey(
  resourceId: string,
  locale: string,
  keys: readonly string[],
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
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
    const td = await tr.json() as any;
    const translations: { key: string; value: string }[] = td.data?.translatableResource?.translations ?? [];
    for (const k of keys) {
      const found = translations.find((t) => t.key === k)?.value;
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchMetaobjectTranslationById(
  metaobjectGid: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  // Metaobject label is stored under one of these keys depending on the type definition.
  return fetchTranslationByAnyKey(metaobjectGid, locale, METAOBJECT_LABEL_FIELD_KEYS, admin);
}

export async function fetchOptionValueTranslationById(
  optionValueGid: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  return fetchTranslationByAnyKey(optionValueGid, locale, ["name"], admin);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

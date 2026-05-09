import type { VariantSelectedOption } from "../components/image-manager/types";

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
 * Generic translatable-resource lookup. Returns the translated value for the given key, or null.
 */
async function fetchTranslationByKey(
  resourceId: string,
  locale: string,
  key: string,
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
    return translations.find((t) => t.key === key)?.value ?? null;
  } catch {
    return null;
  }
}

export async function fetchMetaobjectTranslationById(
  metaobjectGid: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  return fetchTranslationByKey(metaobjectGid, locale, "display_name", admin);
}

export async function fetchOptionValueTranslationById(
  optionValueGid: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  return fetchTranslationByKey(optionValueGid, locale, "name", admin);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * For foreign locales, attempts to fetch Shopify translations for PRODUCT_OPTION_VALUE.
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

  // For foreign locales: try to get Shopify translations for option values via metaobject GID.
  // Falls back to the original value if no translation is found.
  const resolved: ResolvedOption[] = [];

  for (const opt of selectedOptions) {
    if (opt.metaobjectGid) {
      // Preferred path: use the GID directly — no need to know the metaobject type.
      const translatedValue = await fetchMetaobjectTranslationById(opt.metaobjectGid, locale, admin);
      if (translatedValue) {
        resolved.push({ name: opt.name, value: translatedValue, fallback: false });
        continue;
      }
    }
    // Fallback: use original value (also covers options without a linked metaobject)
    resolved.push({ name: opt.name, value: opt.value, fallback: true });
  }

  return resolved;
}

async function fetchMetaobjectTranslationById(
  metaobjectGid: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  try {
    const tr = await admin.graphql(
      `#graphql
        query getMetaobjectTranslations($resourceId: ID!, $locale: String!) {
          translatableResource(resourceId: $resourceId) {
            translations(locale: $locale) {
              key
              value
            }
          }
        }`,
      { variables: { resourceId: metaobjectGid, locale } }
    );
    const td = await tr.json() as any;
    const translations: { key: string; value: string }[] = td.data?.translatableResource?.translations ?? [];
    return translations.find((t) => t.key === "display_name")?.value ?? null;
  } catch {
    return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  // For foreign locales: try to get Shopify translations for option values via metaobject handle
  // If the option value is linked to a metaobject (has a handle), we can look up its translation.
  // Otherwise, fall back to the original value.
  const resolved: ResolvedOption[] = [];

  for (const opt of selectedOptions) {
    if (opt.handle) {
      // Try to get the translated metaobject display name for this locale
      const translatedValue = await fetchMetaobjectTranslation(opt.handle, locale, admin);
      if (translatedValue) {
        resolved.push({ name: opt.name, value: translatedValue, fallback: false });
        continue;
      }
    }
    // Fallback: use original value
    resolved.push({ name: opt.name, value: opt.value, fallback: true });
  }

  return resolved;
}

async function fetchMetaobjectTranslation(
  handle: string,
  locale: string,
  admin: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }
): Promise<string | null> {
  try {
    // First find the metaobject GID by handle
    const r = await admin.graphql(
      `#graphql
        query getMetaobjectByHandle($handle: String!) {
          metaobjectByHandle(handle: { handle: $handle, type: "color" }) {
            id
            displayName
          }
        }`,
      { variables: { handle } }
    );
    const d = await r.json() as any;
    const metaobjectId = d.data?.metaobjectByHandle?.id;
    if (!metaobjectId) return null;

    // Then get the translation for this metaobject
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
      { variables: { resourceId: metaobjectId, locale } }
    );
    const td = await tr.json() as any;
    const translations: { key: string; value: string }[] = td.data?.translatableResource?.translations ?? [];
    const displayNameTranslation = translations.find((t) => t.key === "display_name");
    return displayNameTranslation?.value ?? null;
  } catch {
    return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

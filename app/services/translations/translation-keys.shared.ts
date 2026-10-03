/**
 * THE field -> Shopify translatable-content key map (client-safe, import-free).
 *
 * Every other module that needs "which translation key does this field
 * travel under" imports from here; src/services/shopify-content.service.ts
 * re-exports it under its historic names. Never re-declare it (the copies
 * drifted before - PLAN_TRANSLATION_WRITE_UNIFICATION section 2.3).
 *
 * body/description -> "body_html" on every resource EXCEPT ShopPolicy, where
 * both the mutation and the translation key are plain "body"
 * (fieldTranslationKeyMap handles that one exception).
 */
export const FIELD_TO_TRANSLATION_KEY: Readonly<Record<string, string>> = {
  title: "title",
  description: "body_html",
  body: "body_html",
  handle: "handle",
  seoTitle: "meta_title",
  metaDescription: "meta_description",
  productType: "product_type",
  summary: "summary_html",
};

/** The field->key map with the single ShopPolicy exception applied. */
export function fieldTranslationKeyMap(resourceType: string): Readonly<Record<string, string>> {
  if (resourceType !== "ShopPolicy") return FIELD_TO_TRANSLATION_KEY;
  return { ...FIELD_TO_TRANSLATION_KEY, description: "body", body: "body" };
}

/**
 * Shopify translation key -> editor UI field key (the inverse the editors'
 * completeness checks read). `description` wins over `body` for body_html
 * (first entry of the canonical map), and a ShopPolicy's plain `body` key maps
 * back to `description` as well.
 */
export const TRANSLATION_KEY_TO_FIELD: Readonly<Record<string, string>> = (() => {
  const inverse: Record<string, string> = {};
  for (const [field, key] of Object.entries(FIELD_TO_TRANSLATION_KEY)) {
    if (!(key in inverse)) inverse[key] = field;
  }
  inverse.body = "description";
  return inverse;
})();

/**
 * Constants for Shopify translation field keys and mappings
 * Centralizes all field-related string literals to prevent typos and improve refactoring
 */

export const SHOPIFY_TRANSLATION_KEYS = {
  TITLE: 'title',
  BODY: 'body',
  BODY_HTML: 'body_html',
  HANDLE: 'handle',
  META_TITLE: 'meta_title',
  META_DESCRIPTION: 'meta_description',
  PRODUCT_TYPE: 'product_type',
  SUMMARY: 'summary',
} as const;

/**
 * Maps content types to their description field translation key
 */
export const CONTENT_TYPE_DESCRIPTION_KEY: Record<string, string> = {
  policies: SHOPIFY_TRANSLATION_KEYS.BODY,
  pages: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  blogs: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  collections: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  products: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
};

/**
 * Maps UI field names to Shopify translation keys
 */
export const UI_FIELD_TO_TRANSLATION_KEY: Record<string, string> = {
  title: SHOPIFY_TRANSLATION_KEYS.TITLE,
  description: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  body_html: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  body: SHOPIFY_TRANSLATION_KEYS.BODY,
  handle: SHOPIFY_TRANSLATION_KEYS.HANDLE,
  seoTitle: SHOPIFY_TRANSLATION_KEYS.META_TITLE,
  meta_title: SHOPIFY_TRANSLATION_KEYS.META_TITLE,
  metaDescription: SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION,
  meta_description: SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION,
  productType: SHOPIFY_TRANSLATION_KEYS.PRODUCT_TYPE,
  product_type: SHOPIFY_TRANSLATION_KEYS.PRODUCT_TYPE,
  summary: SHOPIFY_TRANSLATION_KEYS.SUMMARY,
};

/**
 * Required fields configuration for each content type
 */
export const FIELD_CONFIGS = {
  products: ['title', 'descriptionHtml', 'handle', 'productType', 'seo.title', 'seo.description'],
  collections: ['title', 'descriptionHtml', 'handle', 'seo.title', 'seo.description'],
  pages: ['title', 'body', 'handle'],
  blogs: ['title', 'body', 'summary', 'handle', 'seo.title', 'seo.description'],
  policies: ['body'],
  templates: ['title', 'body'],
  metaobjects: [] // Metaobjects have dynamic fields
} as const;

/**
 * Maps field paths to translation keys
 */
export const TRANSLATION_KEY_MAP = {
  title: SHOPIFY_TRANSLATION_KEYS.TITLE,
  descriptionHtml: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  body: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  handle: SHOPIFY_TRANSLATION_KEYS.HANDLE,
  productType: SHOPIFY_TRANSLATION_KEYS.PRODUCT_TYPE,
  summary: SHOPIFY_TRANSLATION_KEYS.SUMMARY,
  'seo.title': SHOPIFY_TRANSLATION_KEYS.META_TITLE,
  'seo.description': SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION,
} as const;

/**
 * Maps all field keys (both FIELD_CONFIGS paths and Shopify translation keys)
 * to i18n label keys (common.fieldLabels.*).
 * Used by getLocaleButtonTooltip to resolve human-readable labels.
 */
export const FIELD_TO_LABEL_KEY: Record<string, string> = {
  // FIELD_CONFIGS paths (used by getMissingPrimaryFields)
  title: 'title',
  descriptionHtml: 'description',
  body: 'content',
  handle: 'handle',
  productType: 'productType',
  summary: 'summary',
  'seo.title': 'seoTitle',
  'seo.description': 'metaDescription',
  // Shopify translation keys (used by getMissingLocaleTranslationFields)
  body_html: 'description',
  meta_title: 'seoTitle',
  meta_description: 'metaDescription',
  product_type: 'productType',
  summary_html: 'summary',
};

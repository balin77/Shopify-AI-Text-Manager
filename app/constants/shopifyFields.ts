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
};

/**
 * Required fields configuration for each content type
 */
export const FIELD_CONFIGS = {
  products: ['title', 'descriptionHtml', 'handle', 'seo.title', 'seo.description'],
  collections: ['title', 'descriptionHtml', 'handle', 'seo.title', 'seo.description'],
  pages: ['title', 'body', 'handle'],
  blogs: ['title', 'body', 'handle'],
  policies: ['body']
} as const;

/**
 * Maps field paths to translation keys
 */
export const TRANSLATION_KEY_MAP = {
  title: SHOPIFY_TRANSLATION_KEYS.TITLE,
  descriptionHtml: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  body: SHOPIFY_TRANSLATION_KEYS.BODY_HTML,
  handle: SHOPIFY_TRANSLATION_KEYS.HANDLE,
  'seo.title': SHOPIFY_TRANSLATION_KEYS.META_TITLE,
  'seo.description': SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION,
} as const;

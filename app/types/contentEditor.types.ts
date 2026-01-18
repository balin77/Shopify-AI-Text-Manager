/**
 * Type definitions for Content Editor utilities
 * Used across multiple routes for translatable content management
 */

export interface Translation {
  key: string;
  locale: string;
  value: string;
}

export interface SEO {
  title: string | null;
  description: string | null;
}

export interface TranslatableItem {
  id: string;
  title?: string | null;
  body?: string | null;
  descriptionHtml?: string | null;
  handle?: string | null;
  seo?: SEO | null;
  translations?: Translation[];
}

export interface ShopifyCollection extends TranslatableItem {
  descriptionHtml: string;
  seo: SEO;
}

export interface ShopifyPage extends TranslatableItem {
  body: string;
}

export interface ShopifyBlog extends TranslatableItem {
  body: string;
}

export interface ShopifyPolicy extends TranslatableItem {
  body: string;
  // Policies don't have translatable title field
}

export interface ShopifyProduct extends TranslatableItem {
  descriptionHtml: string;
  seo: SEO;
}

export type ContentItem =
  | ShopifyCollection
  | ShopifyPage
  | ShopifyBlog
  | ShopifyPolicy
  | ShopifyProduct;

export type ContentType = 'pages' | 'blogs' | 'collections' | 'policies' | 'products';

export interface ShopLocale {
  locale: string;
  primary: boolean;
  name?: string;
}

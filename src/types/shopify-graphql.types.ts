/**
 * TypeScript types for Shopify GraphQL API responses
 *
 * These types provide type safety for GraphQL operations
 * and replace the use of 'any' throughout the codebase.
 */

// Common types
export interface UserError {
  field: string[];
  message: string;
}

export interface ShopifyGID {
  id: string;
}

// Product types
export interface Product extends ShopifyGID {
  title: string;
  description?: string;
  handle?: string;
  status?: string;
  tags?: string[];
  vendor?: string;
  productType?: string;
}

export interface ProductUpdatePayload {
  product?: Product;
  userErrors: UserError[];
}

export interface ProductUpdateResponse {
  productUpdate: ProductUpdatePayload;
}

// Metafield types
export interface Metafield extends ShopifyGID {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface MetafieldsSetPayload {
  metafields?: Metafield[];
  userErrors: UserError[];
}

export interface MetafieldsSetResponse {
  metafieldsSet: MetafieldsSetPayload;
}

// Translation types
export interface Translation extends ShopifyGID {
  locale: string;
  key: string;
  value: string;
  translatable?: {
    id: string;
  };
}

export interface TranslationUpdatePayload {
  translations?: Translation[];
  userErrors: UserError[];
}

export interface TranslationUpdateResponse {
  translationsRegister: TranslationUpdatePayload;
}

// Collection types
export interface Collection extends ShopifyGID {
  title: string;
  description?: string;
  handle?: string;
  descriptionHtml?: string;
}

export interface CollectionUpdatePayload {
  collection?: Collection;
  userErrors: UserError[];
}

export interface CollectionUpdateResponse {
  collectionUpdate: CollectionUpdatePayload;
}

// Page types
export interface Page extends ShopifyGID {
  title: string;
  body?: string;
  bodyHtml?: string;
  handle?: string;
}

export interface PageUpdatePayload {
  page?: Page;
  userErrors: UserError[];
}

export interface PageUpdateResponse {
  pageUpdate: PageUpdatePayload;
}

// Generic GraphQL response wrapper
export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{
      line: number;
      column: number;
    }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}

// Query input types
export interface ProductInput {
  id?: string;
  title?: string;
  description?: string;
  descriptionHtml?: string;
  handle?: string;
  status?: string;
  tags?: string[];
  vendor?: string;
  productType?: string;
}

export interface CollectionInput {
  id?: string;
  title?: string;
  description?: string;
  descriptionHtml?: string;
  handle?: string;
}

export interface PageInput {
  id?: string;
  title?: string;
  body?: string;
  bodyHtml?: string;
  handle?: string;
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: string;
  ownerId?: string;
}

export interface TranslationInput {
  locale: string;
  key: string;
  value: string;
  translatableContentDigest?: string;
}

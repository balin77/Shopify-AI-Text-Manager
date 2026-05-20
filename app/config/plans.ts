/**
 * Subscription Plan Configuration
 * Defines limits and features for each plan tier
 */

import { PLAN_WEBP_CONCURRENCY } from "./webp-concurrency.js";

export type Plan = "free" | "basic" | "pro" | "max";

export type ContentType =
  | "products"
  | "collections"
  | "articles"
  | "blogs"
  | "pages"
  | "policies"
  | "templates"
  | "menus"
  | "metaobjects";

export interface PlanLimits {
  maxProducts: number;
  maxLocales: number;
  maxCollections: number;
  maxArticles: number;
  maxPages: number;
  maxThemeTranslations: number;
  maxConcurrentWebpConversions: number;
  /**
   * Rolling monthly cap on billable image operations (Bulk-Upload + WebP
   * conversion). Our real variable cost is image compute/bandwidth, not AI
   * (tokens are merchant-funded BYO). 0 = feature not available on this tier
   * (Free/Basic have no image manager anyway). Enforced lazily at the upload/
   * convert routes via app/utils/imageOperations.server.ts — it is usage data,
   * NOT entitlement data, so it deliberately stays out of getSyncScope /
   * planCacheCleanup. See docs/ROADMAP.md §Limit-Review Befund 3.
   */
  monthlyImageOperations: number;
  productImages: "featured-only" | "all";
  contentTypes: ContentType[];
  aiInstructionsEditable: boolean;
  variantImageManager: boolean;
  cacheEnabled: {
    products: boolean;
    productImages: boolean;
    productOptions: boolean;
    productMetafields: boolean;
    collections: boolean;
    articles: boolean;
    pages: boolean;
    policies: boolean;
    themes: boolean;
  };
}

export const PLAN_CONFIG: Record<Plan, PlanLimits> = {
  free: {
    maxProducts: 50,
    // Locales are intentionally uncapped on every tier: AI tokens are
    // merchant-funded (BYO key), so extra languages cost us nothing. Language
    // generosity is a deliberate USP — segmentation happens via product count
    // and content breadth, not locale count. (Decision: 2026-05, ROADMAP §Limit-Review.)
    maxLocales: Infinity,
    maxCollections: 5,
    maxArticles: 0,
    maxPages: 0,
    maxThemeTranslations: 0,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.free,
    monthlyImageOperations: 0,
    productImages: "featured-only",
    contentTypes: ["products", "collections"],
    aiInstructionsEditable: false,
    variantImageManager: true,
    cacheEnabled: {
      products: true, // limited to 50
      productImages: false, // only featured image
      productOptions: false,
      productMetafields: false,
      collections: true,
      articles: false,
      pages: false,
      policies: false,
      themes: false,
    },
  },
  basic: {
    maxProducts: 100,
    maxLocales: Infinity,
    maxCollections: 50,
    maxArticles: 0,
    maxPages: 20,
    maxThemeTranslations: 0,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.basic,
    monthlyImageOperations: 0,
    productImages: "all",
    contentTypes: ["products", "collections", "pages", "policies"],
    aiInstructionsEditable: false,
    variantImageManager: true,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: false,
      pages: true,
      policies: true,
      themes: false,
    },
  },
  pro: {
    maxProducts: 500,
    maxLocales: Infinity,
    maxCollections: 100,
    maxArticles: 100,
    maxPages: 50,
    maxThemeTranslations: 50000,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.pro,
    monthlyImageOperations: 2000,
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "blogs", "pages", "policies", "templates", "menus", "metaobjects"],
    aiInstructionsEditable: true,
    variantImageManager: true,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: true,
      pages: true,
      policies: true,
      themes: true,
    },
  },
  max: {
    maxProducts: 2500,
    maxLocales: Infinity,
    maxCollections: 500,
    maxArticles: 300,
    maxPages: 200,
    maxThemeTranslations: 100000,
    maxConcurrentWebpConversions: PLAN_WEBP_CONCURRENCY.max,
    monthlyImageOperations: 10000,
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "blogs", "pages", "policies", "templates", "menus", "metaobjects"],
    aiInstructionsEditable: true,
    variantImageManager: true,
    cacheEnabled: {
      products: true,
      productImages: true,
      productOptions: true,
      productMetafields: true,
      collections: true,
      articles: true,
      pages: true,
      policies: true,
      themes: true,
    },
  },
};

export const PLAN_DISPLAY_NAMES: Record<Plan, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  max: "Max",
};


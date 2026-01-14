/**
 * Subscription Plan Configuration
 * Defines limits and features for each plan tier
 */

export type Plan = "free" | "basic" | "pro" | "max";

export type ContentType =
  | "products"
  | "collections"
  | "articles"
  | "pages"
  | "policies"
  | "themes"
  | "menus"
  | "metaobjects"
  | "metadata";

export interface PlanLimits {
  maxProducts: number;
  productImages: "featured-only" | "all";
  contentTypes: ContentType[];
  aiInstructionsEditable: boolean;
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
    maxProducts: 15,
    productImages: "featured-only",
    contentTypes: ["products", "collections"],
    aiInstructionsEditable: false,
    cacheEnabled: {
      products: true, // limited to 15
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
    maxProducts: 50,
    productImages: "all",
    contentTypes: ["products", "collections", "pages", "policies"],
    aiInstructionsEditable: false,
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
    maxProducts: 150,
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "pages", "policies", "themes", "menus"],
    aiInstructionsEditable: true,
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
    maxProducts: Infinity,
    productImages: "all",
    contentTypes: ["products", "collections", "articles", "pages", "policies", "themes", "menus", "metaobjects", "metadata"],
    aiInstructionsEditable: true,
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

export const PLAN_COLORS: Record<Plan, string> = {
  free: "#8c8c8c", // gray
  basic: "#2c6ecb", // blue
  pro: "#9333ea", // purple
  max: "#eab308", // gold
};

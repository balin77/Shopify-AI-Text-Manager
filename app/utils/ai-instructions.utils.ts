/**
 * AI Instructions Utilities
 *
 * Helper functions to ensure default AI instructions are used when DB values are NULL/empty.
 * This prevents prompts from missing important context like writing style instructions.
 */

import type { AIInstructions } from "@prisma/client";
import {
  DEFAULT_GENERAL_INSTRUCTIONS,
  DEFAULT_PRODUCT_INSTRUCTIONS,
  DEFAULT_COLLECTION_INSTRUCTIONS,
  DEFAULT_BLOG_INSTRUCTIONS,
  DEFAULT_PAGE_INSTRUCTIONS,
  DEFAULT_POLICY_INSTRUCTIONS,
} from "../constants/aiInstructionsDefaults";

/**
 * Gets AI instruction value with fallback to default.
 * Returns the DB value if it exists (not NULL and not empty string),
 * otherwise returns the default value.
 *
 * @param dbInstructions - AI instructions object from database (can be null)
 * @param key - The field key to retrieve
 * @returns The instruction value with default fallback
 */
export function getInstructionWithDefault(
  dbInstructions: AIInstructions | Record<string, string | null> | null,
  key: string
): string {
  // If we have a DB value that's not null and not empty, use it
  const dbValue = dbInstructions?.[key as keyof typeof dbInstructions];
  if (dbValue && typeof dbValue === "string" && dbValue.trim() !== "") {
    return dbValue;
  }

  // Otherwise, fall back to default
  // Map keys to default values
  const defaultMap: Record<string, string> = {
    // General
    writingStyleInstructions: DEFAULT_GENERAL_INSTRUCTIONS.writingStyleInstructions,
    formatPreserveInstructions: DEFAULT_GENERAL_INSTRUCTIONS.formatPreserveInstructions,
    translateInstructions: DEFAULT_GENERAL_INSTRUCTIONS.translateInstructions,

    // Products
    productTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
    productTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
    productDescriptionFormat: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
    productDescriptionInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
    productHandleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
    productHandleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
    productSeoTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
    productSeoTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
    productMetaDescFormat: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
    productMetaDescInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
    productAltTextFormat: DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat || "",
    productAltTextInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions || "",

    // Collections
    collectionTitleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.titleFormat,
    collectionTitleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.titleInstructions,
    collectionDescriptionFormat: DEFAULT_COLLECTION_INSTRUCTIONS.descriptionFormat,
    collectionDescriptionInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.descriptionInstructions,
    collectionHandleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.handleFormat,
    collectionHandleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.handleInstructions,
    collectionSeoTitleFormat: DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleFormat,
    collectionSeoTitleInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.seoTitleInstructions,
    collectionMetaDescFormat: DEFAULT_COLLECTION_INSTRUCTIONS.metaDescFormat,
    collectionMetaDescInstructions: DEFAULT_COLLECTION_INSTRUCTIONS.metaDescInstructions,

    // Blogs
    blogTitleFormat: DEFAULT_BLOG_INSTRUCTIONS.titleFormat,
    blogTitleInstructions: DEFAULT_BLOG_INSTRUCTIONS.titleInstructions,
    blogDescriptionFormat: DEFAULT_BLOG_INSTRUCTIONS.descriptionFormat,
    blogDescriptionInstructions: DEFAULT_BLOG_INSTRUCTIONS.descriptionInstructions,
    blogHandleFormat: DEFAULT_BLOG_INSTRUCTIONS.handleFormat,
    blogHandleInstructions: DEFAULT_BLOG_INSTRUCTIONS.handleInstructions,
    blogSeoTitleFormat: DEFAULT_BLOG_INSTRUCTIONS.seoTitleFormat,
    blogSeoTitleInstructions: DEFAULT_BLOG_INSTRUCTIONS.seoTitleInstructions,
    blogMetaDescFormat: DEFAULT_BLOG_INSTRUCTIONS.metaDescFormat,
    blogMetaDescInstructions: DEFAULT_BLOG_INSTRUCTIONS.metaDescInstructions,

    // Pages
    pageTitleFormat: DEFAULT_PAGE_INSTRUCTIONS.titleFormat,
    pageTitleInstructions: DEFAULT_PAGE_INSTRUCTIONS.titleInstructions,
    pageDescriptionFormat: DEFAULT_PAGE_INSTRUCTIONS.descriptionFormat,
    pageDescriptionInstructions: DEFAULT_PAGE_INSTRUCTIONS.descriptionInstructions,
    pageHandleFormat: DEFAULT_PAGE_INSTRUCTIONS.handleFormat,
    pageHandleInstructions: DEFAULT_PAGE_INSTRUCTIONS.handleInstructions,
    pageSeoTitleFormat: DEFAULT_PAGE_INSTRUCTIONS.seoTitleFormat,
    pageSeoTitleInstructions: DEFAULT_PAGE_INSTRUCTIONS.seoTitleInstructions,
    pageMetaDescFormat: DEFAULT_PAGE_INSTRUCTIONS.metaDescFormat,
    pageMetaDescInstructions: DEFAULT_PAGE_INSTRUCTIONS.metaDescInstructions,

    // Policies
    policyDescriptionFormat: DEFAULT_POLICY_INSTRUCTIONS.descriptionFormat,
    policyDescriptionInstructions: DEFAULT_POLICY_INSTRUCTIONS.descriptionInstructions,
  };

  return defaultMap[key] || "";
}

/**
 * Get character limit requirements for a field based on its aiInstructionsKey.
 * Used to inject length constraints into AI prompts.
 */
export function getCharacterLimitRequirement(aiInstructionsKey: string): string | null {
  const limits: Record<string, string> = {
    // Titles: 30-70 characters
    productTitle: "30-70 characters",
    collectionTitle: "30-70 characters",
    blogTitle: "30-70 characters",
    pageTitle: "30-70 characters",

    // Descriptions: minimum 150 characters
    productDescription: "minimum 150 characters",
    collectionDescription: "minimum 150 characters",
    blogDescription: "minimum 150 characters",
    pageDescription: "minimum 150 characters",
    policyDescription: "minimum 150 characters",

    // SEO Titles: max 60 characters
    productSeoTitle: "maximum 60 characters",
    collectionSeoTitle: "maximum 60 characters",
    blogSeoTitle: "maximum 60 characters",
    pageSeoTitle: "maximum 60 characters",

    // Meta Descriptions: 120-160 characters
    productMetaDesc: "120-160 characters",
    collectionMetaDesc: "120-160 characters",
    blogMetaDesc: "120-160 characters",
    pageMetaDesc: "120-160 characters",

    // URL Handles (slugs): 50-70 characters
    productHandle: "50-70 characters",
    collectionHandle: "50-70 characters",
    blogHandle: "50-70 characters",
    pageHandle: "50-70 characters",

    // Alt Text: 100-125 characters (optimal for screen readers)
    productAltText: "100-125 characters",
  };

  return limits[aiInstructionsKey] || null;
}

/**
 * Convenience helper to get writing style instructions with default fallback.
 * This is the most commonly used instruction that should ALWAYS be included in prompts.
 *
 * @param dbInstructions - AI instructions object from database (can be null)
 * @returns Writing style instructions (from DB or default)
 */
export function getWritingStyleInstructions(
  dbInstructions: AIInstructions | Record<string, string | null> | null
): string {
  return getInstructionWithDefault(dbInstructions, "writingStyleInstructions");
}

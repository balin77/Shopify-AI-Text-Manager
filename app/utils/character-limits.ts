/**
 * Character limit requirements for AI-generated content fields.
 * Used by api.ai.tsx and unified-content.actions.ts to enforce field length constraints.
 */

/**
 * Returns a human-readable character limit requirement for a given field key,
 * or null if no limit applies.
 */
export function getCharacterLimitRequirement(aiInstructionsKey: string, seoTitleMaxChars = 60): string | null {
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

    // SEO Titles: adjusted for shop name suffix
    productSeoTitle: `maximum ${seoTitleMaxChars} characters`,
    collectionSeoTitle: `maximum ${seoTitleMaxChars} characters`,
    blogSeoTitle: `maximum ${seoTitleMaxChars} characters`,
    pageSeoTitle: `maximum ${seoTitleMaxChars} characters`,

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

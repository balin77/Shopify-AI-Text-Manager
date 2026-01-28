/**
 * Field Definitions for Content Types
 *
 * Defines the editable fields for each content type
 */

import type { ContentEditorConfig } from "../types/content-editor.types";
import { createTemplateFieldDefinitions, getTemplateFieldValue } from "../utils/templates-field-factory";

// ============================================================================
// PRODUCTS
// ============================================================================

export const PRODUCTS_CONFIG: ContentEditorConfig = {
  contentType: "products",
  resourceType: "Product",
  displayName: "Products",
  displayNameSingular: "Product",
  showSeoSidebar: true,
  idPrefix: "ID:",

  fieldDefinitions: [
    // Product Images (rendered by FieldRenderer with type: "image-gallery")
    {
      key: "images",
      type: "image-gallery",
      label: "Product Images",
      translationKey: "images", // Alt-texts are translated
      supportsAI: true,
      supportsTranslation: true,
      aiInstructionsKey: "productAltText",
    },
    // Title
    {
      key: "title",
      type: "text",
      label: "Product Title",
      translationKey: "title",
      required: true,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productTitle",
      helpText: (value) => `${(value || '').length} characters`,
    },
    // Product Type
    {
      key: "productType",
      type: "text",
      label: "Product Type",
      translationKey: "product_type",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: true,
      helpText: () => "Category for filtering (e.g. T-Shirt, Shoes)",
    },
    // Description
    {
      key: "description",
      type: "html",
      label: "Description",
      translationKey: "body_html",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productDescription",
    },
    // Handle (URL slug)
    {
      key: "handle",
      type: "slug",
      label: "URL Handle",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productHandle",
    },
    // SEO Title
    {
      key: "seoTitle",
      type: "text",
      label: "SEO Title",
      translationKey: "meta_title",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productSeoTitle",
      helpText: (value) => `${(value || '').length} characters (recommended: 50-60)`,
    },
    // Meta Description
    {
      key: "metaDescription",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productMetaDesc",
      helpText: (value) => `${(value || '').length} characters (recommended: 150-160)`,
    },
  ],
};

// ============================================================================
// COLLECTIONS
// ============================================================================

export const COLLECTIONS_CONFIG: ContentEditorConfig = {
  contentType: "collections",
  resourceType: "Collection",
  displayName: "Collections",
  displayNameSingular: "Collection",
  showSeoSidebar: true,
  idPrefix: "ID:",

  fieldDefinitions: [
    {
      key: "title",
      type: "text",
      label: "Title",
      translationKey: "title",
      required: true,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionTitle",
      helpText: (value) => `${(value || '').length} characters`,
    },
    {
      key: "description",
      type: "html",
      label: "Description",
      translationKey: "body_html",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionDescription",
    },
    {
      key: "handle",
      type: "slug",
      label: "URL Slug",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionHandle",
    },
    {
      key: "seoTitle",
      type: "text",
      label: "SEO Title",
      translationKey: "meta_title",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionSeoTitle",
      helpText: (value) => `${(value || '').length} characters (recommended: 50-60)`,
    },
    {
      key: "metaDescription",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionMetaDesc",
      helpText: (value) => `${(value || '').length} characters (recommended: 150-160)`,
    },
  ],
};

// ============================================================================
// BLOGS (ARTICLES)
// ============================================================================

export const BLOGS_CONFIG: ContentEditorConfig = {
  contentType: "blogs",
  resourceType: "Article",
  displayName: "Articles",
  displayNameSingular: "Article",
  showSeoSidebar: true,
  idPrefix: "ID:",
  getSubtitle: (item) => item.blogTitle,

  fieldDefinitions: [
    {
      key: "title",
      type: "text",
      label: "Title",
      translationKey: "title",
      required: true,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "blogTitle",
      helpText: (value) => `${(value || '').length} characters`,
    },
    {
      key: "body",
      type: "html",
      label: "Body",
      translationKey: "body",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "blogDescription",
    },
    {
      key: "handle",
      type: "slug",
      label: "URL Slug",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "blogHandle",
    },
    {
      key: "seoTitle",
      type: "text",
      label: "SEO Title",
      translationKey: "meta_title",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "blogSeoTitle",
      helpText: (value) => `${(value || '').length} characters (recommended: 50-60)`,
    },
    {
      key: "metaDescription",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "blogMetaDesc",
      helpText: (value) => `${(value || '').length} characters (recommended: 150-160)`,
    },
  ],
};

// ============================================================================
// PAGES
// ============================================================================

export const PAGES_CONFIG: ContentEditorConfig = {
  contentType: "pages",
  resourceType: "Page",
  displayName: "Pages",
  displayNameSingular: "Page",
  showSeoSidebar: false,
  idPrefix: "ID:",

  fieldDefinitions: [
    {
      key: "title",
      type: "text",
      label: "Title",
      translationKey: "title",
      required: true,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageTitle",
      helpText: (value) => `${(value || '').length} characters`,
    },
    {
      key: "body",
      type: "html",
      label: "Body",
      translationKey: "body_html",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageDescription",
    },
    {
      key: "handle",
      type: "slug",
      label: "URL Slug",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageHandle",
    },
  ],
};

// ============================================================================
// POLICIES
// ============================================================================

export const POLICIES_CONFIG: ContentEditorConfig = {
  contentType: "policies",
  resourceType: "ShopPolicy",
  displayName: "Policies",
  displayNameSingular: "Policy",
  showSeoSidebar: false,
  idPrefix: "ID:",
  getPrimaryField: (item) => item.title || getPolicyTypeName(item.type),
  getSubtitle: (item) => getPolicyTypeName(item.type),

  fieldDefinitions: [
    {
      key: "body",
      type: "html",
      label: "Body",
      translationKey: "body",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "policyDescription",
    },
  ],
};

// ============================================================================
// TEMPLATES (THEME CONTENT)
// ============================================================================

export const TEMPLATES_CONFIG: ContentEditorConfig = {
  contentType: "templates",
  resourceType: "OnlineStoreTheme",
  displayName: "Theme Content",
  displayNameSingular: "Theme Group",
  showSeoSidebar: false,
  idPrefix: "Group:",
  getPrimaryField: (item) => item.title || item.groupName,
  getSubtitle: (item) => `${item.contentCount || 0} translatable fields`,

  // Templates use dynamic fields - this is just a fallback
  fieldDefinitions: [],

  // Enable dynamic field generation
  dynamicFields: true,

  // Generate field definitions from item's translatableContent
  getFieldDefinitions: (item) => createTemplateFieldDefinitions(item?.translatableContent),

  // Custom value getter for template data structure
  getFieldValue: (item, fieldKey) => getTemplateFieldValue(item, fieldKey),
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getPolicyTypeName(type: string | undefined): string {
  if (!type) return "";
  const typeMap: Record<string, string> = {
    CONTACT_INFORMATION: "Kontaktinformationen",
    LEGAL_NOTICE: "Impressum",
    PRIVACY_POLICY: "Datenschutzerklärung",
    REFUND_POLICY: "Rückerstattungsrichtlinie",
    SHIPPING_POLICY: "Versandrichtlinie",
    TERMS_OF_SERVICE: "Nutzungsbedingungen",
    TERMS_OF_SALE: "Verkaufsbedingungen",
    SUBSCRIPTION_POLICY: "Abonnementrichtlinie",
  };
  return typeMap[type] || type;
}

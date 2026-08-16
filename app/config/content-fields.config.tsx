/**
 * Field Definitions for Content Types
 *
 * Defines the editable fields for each content type
 */

import type { ContentEditorConfig, FieldDefinition } from "../types/content-editor.types";
import type { MetaobjectEntry } from "../utils/contentEditor.utils";
import { createTemplateFieldDefinitions, getTemplateFieldValue } from "../utils/templates-field-factory";
import { isMetaobjectLabelField } from "../constants/shopifyFields";

// ============================================================================
// PRODUCTS
// ============================================================================

export const PRODUCTS_CONFIG: ContentEditorConfig = {
  contentType: "products",
  // PLAN_CONTENT_CREATION §1.1 — what the "+" button offers on this tab.
  createSupport: { resources: ["product"] },
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
    // Product Type
    {
      key: "productType",
      type: "text",
      label: "Product Type",
      translationKey: "product_type",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: true,
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
    },
  ],
};

// ============================================================================
// COLLECTIONS
// ============================================================================

export const COLLECTIONS_CONFIG: ContentEditorConfig = {
  contentType: "collections",
  createSupport: { resources: ["collection"] },
  resourceType: "Collection",
  displayName: "Collections",
  displayNameSingular: "Collection",
  showSeoSidebar: true,
  idPrefix: "ID:",

  fieldDefinitions: [
    {
      key: "images",
      type: "image-gallery",
      label: "Featured Image",
      translationKey: "images",
      supportsAI: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionAltText",
    },
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
    },
  ],
};

// ============================================================================
// BLOGS (ARTICLES + BLOG CONTAINERS)
// ============================================================================

/** Field definitions for Blog containers (title, handle, SEO) */
const BLOG_CONTAINER_FIELDS: FieldDefinition[] = [
  {
    key: "title",
    type: "text",
    label: "Blog Title",
    translationKey: "title",
    required: true,
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogTitle",
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
  },
];

/** Field definitions for Articles (full set) */
const ARTICLE_FIELDS: FieldDefinition[] = [
  {
    key: "images",
    type: "image-gallery",
    label: "Featured Image",
    translationKey: "images",
    supportsAI: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogAltText",
  },
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
  },
  {
    key: "body",
    type: "html",
    label: "Body",
    translationKey: "body_html",
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogDescription",
  },
  {
    key: "summary",
    type: "html",
    label: "Excerpt",
    translationKey: "summary_html",
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogSummary",
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
  },
];

export const BLOGS_CONFIG: ContentEditorConfig = {
  contentType: "blogs",
  // Two creatable resources on one tab: an article, and the blog it lives in.
  createSupport: { resources: ["article", "blog"] },
  resourceType: "Article",
  displayName: "Articles & Blogs",
  displayNameSingular: "Article",
  showSeoSidebar: true,
  idPrefix: "ID:",
  dynamicFields: true,

  // Return Blog-specific or Article-specific fields based on the selected item
  getFieldDefinitions: (item) => {
    if (item?.isBlogContainer) {
      return BLOG_CONTAINER_FIELDS;
    }
    return ARTICLE_FIELDS;
  },

  // Show "Blog" subtitle for blog containers to distinguish them from articles
  getSubtitle: (item) => {
    if (item?.isBlogContainer) {
      return "Blog";
    }
    return undefined;
  },

  // Default field definitions (used when no item is selected)
  fieldDefinitions: ARTICLE_FIELDS,
};

// ============================================================================
// PAGES
// ============================================================================

export const PAGES_CONFIG: ContentEditorConfig = {
  contentType: "pages",
  createSupport: { resources: ["page"] },
  resourceType: "Page",
  displayName: "Pages",
  displayNameSingular: "Page",
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
      aiInstructionsKey: "pageTitle",
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
    {
      key: "seoTitle",
      type: "text",
      label: "SEO Title",
      translationKey: "meta_title",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageSeoTitle",
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
      aiInstructionsKey: "pageMetaDesc",
    },
  ],
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getPolicyTypeName(type: string | undefined, t?: import("~/i18n/de").Translation): string {
  if (!type) return "";
  const pt = t?.content?.policyTypes;
  const typeMap: Record<string, string> = {
    CONTACT_INFORMATION: pt?.contactInformation || "Contact Information",
    LEGAL_NOTICE: pt?.legalNotice || "Legal Notice",
    PRIVACY_POLICY: pt?.privacyPolicy || "Privacy Policy",
    REFUND_POLICY: pt?.refundPolicy || "Refund Policy",
    SHIPPING_POLICY: pt?.shippingPolicy || "Shipping Policy",
    TERMS_OF_SERVICE: pt?.termsOfService || "Terms of Service",
    TERMS_OF_SALE: pt?.termsOfSale || "Terms of Sale",
    SUBSCRIPTION_POLICY: pt?.subscriptionPolicy || "Subscription Policy",
  };
  return typeMap[type] || type;
}

// ============================================================================
// POLICIES
// ============================================================================

export const POLICIES_CONFIG: ContentEditorConfig = {
  contentType: "policies",
  // No createSupport on purpose (§2.6): a shop has exactly six policies and
  // Shopify has no create API for them.
  resourceType: "ShopPolicy",
  displayName: "Policies",
  displayNameSingular: "Policy",
  showSeoSidebar: false,
  idPrefix: "ID:",
  getPrimaryField: (item, t) => item.title || getPolicyTypeName(item.type, t),
  getSubtitle: (item, t) => getPolicyTypeName(item.type, t),

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
// THEME-CONTENT DOMAIN RUBRICS (System / Online-Store-Extras / Selling-Plans)
// These share the Templates dynamic-field machinery — same shape, only the
// contentType (plan gate) and display labels differ.
// ============================================================================

export const SYSTEM_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "system",
  displayName: "System",
  displayNameSingular: "System Content",
};

export const DELIVERY_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "delivery",
  displayName: "Versand & Zustellung",
  displayNameSingular: "Delivery Method",
};

export const ONLINE_STORE_EXTRAS_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "onlineStoreExtras",
  displayName: "Filter",
  displayNameSingular: "Filter",
};

// Shop-Metadaten: same dynamic-field machinery and plan gate as Filter
// (onlineStoreExtras). Backed by the same online_store_extras domain, restricted
// to the SHOP resource type by its route loader.
export const SHOP_METADATA_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "onlineStoreExtras",
  displayName: "Shop-Metadaten",
  displayNameSingular: "Shop metadata",
};

export const SELLING_PLANS_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "sellingPlans",
  displayName: "Abo-Pläne",
  displayNameSingular: "Selling Plan",
};

// Cookie-Banner: same dynamic-field machinery as Templates. Plan gate reuses
// onlineStoreExtras (every tier — Plan §7.5). Resource is read from Shopify's
// `unstable` COOKIE_BANNER enum during sync; the editor is unaware of that.
export const COOKIE_BANNER_CONFIG: ContentEditorConfig = {
  ...TEMPLATES_CONFIG,
  contentType: "onlineStoreExtras",
  displayName: "Cookie-Banner",
  displayNameSingular: "Cookie banner",
};

// ============================================================================
// METAOBJECTS
// ============================================================================

export const METAOBJECTS_CONFIG: ContentEditorConfig = {
  contentType: "metaobjects",
  // Entries only — read_metaobject_definitions does not allow new DEFINITIONS,
  // and only definitions whose required fields are plain text are offered (§1.5).
  createSupport: { resources: ["metaobject"] },
  resourceType: "Metaobject",
  displayName: "Metaobjects",
  displayNameSingular: "Metaobject Type",
  showSeoSidebar: false,
  idPrefix: "Type:",
  getPrimaryField: (item) => item.title || item.definitionName || "Untitled",
  getSubtitle: (item) => {
    const count = item.contentCount ?? item.metaobjects?.length ?? 0;
    return `${count} ${count === 1 ? 'entry' : 'entries'}`;
  },

  // Metaobjects use dynamic fields - one field per metaobject entry
  fieldDefinitions: [],

  // Enable dynamic field generation
  dynamicFields: true,

  // Generate field definitions: One field per metaobject (showing only display_name/name)
  getFieldDefinitions: (item) => {
    if (!item?.metaobjects || !Array.isArray(item.metaobjects)) return [];

    // Create one field per metaobject, showing only the display_name/name
    return (item.metaobjects as MetaobjectEntry[]).map((metaobj) => {
      // Find the display_name or name field
      const labelField = metaobj.fields?.find((f) => isMetaobjectLabelField(f.key));

      return {
        key: metaobj.id, // Use metaobject ID as field key
        type: "text" as const,
        label: metaobj.displayName || metaobj.handle || metaobj.id.split('/').pop() || metaobj.id,
        translationKey: metaobj.id, // Must match the translation key in translations array
        required: false,
        supportsAI: false,
        supportsFormatting: false,
        supportsTranslation: true,
        helpText: `Metaobject: ${metaobj.handle || metaobj.id.split('/').pop()}`,
      };
    });
  },

  // Custom value getter: Get display_name value for each metaobject
  getFieldValue: (item, fieldKey) => {
    if (!item?.metaobjects || !Array.isArray(item.metaobjects)) return "";

    // fieldKey is the metaobject ID
    const metaobj = (item.metaobjects as MetaobjectEntry[]).find((m) => m.id === fieldKey);
    if (!metaobj) return "";

    // Find the label field value
    const labelField = metaobj.fields?.find((f) => isMetaobjectLabelField(f.key));

    return labelField?.value || metaobj.displayName || "";
  },
};

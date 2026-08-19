/**
 * Field Definitions for Content Types
 *
 * Defines the editable fields for each content type
 */

import type { ContentEditorConfig, FieldDefinition } from "../types/content-editor.types";
import type { MetaobjectEntry } from "../utils/contentEditor.utils";
import { createTemplateFieldDefinitions, getTemplateFieldValue } from "../utils/templates-field-factory";
import { ColorFieldEditor } from "../components/metaobjects/ColorFieldEditor";
import { MetaobjectFileField } from "../components/metaobjects/MetaobjectFileField";
import { MetaobjectRichTextField } from "../components/metaobjects/MetaobjectRichTextField";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
import { CREATE_PRODUCT_STATUSES, COLLECTION_SORT_ORDERS } from "./create-fields.config";
import {
  metaobjectFieldValueFor,
  isTranslatableMetaobjectFieldType,
  metaobjectFieldSpecs,
  type MetaobjectDefinitionFieldLike,
  type MetaobjectEntryLike,
} from "../services/metaobject-fields.shared";

// ============================================================================
// PLAN_CONTENT_CREATION §Phase 3 — merchandising attributes
// ============================================================================
//
// These are the fields the §2.2 attribute checklist points at: its rows carry a
// `jumpToField` naming exactly these keys, so the checklist stops being a list
// of findings the merchant cannot act on.
//
// Every one of them is marked `supportsTranslation: false`. Shopify stores one
// value per item, not one per locale (`FIELD_TO_TRANSLATION_KEY` is the list of
// what IS translatable and none of these are on it), so a foreign locale gets a
// read-only control with an explanation. Left editable they would take the
// merchant's input and write it to the primary value — a save that looks like
// it worked and quietly changed the wrong thing.
//
// `productType` is deliberately NOT in this group: it is translatable, shop-wide,
// through GroupedFieldTranslation, and must keep going that way.
//
// `translationKey: ""` marks "has no Shopify translation key at all". The
// editor's change-detection walks `translationKey` to decide which translations
// a primary edit invalidates; an empty one drops out of that walk, which is
// exactly right for a field that has none.

const ATTRIBUTE_LABELS = {
  status: "Status",
  vendor: "Vendor",
  tags: "Tags",
  author: "Author",
  sortOrder: "Sort order",
  templateSuffix: "Theme template",
  isPublished: "Visible in the online store",
  category: "Product category",
  collections: "Collections",
  commerce: "Sales channels",
} as const;

/** Shared by products and articles — same control, different suggestion pool. */
function tagsField(suggestionsKey: "productTags" | "articleTags"): FieldDefinition {
  return {
    key: "tags",
    type: "tags",
    label: ATTRIBUTE_LABELS.tags,
    detailsSection: "organization",
    translationKey: "",
    supportsAI: false,
    supportsFormatting: false,
    supportsTranslation: false,
    suggestionsKey,
  };
}

/** Every type has one; the value is a theme file suffix, not a display name. */
const TEMPLATE_SUFFIX_FIELD: FieldDefinition = {
  key: "templateSuffix",
  type: "text",
  label: ATTRIBUTE_LABELS.templateSuffix,
  detailsSection: "theme",
  translationKey: "",
  supportsAI: false,
  supportsFormatting: false,
  supportsTranslation: false,
  helpText: "Empty = the theme's default template.",
};

/** Pages and articles are published or not; products use the four-value status. */
const IS_PUBLISHED_FIELD: FieldDefinition = {
  key: "isPublished",
  type: "toggle",
  label: ATTRIBUTE_LABELS.isPublished,
  translationKey: "",
  supportsAI: false,
  supportsFormatting: false,
  supportsTranslation: false,
  toggleLabels: { on: "Visible", off: "Hidden" },
};

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
  showItemSidebar: true,
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
      card: "searchEngine",
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
      card: "searchEngine",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productMetaDesc",
    },
    // Handle (URL slug)
    {
      key: "handle",
      card: "searchEngine",
      type: "slug",
      label: "URL Handle",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "productHandle",
    },
    // ── §Phase 3 merchandising attributes ──────────────────────────────────
    {
      key: "status",
      type: "select",
      label: ATTRIBUTE_LABELS.status,
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
      // All FOUR values (§2.3). UNLISTED exists in real catalogues and code
      // that enumerates three is what made unlisted products invisible to
      // several features in this app already.
      options: CREATE_PRODUCT_STATUSES.map((value) => ({ value, label: value })),
      // §2.3 — status and sales channels are separate things, and merchants
      // routinely assume otherwise. Until Phase 4 adds publications, this note
      // is the only place that says so.
      attributeNote:
        "Active does not by itself mean visible — a product also needs a sales channel. Manage channels in the Shopify admin.",
    },
    {
      // Phase 4 — the sales channels. Price and stock USED to sit here too;
      // they describe a VARIANT, so they moved into the variants card, next to
      // the options that say which variant is which. What is left is a property
      // of the product itself: which channels it is published to.
      //
      // NOT part of the content save's value map: it loads live and writes
      // through its own endpoint, so a volatile number never travels in the
      // editor's flat value map where it would be stale by the time the
      // merchant pressed save. It still rides the editor's ONE save bar.
      //
      // No `detailsSection`: with the price gone it was the only field in the
      // commerce subcard, and the panel already draws its own "Sales channels"
      // heading — a subcard around it would say the same word twice.
      key: "commerce",
      type: "commerce",
      label: ATTRIBUTE_LABELS.commerce,
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
    },
    {
      key: "vendor",
      type: "text",
      label: ATTRIBUTE_LABELS.vendor,
      detailsSection: "organization",
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
    },
    {
      // §Phase 3.1 — Shopify's product taxonomy. Not a free-text field: the
      // value is a TaxonomyCategory GID, and a wrong one fails at the schema
      // level, which never reaches `userErrors`.
      key: "category",
      type: "taxonomy",
      label: ATTRIBUTE_LABELS.category,
      detailsSection: "organization",
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
      attributeNote:
        "Shopify uses the category for tax rates and for marketplace listings. Choosing a specific type beats a broad branch.",
    },
    {
      // §Phase 3.1 — membership. Written as a JOIN/LEAVE diff against the
      // cache, never as a list: a product can belong to collections whose rows
      // this shop never cached, and a full-list write would drop them.
      key: "collections",
      type: "collections",
      label: ATTRIBUTE_LABELS.collections,
      detailsSection: "organization",
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
      attributeNote:
        "Rule-based collections are managed by their own rules — removing the product here would not stick.",
    },
    tagsField("productTags"),
    TEMPLATE_SUFFIX_FIELD,
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
  showItemSidebar: true,
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
      key: "seoTitle",
      card: "searchEngine",
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
      card: "searchEngine",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionMetaDesc",
    },
    {
      key: "handle",
      card: "searchEngine",
      type: "slug",
      label: "URL Slug",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "collectionHandle",
    },
    // ── §Phase 3 merchandising attributes ──────────────────────────────────
    {
      // §Phase 3.1 — the rule editor for an EXISTING collection. Not gated on
      // the plan but on the API VERSION: `sources[]` exists from 2026-07 on,
      // and below that the builder renders its own explanation rather than a
      // control that cannot work. `translationKey: ""` keeps it out of every
      // translation path, like the other attributes.
      key: "collectionRules",
      type: "collectionRules",
      label: "Automatic collection rules",
      detailsSection: "organization",
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
    },
    {
      key: "sortOrder",
      type: "select",
      label: ATTRIBUTE_LABELS.sortOrder,
      detailsSection: "organization",
      translationKey: "",
      supportsAI: false,
      supportsFormatting: false,
      supportsTranslation: false,
      options: COLLECTION_SORT_ORDERS.map((value) => ({ value, label: value })),
    },
    TEMPLATE_SUFFIX_FIELD,
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
    key: "seoTitle",
    card: "searchEngine",
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
    card: "searchEngine",
    type: "textarea",
    label: "Meta Description",
    translationKey: "meta_description",
    multiline: 3,
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogMetaDesc",
  },
  {
    key: "handle",
    card: "searchEngine",
    type: "slug",
    label: "URL Slug",
    translationKey: "handle",
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogHandle",
  },
  // A blog container's one merchandising attribute. Without it the write path
  // (`attributeInputFor("Blog", …)`) and the mutation's `templateSuffix` echo
  // would be code no surface can reach.
  TEMPLATE_SUFFIX_FIELD,
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
    key: "seoTitle",
    card: "searchEngine",
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
    card: "searchEngine",
    type: "textarea",
    label: "Meta Description",
    translationKey: "meta_description",
    multiline: 3,
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogMetaDesc",
  },
  {
    key: "handle",
    card: "searchEngine",
    type: "slug",
    label: "URL Slug",
    translationKey: "handle",
    supportsAI: true,
    supportsFormatting: true,
    supportsTranslation: true,
    aiInstructionsKey: "blogHandle",
  },
  // ── §Phase 3 merchandising attributes ────────────────────────────────────
  {
    key: "author",
    type: "text",
    label: ATTRIBUTE_LABELS.author,
    detailsSection: "organization",
    translationKey: "",
    supportsAI: false,
    supportsFormatting: false,
    supportsTranslation: false,
    // Not merely a gap: `ArticleCreateInput.author` is REQUIRED, so an article
    // cannot exist without one — which makes an empty value here a sign the
    // item predates the attribute sync, not a merchant choice.
    required: true,
  },
  tagsField("articleTags"),
  IS_PUBLISHED_FIELD,
  TEMPLATE_SUFFIX_FIELD,
];

export const BLOGS_CONFIG: ContentEditorConfig = {
  contentType: "blogs",
  // Two creatable resources on one tab: an article, and the blog it lives in.
  createSupport: { resources: ["article", "blog"] },
  resourceType: "Article",
  displayName: "Articles & Blogs",
  displayNameSingular: "Article",
  showItemSidebar: true,
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
  showItemSidebar: true,
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
      key: "seoTitle",
      card: "searchEngine",
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
      card: "searchEngine",
      type: "textarea",
      label: "Meta Description",
      translationKey: "meta_description",
      multiline: 3,
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageMetaDesc",
    },
    {
      key: "handle",
      card: "searchEngine",
      type: "slug",
      label: "URL Slug",
      translationKey: "handle",
      supportsAI: true,
      supportsFormatting: true,
      supportsTranslation: true,
      aiInstructionsKey: "pageHandle",
    },
    // ── §Phase 3 merchandising attributes ──────────────────────────────────
    IS_PUBLISHED_FIELD,
    TEMPLATE_SUFFIX_FIELD,
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
  showItemSidebar: false,
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
  showItemSidebar: false,
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
  showItemSidebar: false,
  idPrefix: "Type:",
  getPrimaryField: (item) => item.title || item.definitionName || "Untitled",
  getSubtitle: (item) => {
    const count = item.contentCount ?? item.metaobjects?.length ?? 0;
    return `${count} ${count === 1 ? 'entry' : 'entries'}`;
  },

  // Metaobjects use dynamic fields — one field per ENTRY x FIELD (§6.1).
  fieldDefinitions: [],

  // Enable dynamic field generation
  dynamicFields: true,

  /**
   * One control per editable field of every loaded entry.
   *
   * The key is `<Metaobject GID>#<field key>` and NOT the bare GID it used to
   * be: a bare GID can only ever address one field, which is why this page
   * could edit nothing but the label. The GID stays in FRONT because the
   * server recognises a metaobject form field by that prefix.
   *
   * `groupId` is the entry's GID, so the editor renders one CARD per entry
   * instead of a flat wall of inputs whose labels ("Label", "Colour", "Label",
   * …) would repeat with nothing saying which entry they belong to.
   *
   * `translationKey` is EMPTY for a colour or a file reference. Those have one
   * value per shop, and `resolve()` short-circuits an empty translation key to
   * the primary value — sent down the foreign chain instead they would resolve
   * to "" and the next save in a foreign locale would clear them. Same rule as
   * the merchandising attributes, same reason.
   */
  getFieldDefinitions: (item) => {
    if (!item?.metaobjects || !Array.isArray(item.metaobjects)) return [];
    const definitionFields = (item as { fieldDefinitions?: MetaobjectDefinitionFieldLike[] })
      .fieldDefinitions;

    const filePreviews =
      (item as { filePreviews?: Record<string, string> }).filePreviews ?? {};

    return (item.metaobjects as MetaobjectEntry[]).flatMap((metaobj) => {
      const entryTitle =
        metaobj.displayName || metaobj.handle || metaobj.id.split("/").pop() || metaobj.id;
      return metaobjectFieldSpecs(metaobj as MetaobjectEntryLike, definitionFields)
        // `unsupported` fields get NO control — the card names them with their
        // type instead, because a field that silently disappears looks like a
        // bug while one with a reason is an explanation (§6.1).
        .filter((spec) => spec.role !== "unsupported")
        .map((spec): FieldDefinition => ({
          key: spec.compoundKey,
          groupId: metaobj.id,
          type: spec.role === "textarea" ? ("textarea" as const) : ("text" as const),
          label: spec.label,
          translationKey: isTranslatableMetaobjectFieldType(spec.fieldType) ? spec.compoundKey : "",
          required: spec.required === true,
          supportsAI: false,
          supportsFormatting: false,
          supportsTranslation: isTranslatableMetaobjectFieldType(spec.fieldType),
          multiline: spec.role === "textarea" ? 4 : undefined,
          helpText:
            spec.role === "list"
              ? `${entryTitle} — separate values with |`
              : spec.role === "richText"
                ? `${entryTitle} — rich text, read-only here`
                : entryTitle,
          // Three types need their own control rather than a text box. The
          // closure is built HERE because this is the only place that has both
          // the field's Shopify type and the item's cached file previews.
          renderField:
            spec.role === "color"
              ? (props) => <ColorFieldEditor {...props} />
              : spec.role === "file"
                ? (props) => (
                    <MetaobjectFileField {...props} previewUrl={filePreviews[props.value] } />
                  )
                : spec.role === "richText"
                  ? (props) => <MetaobjectRichTextField {...props} />
                  : undefined,
        }));
    });
  },

  /**
   * The value of ONE field of ONE entry, addressed by the compound key.
   *
   * A bare metaobject GID (what an older client sends) resolves to the entry's
   * label field, so a stale tab shows the right text instead of an empty one —
   * the SAVE path refuses that shape rather than guessing, which is where the
   * guess would actually cost something.
   */
  getFieldValue: (item, fieldKey) =>
    metaobjectFieldValueFor(
      item?.metaobjects as MetaobjectEntryLike[] | undefined,
      (item as { fieldDefinitions?: MetaobjectDefinitionFieldLike[] })?.fieldDefinitions,
      fieldKey,
      isMetaobjectLabelField,
    ),
};

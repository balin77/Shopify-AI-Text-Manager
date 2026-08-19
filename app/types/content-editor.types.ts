/**
 * Unified Content Editor Types
 *
 * Shared types for the unified content editor system
 */

import type { FetcherWithComponents } from "react-router";
import type { Translation as I18nTranslation } from "~/i18n/de";
import type { ValidationOverlays } from "~/utils/field-validation.utils";
import type { DetailsSectionId } from "~/config/details-sections";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

// ============================================================================
// SHOP & LOCALE TYPES
// ============================================================================

export interface ShopLocale {
  locale: string;
  primary: boolean;
  name?: string;
}

export interface Translation {
  key: string;
  locale: string;
  value: string;
}

/**
 * A Shopify market, plus the locales it serves on its storefront. Used by the
 * market-specific translation feature ("Translate & Adapt"): a translation may
 * target one market so the same locale can differ per market.
 */
export interface MarketInfo {
  /** gid://shopify/Market/<id> — sent as TranslationInput.marketId */
  id: string;
  name: string;
  handle: string;
  /** locales this market offers (default + alternate web-presence locales) */
  localeCodes: string[];
}

/**
 * Market translations loaded from the DB, keyed for O(1) lookup in resolve():
 *   marketTranslations[marketId][translationKey][locale] = value
 * Only non-global rows (marketId !== "") are included; the global layer stays in
 * item.translations as before.
 */
export type MarketTranslations = Record<
  string,
  Record<string, Record<string, string>>
>;

// ============================================================================
// IMAGE TYPES
// ============================================================================

export interface AltTextTranslation {
  locale: string;
  altText: string;
  /** Market scope ("" / undefined = global). Non-empty = market-specific alt text. */
  marketId?: string;
}

export interface ContentImage {
  url: string;
  altText?: string;
  altTextTranslations?: AltTextTranslation[];
}

// ============================================================================
// CONTENT ITEM TYPES
// ============================================================================

export interface TranslatableContentItem {
  id: string;
  title?: string;
  descriptionHtml?: string;
  body?: string;
  summary?: string; // For articles (excerpt)
  handle?: string;
  seo?: { title?: string | null; description?: string | null } | null;
  translations: Translation[];
  images?: ContentImage[];
  translatableContent?: Array<{ key: string; value: string }>;
  // Additional properties for specific content types
  blogTitle?: string; // For articles
  isBlogContainer?: boolean; // True for Blog items (vs Article items) in the blog editor
  type?: string; // For policies
  groupName?: string; // For templates
  contentCount?: number; // For templates
  featuredImage?: ContentImage; // For products
  productType?: string; // For products
  displayName?: string; // For metaobjects
  definitionName?: string; // For metaobjects
  fields?: Array<{ key: string; value: string | null; type?: string }>; // For metaobjects
  metaobjects?: Array<{ id: string; handle?: string; displayName?: string; fields?: Array<{ key: string; value: string | null }> }>; // For metaobject types
  options?: Array<{
    id: string;           // gid://shopify/ProductOption/...
    name: string;
    position: number;
    values: Array<{ id: string; name: string; linked?: boolean; linkedValue?: string }>;  // ProductOptionValue GIDs; linkedValue = the metaobject GID behind a linked value
    isLinked?: boolean;   // true = metaobject-linked (values translated via Metaobjects, not here)
    /** The linked METAFIELD's `namespace--key` (e.g. "shopify--color-pattern"),
     *  NOT the metaobject definition type. The two are spelled alike only for
     *  Shopify's standard definitions; for a custom option (`custom--stoff` over
     *  the definition `stoff`) they differ, which is why the metaobjects page
     *  strips the namespace before matching and prefers a linked entry GID. */
    linkedMetafieldKey?: string;
  }>;
  metafields?: Array<{
    id: string;           // gid://shopify/Metafield/...
    namespace: string;
    key: string;
    value: string;
    type: string;
  }>;
  /** Pre-loaded sub-resource translations from DB (options, option values, metafields) */
  subResourceTranslations?: Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>>;
  /** Market-specific translations (marketId → translationKey → locale → value). Global rows stay in `translations`. */
  marketTranslations?: MarketTranslations;
}

// ============================================================================
// FETCHER RESPONSE TYPES
// ============================================================================

export type ActionType =
  | "loadTranslations"
  | "generateAIText"
  | "formatAIText"
  | "translateField"
  | "translateAll"
  | "translateAllForLocale"
  | "translateFieldToAllLocales"
  | "updateContent"
  | "generateAltText"
  | "generateAllAltTexts"
  | "translateAltText"
  | "translateAltTextToAllLocales";

export interface FetcherDataBase {
  success: boolean;
  actionType?: ActionType;
  error?: string;
  failedLocales?: string[];
  rejectedFields?: Record<string, string[]>;
  skippedFields?: Record<string, string[]>;
  failedAltTextIndices?: number[];
}

export interface GeneratedContentResponse extends FetcherDataBase {
  generatedContent: string;
  fieldType: string;
}

export interface TranslatedValueResponse extends FetcherDataBase {
  translatedValue: string;
  fieldType: string;
  targetLocale: string;
}

export interface TranslationsResponse extends FetcherDataBase {
  translations: Record<string, string | Record<string, string>>;
  fieldType?: string;
  targetLocale?: string;
}

export interface AltTextResponse extends FetcherDataBase {
  altText: string;
  imageIndex: number;
}

export interface BulkAltTextsResponse extends FetcherDataBase {
  generatedAltTexts: Record<number, string>;
}

export interface TranslatedAltTextResponse extends FetcherDataBase {
  translatedAltText: string;
  imageIndex: number;
}

export interface TranslatedAltTextsResponse extends FetcherDataBase {
  translatedAltTexts: Record<string, string>;
  targetLocales: string[];
  imageIndex: number;
}

export type FetcherData =
  | FetcherDataBase
  | GeneratedContentResponse
  | TranslatedValueResponse
  | TranslationsResponse
  | AltTextResponse
  | BulkAltTextsResponse
  | TranslatedAltTextResponse
  | TranslatedAltTextsResponse;

// ============================================================================
// TRANSLATION STRINGS TYPE
// ============================================================================

// Recursive so i18n blocks may nest beyond a single level (e.g. the SEO tab's
// `seo.sections.<id>.label` and `seo.dashboard.problems.*`). Only used as the
// loose structural target for TranslationStrings; the precise per-locale type
// remains `typeof de` (Translation), so this never weakens real key checking.
// `string[]` because some blocks are genuinely lists — e.g. the per-embed
// activation steps in settings, which are numbered in the UI and must stay one
// translatable unit rather than step1/step2/step3 keys.
export type TranslationValue = string | string[] | { [key: string]: TranslationValue } | undefined;

export interface HelpContent {
  title: string;
  summary: string;
  details?: string;
  tips?: string[];
  examples?: string[];
}

export interface TranslationStrings {
  common?: {
    success?: string;
    error?: string;
    warning?: string;
    changesSaved?: string;
    noContentToFormat?: string;
    noTargetLanguagesSelected?: string;
    noTargetLanguagesEnabled?: string;
    fieldTranslatedToLanguages?: string;
    fieldTranslatedAndSaved?: string;
    translatedSuccessfully?: string;
    copied?: string;
    copiedToShopify?: string;
    [key: string]: TranslationValue;
  };
  content?: {
    noSourceText?: string;
    altTextTranslatedToAllLocales?: string;
    policyTypes?: Record<string, string>;
    [key: string]: TranslationValue;
  };
  help?: Record<string, HelpContent>;
  [key: string]: Record<string, TranslationValue> | Record<string, HelpContent> | undefined;
}

export type ContentType = 'products' | 'collections' | 'blogs' | 'pages' | 'policies' | 'templates' | 'metaobjects' | 'directTranslations' | 'menus' | 'system' | 'delivery' | 'sellingPlans' | 'onlineStoreExtras';

/**
 * `select`, `tags` and `toggle` are the PLAN_CONTENT_CREATION §Phase 3
 * merchandising attributes. They differ from every type above them in one way
 * that runs through the whole editor: they are NOT translatable. Shopify stores
 * one value per item, not one per locale (`FIELD_TO_TRANSLATION_KEY` lists what
 * is translatable, and none of these are on it), so in a foreign locale they
 * render read-only with an explanation rather than looking editable and then
 * silently writing the primary value.
 */
export type FieldType =
  | 'text' | 'html' | 'slug' | 'textarea' | 'number' | 'image-gallery' | 'options'
  | 'select' | 'tags' | 'toggle' | 'money' | 'collectionRules'
  // §Phase 3.1 — two lookups the cache cannot answer alone. `taxonomy` is
  // Shopify's own ~10k-node category tree (searched live); `collections` is
  // the shop's collection list, read from this app's own cache.
  | 'taxonomy' | 'collections'
  // Phase 4 — stock per location and sales channels. Its own type because it
  // loads LIVE and saves through its own endpoint: stock is volatile, so a
  // number carried in the editor's flat value map would be stale by the time
  // the merchant pressed save.
  | 'commerce';

/**
 * One dynamic field handed to a page's `renderFieldGroup`.
 *
 * The rendered node alone would force the page to place controls by POSITION.
 * The definition lets it pick one out by key, and the live value lets it paint
 * something beside the control while the merchant is still typing.
 */
export interface RenderedGroupField {
  field: FieldDefinition;
  /** What the editor currently holds for it — not what the item stores. */
  value: string;
  node: React.ReactNode;
}

export interface FieldRenderProps {
  value: string;
  onChange: (value: string) => void;
  field: FieldDefinition;
  disabled?: boolean;
  /**
   * The editor's own read-only verdict — theme content in the primary locale,
   * an app-embed technical field, or a metaobject definition Shopify does not
   * let this app write (§7.2). A custom renderer that ignores it presents an
   * editable control whose save can only fail, which is what the flag exists
   * to prevent.
   */
  readOnly?: boolean;
  suggestion?: string;
  isPrimaryLocale?: boolean;
  isTranslated?: boolean;
  isLoading?: boolean;
  sourceTextAvailable?: boolean;
  /** Receives the merchant's ad-hoc instruction from the AIInstructionPrompt box (undefined = generate as before). */
  onGenerateAI?: (userInstruction?: string) => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onCopy?: () => void;
  onCopyToAllLocales?: () => void;
  onAcceptSuggestion?: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion?: () => void;
  htmlMode?: 'html' | 'rendered';
  onToggleHtmlMode?: () => void;
  shopLocales?: ShopLocale[];
  currentLanguage?: string;
  t?: TranslationStrings;
}

/**
 * Which card a field renders in.
 *
 * `searchEngine` collects the three fields Shopify's own admin groups under
 * "Search engine listing" (SEO title, meta description, URL handle) into a
 * card of their own, below the item's text. Everything else defaults to the
 * main content card; merchandising attributes are routed separately by
 * `isAttributeField`, from their marks rather than from this one.
 */
export type FieldCard = 'main' | 'searchEngine';

export interface FieldDefinition {
  /** Unique key for this field */
  key: string;

  /** Which card this field renders in (default: "main") */
  card?: FieldCard;

  /**
   * Merchandising attributes only: which SUBCARD of the Details card this
   * field sits in. Consecutive fields sharing a section fold into one subcard
   * (see config/details-sections.ts); with fewer than two sections the card
   * renders flat, as it did before.
   */
  detailsSection?: DetailsSectionId;

  /** Field type determines the UI component */
  type: FieldType;

  /** Display label */
  label: string;

  /** Translation key used in Shopify API */
  translationKey: string;

  /**
   * Dynamic fields only: which CARD this field belongs to.
   *
   * The metaobjects tab builds one field per entry x definition field, and a
   * flat list of them repeats every label ("Label", "Colour", "Label", ...)
   * with nothing saying which entry it belongs to. Fields sharing a groupId
   * are handed to the page's `renderFieldGroup` as one group; without one the
   * editor renders the fields exactly as it always did.
   */
  groupId?: string;

  /** Optional help text */
  helpText?: string | ((value: string) => string);

  /** Whether this field is required */
  required?: boolean;

  /** Whether this field supports AI generation */
  supportsAI?: boolean;

  /** Whether this field supports formatting */
  supportsFormatting?: boolean;

  /** Whether this field supports translation */
  supportsTranslation?: boolean;

  /** Number of rows for textarea */
  multiline?: number;

  /** Custom validation function */
  validate?: (value: string) => string | null;

  /** Custom field-specific AI instructions key */
  aiInstructionsKey?: string;

  /** Optional: Custom render function for special field types */
  renderField?: (props: FieldRenderProps) => React.ReactNode;

  // ── PLAN_CONTENT_CREATION §Phase 3 — merchandising attributes ─────────────

  /** `select` only. `labelKey` resolves under `t.content.fieldOptions`, with
   *  `label` as the fallback so a missing translation degrades to English
   *  rather than to a raw enum value. */
  options?: Array<{ value: string; labelKey?: string; label: string }>;

  /** `tags` only: suggestions for the autocomplete, gathered from the shop. */
  suggestionsKey?: 'productTags' | 'articleTags';

  /** `toggle` only: what the two states mean, e.g. published vs. hidden. */
  toggleLabels?: { on: string; off: string };

  /** Rendered under the control — for the things a merchant cannot see, like
   *  "Active does not mean visible without a sales channel" (§2.3). */
  attributeNote?: string;

  /** `money` only: the shop currency, shown as a suffix. Currency is shop-wide,
   *  never per field — the same rule the bulk editor's money columns follow. */
  currencyCode?: string;
}

export interface ContentEditorConfig {
  /** Type of content being edited */
  contentType: ContentType;

  /** Field definitions for this content type */
  fieldDefinitions: FieldDefinition[];

  /** Resource type for Shopify API */
  resourceType: string;

  /** Display name (plural) */
  displayName: string;

  /** Display name (singular) */
  displayNameSingular: string;

  /** Whether to show SEO sidebar */
  showItemSidebar?: boolean;

  /**
   * PLAN_CONTENT_CREATION §1.1/§2.6 — which resource the "+" button creates.
   *
   * A FLAG per config, not a global default, because create is impossible on
   * several tabs and for different reasons: policies are a fixed set of six
   * with no create API, the whole theme-content family has no creatable
   * resources at all. Leaving it unset is how those tabs say so.
   *
   * `blogs` is the one tab with TWO creatable resources (the blog container
   * and an article inside it), which is why this is a list.
   */
  createSupport?: {
    /** Offered in the create menu, in this order. */
    resources: Array<"product" | "collection" | "page" | "article" | "blog" | "metaobject">;
    /**
     * Also offer creating from the EDITOR's action bar, not only from the "+"
     * above the item list.
     *
     * Set where the item list does not list the thing that gets created. On
     * the metaobjects tab the list holds TYPES ("Color", "Material") while
     * create makes an ENTRY, so a "+" above that list reads as "add a type" --
     * which this app cannot do at all, and which is why merchants looked at
     * an open type and found no way to add anything to it. The action bar sits
     * above the entry cards, i.e. above the things that actually appear.
     *
     * Everywhere else the list holds the created thing and the "+" is already
     * in the right place; a second button there would be noise.
     */
    fromActionBar?: boolean;
  };

  /** Custom primary field getter (t is optional for i18n support) */
  getPrimaryField?: (item: TranslatableContentItem, t?: I18nTranslation) => string | undefined;

  /** Custom subtitle field getter (for list items, t is optional for i18n support) */
  getSubtitle?: (item: TranslatableContentItem, t?: I18nTranslation) => string | undefined;

  /** ID prefix for display */
  idPrefix?: string;

  /** Whether this content type uses dynamic fields (e.g., templates) */
  dynamicFields?: boolean;

  /** Function to generate field definitions dynamically from an item */
  getFieldDefinitions?: (item: TranslatableContentItem) => FieldDefinition[];

  /** Custom function to get field value from item (for non-standard data structures) */
  getFieldValue?: (item: TranslatableContentItem, fieldKey: string) => string;

  /** Lazy loading configuration */
  lazyLoading?: {
    /** Whether lazy loading is enabled */
    enabled: boolean;
    /** Function to load item data on demand. Returns the loaded item data. */
    loadItem?: (itemId: string) => Promise<TranslatableContentItem>;
    /** Key to extract item ID for loading (e.g., "groupId" for templates) */
    itemIdKey?: string;
  };
}

/** @deprecated Use TranslatableContentItem instead */
export type ContentItem = TranslatableContentItem;

/** @deprecated Use TranslatableContentItem instead */
export type TranslatableItem = TranslatableContentItem;

export interface EditorState {
  selectedItemId: string | null;
  currentLanguage: string;
  /** Selected market ("" = all markets / global). */
  selectedMarketId: string;
  /** Markets available for the current shop (empty → market selector hidden). */
  markets: MarketInfo[];
  editableValues: Record<string, string>;
  aiSuggestions: Record<string, string>;
  htmlModes: Record<string, 'html' | 'rendered'>;
  hasChanges: boolean;
  enabledLanguages: string[];
  imageAltTexts: Record<number, string>;
  /** Image indices whose alt text is a market-inherited (global) fallback. */
  fallbackAltTextIndices: Set<number>;
  altTextSuggestions: Record<number, string>;
  isClearAllModalOpen: boolean;
  isInitialDataReady: boolean;
  isLoadingData: boolean; // True when loading translations/data for a selected item
  isLoadingImages?: boolean; // True when loading images on-demand from Shopify
  fallbackFields: Set<string>; // Fields showing fallback values (e.g., handle with primary locale value)
  loadingFieldKeys: Set<string>; // Fields with AI actions currently running (for per-field loading states)
  sendImageToAI: boolean; // When enabled, sends images to vision-capable AI models
  selectedImageIndex: number; // Currently selected/viewed image index in products
  images: ContentImage[]; // All images for the current item
  featuredImage: ContentImage | null; // Featured image (for collections/blogs/products)
  isSavingCurrentItem: boolean; // True only when fetcher is saving the currently-selected item (not a previously-selected one)
  fieldErrors: Record<string, string>; // Per-field AI error messages (e.g. "text too long")
}

export interface EditorHandlers {
  handleSave: () => void;
  handleDiscard: () => void;
  handleGenerateAI: (fieldKey: string, userInstruction?: string) => void;
  handleFormatAI: (fieldKey: string) => void;
  /** Work the active language's tracked keywords into every field missing them. */
  handleInsertKeywords: () => void;
  /** True while that multi-field run is in flight. */
  isInsertingKeywords: boolean;
  handleTranslateField: (fieldKey: string) => void;
  handleTranslateFieldToAllLocales: (fieldKey: string) => void;
  handleCopyField: (fieldKey: string) => void;
  handleCopyFieldToAllLocales: (fieldKey: string) => void;
  handleTranslateAll: () => void;
  handleAcceptSuggestion: (fieldKey: string) => void;
  handleAcceptAndTranslate: (fieldKey: string) => void;
  handleRejectSuggestion: (fieldKey: string) => void;
  handleLanguageChange: (locale: string) => void;
  handleMarketChange: (marketId: string) => void;
  handleToggleLanguage: (locale: string) => void;
  handleItemSelect: (itemId: string) => void;
  handleValueChange: (fieldKey: string, value: string) => void;
  handleToggleHtmlMode: (fieldKey: string) => void;
  handleClearField: (fieldKey: string) => void;
  handleClearAllClick: () => void;
  handleClearAllConfirm: () => void;
  handleClearAllCancel: () => void;
  handleClearAllForLocaleClick: () => void;
  handleClearAllForLocaleConfirm: () => void;
  handleTranslateAllForLocale: () => void;
  handleAltTextChange: (imageIndex: number, value: string) => void;
  handleGenerateAltText: (imageIndex: number, userInstruction?: string) => void;
  handleGenerateAllAltTexts: () => void;
  handleCopyAltText: (imageIndex: number) => void;
  handleCopyAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAllAltTexts: () => void;
  handleTranslateAllAltTextsForLocale: () => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
  handleToggleSendImageToAI: () => void;
  setSelectedImageIndex: (index: number) => void;
}

export interface UseContentEditorProps {
  /** Content editor configuration */
  config: ContentEditorConfig;

  /** Array of items to edit */
  items: TranslatableContentItem[];

  /** Shop locales */
  shopLocales: ShopLocale[] | any[];

  /** Primary locale */
  primaryLocale: string;

  /** Markets for the "Translate & Adapt" market selector (optional; [] hides it).
   *  Loosened like shopLocales to absorb Remix's loader-serialization types. */
  markets?: MarketInfo[] | any[];

  /** Fetcher from useFetcher() */
  fetcher: FetcherWithComponents<FetcherData>;

  /** ShowInfoBox function */
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;

  /** Translation strings object */
  t: TranslationStrings;

  /** Optional callback when translateFieldToAllLocales completes successfully */
  onTranslateToAllLocalesComplete?: (fieldKey: string, translations: Record<string, string>) => void;

  /** Optional initial item ID to select on mount (e.g. from URL params) */
  initialItemId?: string;

  /**
   * Optional locale to open in, from `?locale=xx` on a deep link (the SEO
   * dashboard links here with the locale it was showing). Ignored unless it is
   * a published foreign locale of this shop — an unknown or stale code falls
   * back to the primary language rather than opening an empty editor.
   */
  initialLocale?: string;
}

export interface UseContentEditorReturn {
  /** Current editor state */
  state: EditorState;

  /** Event handlers */
  handlers: EditorHandlers;

  /** Currently selected item */
  selectedItem: ContentItem | null;

  /** Helper functions */
  helpers: {
    getFieldBackgroundColor: (fieldKey: string) => string;
    isFieldTranslated: (fieldKey: string) => boolean;
    getEditableValue: (fieldKey: string) => string;
    setEditableValue: (fieldKey: string, value: string) => void;
    setOriginalTemplateValues: (values: Record<string, string>) => void;
    /** Atomically replace all editable + original values for templates (used after reload) */
    reloadTemplateValues: (values: Record<string, string>) => void;
    /** Trigger a data refresh to reload editableValues from fresh data (used by ReloadButton) */
    triggerDataRefresh: () => void;
    /** Check if a specific field is currently loading */
    isFieldLoading: (fieldKey: string, action?: string) => boolean;
    /** Snapshot of current overlay refs for overlay-aware validation (reads refs at call time) */
    getValidationOverlays: () => ValidationOverlays;
    /** Increments whenever overlays change — use as useMemo dependency to trigger recomputation */
    validationVersion: number;
  };

  /** Effective field definitions (dynamic for templates, static for other content types) */
  effectiveFieldDefinitions: FieldDefinition[];

  /** Focus management for accessibility */
  focusManagement: {
    firstFieldRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
    setItemFocus: (itemId: string) => void;
  };
}

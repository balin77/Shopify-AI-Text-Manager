/**
 * Unified Content Editor Types
 *
 * Shared types for the unified content editor system
 */

import type { FetcherWithComponents } from "@remix-run/react";

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

// ============================================================================
// IMAGE TYPES
// ============================================================================

export interface AltTextTranslation {
  locale: string;
  altText: string;
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
  handle?: string;
  seo?: { title?: string | null; description?: string | null } | null;
  translations: Translation[];
  images?: ContentImage[];
  translatableContent?: Array<{ key: string; value: string }>;
  // Additional properties for specific content types
  blogTitle?: string; // For articles
  type?: string; // For policies
  groupName?: string; // For templates
  contentCount?: number; // For templates
  featuredImage?: ContentImage; // For products
}

// ============================================================================
// FETCHER RESPONSE TYPES
// ============================================================================

export interface FetcherDataBase {
  success: boolean;
  error?: string;
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

export type TranslationValue = string | Record<string, string> | undefined;

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
    translatedSuccessfully?: string;
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

export type ContentType = 'products' | 'collections' | 'blogs' | 'pages' | 'policies' | 'templates';

export type FieldType = 'text' | 'html' | 'slug' | 'textarea' | 'number' | 'image-gallery' | 'options';

export interface FieldRenderProps {
  value: string;
  onChange: (value: string) => void;
  field: FieldDefinition;
  disabled?: boolean;
  suggestion?: string;
  isPrimaryLocale?: boolean;
  isTranslated?: boolean;
  isLoading?: boolean;
  sourceTextAvailable?: boolean;
  onGenerateAI?: () => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onAcceptSuggestion?: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion?: () => void;
  htmlMode?: 'html' | 'rendered';
  onToggleHtmlMode?: () => void;
  shopLocales?: ShopLocale[];
  currentLanguage?: string;
  t?: TranslationStrings;
}

export interface FieldDefinition {
  /** Unique key for this field */
  key: string;

  /** Field type determines the UI component */
  type: FieldType;

  /** Display label */
  label: string;

  /** Translation key used in Shopify API */
  translationKey: string;

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
  showSeoSidebar?: boolean;

  /** Custom primary field getter */
  getPrimaryField?: (item: TranslatableContentItem) => string | undefined;

  /** Custom subtitle field getter (for list items) */
  getSubtitle?: (item: TranslatableContentItem) => string | undefined;

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

export interface EditorState {
  selectedItemId: string | null;
  currentLanguage: string;
  editableValues: Record<string, string>;
  aiSuggestions: Record<string, string>;
  htmlModes: Record<string, 'html' | 'rendered'>;
  hasChanges: boolean;
  enabledLanguages: string[];
  imageAltTexts: Record<number, string>;
  altTextSuggestions: Record<number, string>;
  isClearAllModalOpen: boolean;
  isInitialDataReady: boolean;
  isLoadingImages?: boolean; // True when loading images on-demand from Shopify
  fallbackFields: Set<string>; // Fields showing fallback values (e.g., handle with primary locale value)
  loadingFieldKeys: Set<string>; // Fields with AI actions currently running (for per-field loading states)
}

export interface EditorHandlers {
  handleSave: () => void;
  handleDiscard: () => void;
  handleGenerateAI: (fieldKey: string) => void;
  handleFormatAI: (fieldKey: string) => void;
  handleTranslateField: (fieldKey: string) => void;
  handleTranslateFieldToAllLocales: (fieldKey: string) => void;
  handleTranslateAll: () => void;
  handleAcceptSuggestion: (fieldKey: string) => void;
  handleAcceptAndTranslate: (fieldKey: string) => void;
  handleRejectSuggestion: (fieldKey: string) => void;
  handleLanguageChange: (locale: string) => void;
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
  handleGenerateAltText: (imageIndex: number) => void;
  handleGenerateAllAltTexts: () => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
}

export interface UseContentEditorProps {
  /** Content editor configuration */
  config: ContentEditorConfig;

  /** Array of items to edit */
  items: TranslatableContentItem[];

  /** Shop locales */
  shopLocales: ShopLocale[];

  /** Primary locale */
  primaryLocale: string;

  /** Fetcher from useFetcher() */
  fetcher: FetcherWithComponents<FetcherData>;

  /** ShowInfoBox function */
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;

  /** Translation strings object */
  t: TranslationStrings;

  /** Optional callback when translateFieldToAllLocales completes successfully */
  onTranslateToAllLocalesComplete?: (fieldKey: string, translations: Record<string, string>) => void;
}

export interface UseContentEditorReturn {
  /** Current editor state */
  state: EditorState;

  /** Event handlers */
  handlers: EditorHandlers;

  /** Currently selected item */
  selectedItem: ContentItem | null;

  /** Navigation guard utilities */
  navigationGuard: {
    pendingNavigation: (() => void) | null;
    highlightSaveButton: boolean;
    saveButtonRef: React.RefObject<HTMLDivElement | null>;
    handleNavigationAttempt: (callback: () => void, hasChanges: boolean) => void;
    clearPendingNavigation: () => void;
  };

  /** Helper functions */
  helpers: {
    getFieldBackgroundColor: (fieldKey: string) => string;
    isFieldTranslated: (fieldKey: string) => boolean;
    getEditableValue: (fieldKey: string) => string;
    setEditableValue: (fieldKey: string, value: string) => void;
    setOriginalTemplateValues: (values: Record<string, string>) => void;
  };

  /** Effective field definitions (dynamic for templates, static for other content types) */
  effectiveFieldDefinitions: FieldDefinition[];
}

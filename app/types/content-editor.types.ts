/**
 * Unified Content Editor Types
 *
 * Shared types for the unified content editor system
 */

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

export type ContentType = 'products' | 'collections' | 'blogs' | 'pages' | 'policies' | 'templates';

export type FieldType = 'text' | 'html' | 'slug' | 'textarea' | 'number' | 'image-gallery' | 'options';

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
  renderField?: (props: any) => React.ReactNode;
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
  getPrimaryField?: (item: any) => string;

  /** Custom subtitle field getter (for list items) */
  getSubtitle?: (item: any) => string;

  /** ID prefix for display */
  idPrefix?: string;

  /** Whether this content type uses dynamic fields (e.g., templates) */
  dynamicFields?: boolean;

  /** Function to generate field definitions dynamically from an item */
  getFieldDefinitions?: (item: any) => FieldDefinition[];

  /** Custom function to get field value from item (for non-standard data structures) */
  getFieldValue?: (item: any, fieldKey: string) => string;

  /** Lazy loading configuration */
  lazyLoading?: {
    /** Whether lazy loading is enabled */
    enabled: boolean;
    /** Function to load item data on demand. Returns the loaded item data. */
    loadItem?: (itemId: string) => Promise<any>;
    /** Key to extract item ID for loading (e.g., "groupId" for templates) */
    itemIdKey?: string;
  };
}

export interface ContentItem {
  id: string;
  [key: string]: any;
}

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
  items: ContentItem[];

  /** Shop locales */
  shopLocales: any[];

  /** Primary locale */
  primaryLocale: string;

  /** Fetcher from useFetcher() */
  fetcher: any;

  /** ShowInfoBox function */
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;

  /** Translation function */
  t: any;
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
  };

  /** Effective field definitions (dynamic for templates, static for other content types) */
  effectiveFieldDefinitions: FieldDefinition[];
}

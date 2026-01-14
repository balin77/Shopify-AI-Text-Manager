/**
 * Unified Content Editor Types
 *
 * Shared types for the unified content editor system
 */

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

export type ContentType = 'products' | 'collections' | 'blogs' | 'pages' | 'policies';

export type FieldType = 'text' | 'html' | 'slug' | 'textarea' | 'number';

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
  handleRejectSuggestion: (fieldKey: string) => void;
  handleLanguageChange: (locale: string) => void;
  handleItemSelect: (itemId: string) => void;
  handleValueChange: (fieldKey: string, value: string) => void;
  handleToggleHtmlMode: (fieldKey: string) => void;
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
}

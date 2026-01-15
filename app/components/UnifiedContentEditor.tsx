/**
 * Unified Content Editor Layout
 *
 * Generic layout component for all content types (collections, blogs, pages, policies)
 * Based on the products page structure with all bug fixes included.
 */

import { Page, Card, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";
import { UnifiedItemList } from "./unified/UnifiedItemList";
import { UnifiedLanguageBar } from "./unified/UnifiedLanguageBar";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { OptionsField } from "./unified/OptionsField";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { SeoSidebar } from "./SeoSidebar";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { usePlan } from "../contexts/PlanContext";
import { contentEditorStyles } from "../utils/contentEditor.utils";
import type { ContentEditorConfig, UseContentEditorReturn, FieldDefinition } from "../types/content-editor.types";
import type { UnifiedItem } from "./unified/UnifiedItemList";

interface UnifiedContentEditorProps {
  /** Configuration for this content type */
  config: ContentEditorConfig;

  /** Items to display in the list */
  items: any[];

  /** Shop locales */
  shopLocales: any[];

  /** Primary locale */
  primaryLocale: string;

  /** Return value from useUnifiedContentEditor hook */
  editor: UseContentEditorReturn;

  /** Fetcher state */
  fetcherState: string;

  /** Fetcher form data */
  fetcherFormData: FormData | undefined;

  /** Translation function */
  t: any;

  /** Optional: Custom render for sidebar */
  renderSidebar?: (item: any, editableValues: Record<string, string>) => React.ReactNode;

  /** Optional: Custom render for list item */
  renderListItem?: (item: any, isSelected: boolean) => React.ReactNode;
}

export function UnifiedContentEditor(props: UnifiedContentEditorProps) {
  const {
    config,
    items,
    shopLocales,
    primaryLocale,
    editor,
    fetcherState,
    fetcherFormData,
    t,
    renderSidebar,
    renderListItem,
  } = props;

  const { state, handlers, selectedItem, navigationGuard, helpers } = editor;
  const { getMaxProducts } = usePlan();

  // Transform items to UnifiedItem format
  const unifiedItems: UnifiedItem[] = items.map((item) => ({
    id: item.id,
    title: config.getPrimaryField ? config.getPrimaryField(item) : item.title,
    subtitle: config.getSubtitle ? config.getSubtitle(item) : undefined,
    status: item.status,
    image: item.featuredImage || item.image,
    ...item,
  }));

  // Plan limit configuration
  const maxItems = getMaxProducts(); // This works for all content types
  const planLimit = {
    isAtLimit: items.length >= maxItems && maxItems !== Infinity,
    maxItems,
    currentPlan: "current", // TODO: Get from plan context
    nextPlan: "Pro", // TODO: Get from plan context
  };

  // Default list item renderer (if custom renderListItem not provided)
  const defaultRenderListItem = (item: UnifiedItem, isSelected: boolean, isHovered: boolean) => {
    return (
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
          {item.title}
        </Text>
        {item.subtitle && (
          <Text as="p" variant="bodySm" tone="subdued">
            {item.subtitle}
          </Text>
        )}
      </BlockStack>
    );
  };

  // Default sidebar renderer
  const defaultRenderSidebar = (item: any, editableValues: Record<string, string>) => {
    if (!config.showSeoSidebar) return null;

    return (
      <SeoSidebar
        title={editableValues.title || ""}
        description={editableValues.description || editableValues.body || ""}
        handle={editableValues.handle || ""}
        seoTitle={editableValues.seoTitle || ""}
        metaDescription={editableValues.metaDescription || ""}
      />
    );
  };

  const sidebarRenderer = renderSidebar || defaultRenderSidebar;
  const { getTotalNavHeight } = useNavigationHeight();

  return (
    <Page fullWidth>
      <style>{contentEditorStyles}</style>

      <div
        style={{
          height: `calc(100vh - ${getTotalNavHeight()}px)`,
          display: "flex",
          gap: "1rem",
          padding: "1rem",
          overflow: "hidden",
        }}
      >
        {/* Left Sidebar - Unified Item List */}
        <UnifiedItemList
          items={unifiedItems}
          selectedItemId={state.selectedItemId}
          onItemSelect={handlers.handleItemSelect}
          resourceName={{
            singular: config.displayNameSingular,
            plural: config.displayName,
          }}
          renderItem={renderListItem}
          showSearch={true}
          showPagination={true}
          showStatusStripe={true}
          showThumbnails={true}
          planLimit={planLimit}
          t={{
            searchPlaceholder: t.content?.searchPlaceholder,
            paginationOf: t.content?.paginationOf || "of",
            paginationPrevious: t.content?.paginationPrevious || "Previous",
            paginationNext: t.content?.paginationNext || "Next",
          }}
        />

        {/* Middle: Content Editor */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          {selectedItem ? (
            <>
              {/* Fixed Header with Language Bar and Action Buttons */}
              <Card padding="400">
                <BlockStack gap="300">
                  {/* Unified Language Bar with Translate All */}
                  <UnifiedLanguageBar
                    shopLocales={shopLocales}
                    currentLanguage={state.currentLanguage}
                    primaryLocale={primaryLocale}
                    selectedItem={selectedItem}
                    contentType={config.contentType}
                    hasChanges={state.hasChanges}
                    onLanguageChange={handlers.handleLanguageChange}
                    enabledLanguages={state.enabledLanguages}
                    onToggleLanguage={handlers.handleToggleLanguage}
                    onTranslateAll={handlers.handleTranslateAll}
                    isTranslating={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAll"}
                    showTranslateAll={true}
                    showReloadButton={true}
                    t={{
                      primaryLocaleSuffix: t.content?.primaryLanguageSuffix || "Primary",
                      translateAll: t.content?.translateAll || "🌍 Translate All",
                      translating: t.content?.translating || "Translating...",
                    }}
                  />

                  {/* Save/Discard Buttons */}
                  <InlineStack align="end" blockAlign="center">
                    <SaveDiscardButtons
                      hasChanges={state.hasChanges}
                      onSave={handlers.handleSave}
                      onDiscard={handlers.handleDiscard}
                      highlightSaveButton={navigationGuard.highlightSaveButton}
                      saveText={t.content?.saveChanges || "Save Changes"}
                      discardText={t.content?.discardChanges || "Discard"}
                      action="updateContent"
                      fetcherState={fetcherState}
                      fetcherFormData={fetcherFormData}
                    />
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Scrollable Content Area */}
              <div style={{ flex: 1, overflowY: "auto", marginTop: "1rem" }}>
                <Card padding="600">
                  <BlockStack gap="500">
                    {/* Item ID */}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {config.idPrefix || t.content?.idPrefix || "ID:"} {selectedItem.id.split("/").pop()}
                    </Text>

                    {/* Dynamic Fields */}
                    {config.fieldDefinitions.map((field) => (
                      <FieldRenderer
                        key={field.key}
                        field={field}
                        value={helpers.getEditableValue(field.key)}
                        onChange={(value) => handlers.handleValueChange(field.key, value)}
                        suggestion={state.aiSuggestions[field.key]}
                        isPrimaryLocale={state.currentLanguage === primaryLocale}
                        isTranslated={helpers.isFieldTranslated(field.key)}
                        isLoading={fetcherState !== "idle" && fetcherFormData?.get("fieldType") === field.key}
                        sourceTextAvailable={!!getSourceText(selectedItem, field.key, primaryLocale)}
                        onGenerateAI={field.supportsAI !== false ? () => handlers.handleGenerateAI(field.key) : undefined}
                        onFormatAI={field.supportsFormatting !== false ? () => handlers.handleFormatAI(field.key) : undefined}
                        onTranslate={field.supportsTranslation !== false ? () => handlers.handleTranslateField(field.key) : undefined}
                        onTranslateToAllLocales={field.supportsTranslation !== false ? () => handlers.handleTranslateFieldToAllLocales(field.key) : undefined}
                        onAcceptSuggestion={() => handlers.handleAcceptSuggestion(field.key)}
                        onAcceptAndTranslate={() => handlers.handleAcceptAndTranslate(field.key)}
                        onRejectSuggestion={() => handlers.handleRejectSuggestion(field.key)}
                        htmlMode={state.htmlModes[field.key] || "rendered"}
                        onToggleHtmlMode={() => handlers.handleToggleHtmlMode(field.key)}
                        shopLocales={shopLocales}
                        currentLanguage={state.currentLanguage}
                        primaryLocale={primaryLocale}
                        selectedItem={selectedItem}
                        t={t}
                      />
                    ))}
                  </BlockStack>
                </Card>
              </div>
            </>
          ) : (
            <Card padding="600">
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">
                  {t.content?.selectFromList || "Select an item from the list"}
                </Text>
              </div>
            </Card>
          )}
        </div>

        {/* Right: Optional Sidebar (Fixed) */}
        {selectedItem && state.currentLanguage === primaryLocale && config.showSeoSidebar && (
          <div style={{ width: "320px", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {sidebarRenderer(selectedItem, state.editableValues)}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

// ============================================================================
// FIELD RENDERER
// ============================================================================

interface FieldRendererProps {
  field: FieldDefinition;
  value: string;
  onChange: (value: string) => void;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated: boolean;
  isLoading: boolean;
  sourceTextAvailable: boolean;
  onGenerateAI?: () => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onAcceptSuggestion: () => void;
  onAcceptAndTranslate: () => void;
  onRejectSuggestion: () => void;
  htmlMode: "html" | "rendered";
  onToggleHtmlMode: () => void;
  shopLocales: any[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: any;
  t: any;
}

function FieldRenderer(props: FieldRendererProps) {
  const {
    field,
    value,
    onChange,
    suggestion,
    isPrimaryLocale,
    isTranslated,
    isLoading,
    sourceTextAvailable,
    onGenerateAI,
    onFormatAI,
    onTranslate,
    onTranslateToAllLocales,
    onAcceptSuggestion,
    onAcceptAndTranslate,
    onRejectSuggestion,
    htmlMode,
    onToggleHtmlMode,
    shopLocales,
    currentLanguage,
    primaryLocale,
    selectedItem,
    t,
  } = props;

  // Get locale name for label
  const localeName = shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage;

  // Build label
  const label = `${field.label} (${localeName})`;

  // Build help text
  let helpText = "";
  if (typeof field.helpText === "function") {
    helpText = field.helpText(value);
  } else if (field.helpText) {
    helpText = field.helpText;
  } else if (field.type === "text" || field.type === "textarea") {
    helpText = `${value.length} ${t.content?.characters || "characters"}`;
  }

  // Render based on field type

  // Custom render function (if provided)
  if (field.renderField) {
    return field.renderField({
      field,
      value,
      onChange,
      suggestion,
      isPrimaryLocale,
      isTranslated,
      isLoading,
      sourceTextAvailable,
      onGenerateAI,
      onFormatAI,
      onTranslate,
      onTranslateToAllLocales,
      onAcceptSuggestion,
      onAcceptAndTranslate,
      onRejectSuggestion,
      htmlMode,
      onToggleHtmlMode,
      shopLocales,
      currentLanguage,
      t,
    });
  }

  // Image Gallery Field
  if (field.type === "image-gallery") {
    // Only render if images array exists (Products have images, Collections don't)
    if (!selectedItem || !selectedItem.images) {
      return null;
    }

    return (
      <ImageGalleryField
        images={selectedItem.images || []}
        currentLanguage={currentLanguage}
        primaryLocale={primaryLocale}
        shopLocales={shopLocales}
        productId={selectedItem.id}
        isPrimaryLocale={isPrimaryLocale}
        t={t}
      />
    );
  }

  // Options Field
  if (field.type === "options") {
    // Note: Options need special state handling in the editor
    // For now, return a placeholder. This will be implemented in useUnifiedContentEditor
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Options field (requires custom implementation per content type)
      </Text>
    );
  }

  // HTML Field
  if (field.type === "html") {
    return (
      <AIEditableHTMLField
        label={label}
        value={value}
        onChange={onChange}
        mode={htmlMode}
        onToggleMode={onToggleHtmlMode}
        fieldType={field.key}
        fieldKey={field.key}
        suggestion={suggestion}
        isPrimaryLocale={isPrimaryLocale}
        isTranslated={isTranslated}
        isLoading={isLoading}
        sourceTextAvailable={sourceTextAvailable}
        onGenerateAI={field.supportsAI !== false ? onGenerateAI : undefined}
        onFormatAI={field.supportsFormatting !== false ? onFormatAI : undefined}
        onTranslate={field.supportsTranslation !== false ? onTranslate : undefined}
        onTranslateToAllLocales={field.supportsTranslation !== false ? onTranslateToAllLocales : undefined}
        onAcceptSuggestion={onAcceptSuggestion}
        onAcceptAndTranslate={onAcceptAndTranslate}
        onRejectSuggestion={onRejectSuggestion}
      />
    );
  }

  // Default: Use AIEditableField for text, slug, textarea, number
  return (
    <AIEditableField
      label={label}
      value={value}
      onChange={onChange}
      fieldType={field.key}
      fieldKey={field.key}
      suggestion={suggestion}
      isPrimaryLocale={isPrimaryLocale}
      isTranslated={isTranslated}
      helpText={helpText}
      multiline={field.multiline}
      isLoading={isLoading}
      sourceTextAvailable={sourceTextAvailable}
      onGenerateAI={field.supportsAI !== false ? onGenerateAI : undefined}
      onFormatAI={field.supportsFormatting !== false ? onFormatAI : undefined}
      onTranslate={field.supportsTranslation !== false ? onTranslate : undefined}
      onTranslateToAllLocales={field.supportsTranslation !== false ? onTranslateToAllLocales : undefined}
      onAcceptSuggestion={onAcceptSuggestion}
      onAcceptAndTranslate={onAcceptAndTranslate}
      onRejectSuggestion={onRejectSuggestion}
    />
  );
}

// ============================================================================
// UTILITIES
// ============================================================================

function getSourceText(item: any, fieldKey: string, primaryLocale: string): string {
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
  };

  return fieldMappings[fieldKey] || "";
}

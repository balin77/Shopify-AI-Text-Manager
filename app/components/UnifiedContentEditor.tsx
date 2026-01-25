/**
 * Unified Content Editor Layout
 *
 * Generic layout component for all content types (collections, blogs, pages, policies)
 * Based on the products page structure with all bug fixes included.
 */

import { Page, Card, Text, BlockStack, InlineStack, Button, Modal, TextContainer } from "@shopify/polaris";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";
import { UnifiedItemList } from "./unified/UnifiedItemList";
import { UnifiedLanguageBar } from "./unified/UnifiedLanguageBar";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { OptionsField } from "./unified/OptionsField";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ReloadButton } from "./ReloadButton";
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

  /** Optional: Hide images in item list */
  hideItemListImages?: boolean;

  /** Optional: Hide status bars in item list */
  hideItemListStatusBars?: boolean;

  /** Optional: Plan limit configuration */
  planLimit?: {
    isAtLimit: boolean;
    maxItems: number;
    currentPlan: string;
    nextPlan?: string;
  };
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
    hideItemListImages = false,
    hideItemListStatusBars = false,
    planLimit,
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
  const defaultPlanLimit = {
    isAtLimit: items.length >= maxItems && maxItems !== Infinity,
    maxItems,
    currentPlan: "current", // TODO: Get from plan context
    nextPlan: "Pro", // TODO: Get from plan context
  };
  const finalPlanLimit = planLimit || defaultPlanLimit;

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

    // Calculate image alt text stats for SEO score
    const images = item.images || [];
    const totalImages = images.length;
    const imagesWithAlt = images.filter((img: any, index: number) => {
      // Check both local edits (state.imageAltTexts) and original altText
      const localAltText = state.imageAltTexts?.[index];
      const originalAltText = img.altText;
      return !!(localAltText || originalAltText);
    }).length;

    return (
      <SeoSidebar
        title={editableValues.title || ""}
        description={editableValues.description || editableValues.body || ""}
        handle={editableValues.handle || ""}
        seoTitle={editableValues.seoTitle || ""}
        metaDescription={editableValues.metaDescription || ""}
        totalImages={totalImages}
        imagesWithAlt={imagesWithAlt}
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
          showStatusStripe={!hideItemListStatusBars}
          showThumbnails={!hideItemListImages}
          planLimit={finalPlanLimit}
          t={{
            searchPlaceholder: t.content?.searchPlaceholder,
            paginationOf: t.content?.paginationOf || "of",
            paginationPrevious: t.content?.paginationPrevious || "Previous",
            paginationNext: t.content?.paginationNext || "Next",
          }}
        />

        {/* Middle: Content Editor */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: "400px" }}>
          {selectedItem ? (
            <>
              {/* Fixed Header with Language Bar and Action Buttons */}
              <Card padding="400">
                <BlockStack gap="300">
                  {/* Row 1: Language Buttons */}
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

                  {/* Row 2: Action Buttons */}
                  <InlineStack align="space-between" blockAlign="center">
                    {/* Left: Translate All + Clear All Buttons */}
                    <InlineStack gap="200">
                      {state.currentLanguage === primaryLocale ? (
                        <>
                          {/* Primary locale: Translate to ALL foreign languages */}
                          <Button
                            onClick={handlers.handleTranslateAll}
                            loading={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAll"}
                            disabled={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAll"}
                            size="slim"
                          >
                            {fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAll"
                              ? (t.content?.translating || "Translating...")
                              : (t.content?.translateAll || "🌍 Translate All")}
                          </Button>
                          <Button
                            onClick={handlers.handleClearAllClick}
                            size="slim"
                            tone="critical"
                          >
                            🗑️ {t.content?.clearAll || "Clear All"}
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* Foreign locale: Translate ONLY this locale */}
                          <Button
                            onClick={handlers.handleTranslateAllForLocale}
                            loading={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAllForLocale"}
                            disabled={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAllForLocale"}
                            size="slim"
                          >
                            {fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAllForLocale"
                              ? (t.content?.translating || "Translating...")
                              : (t.content?.translateAll || "🌍 Translate All")}
                          </Button>
                          <Button
                            onClick={handlers.handleClearAllForLocaleClick}
                            size="slim"
                            tone="critical"
                          >
                            🗑️ {t.content?.clearAll || "Clear All"}
                          </Button>
                        </>
                      )}
                    </InlineStack>

                    {/* Right: Save/Discard + Reload Buttons */}
                    <InlineStack gap="200" blockAlign="center">
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
                      <ReloadButton
                        resourceId={selectedItem.id}
                        resourceType={getResourceType(config.contentType)}
                        locale={state.currentLanguage}
                      />
                    </InlineStack>
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
                        onClear={field.key === "title" && state.currentLanguage === primaryLocale ? undefined : () => handlers.handleClearField(field.key)}
                        htmlMode={state.htmlModes[field.key] || "rendered"}
                        onToggleHtmlMode={() => handlers.handleToggleHtmlMode(field.key)}
                        shopLocales={shopLocales}
                        currentLanguage={state.currentLanguage}
                        primaryLocale={primaryLocale}
                        selectedItem={selectedItem}
                        t={t}
                        state={state}
                        handlers={handlers}
                        fetcherState={fetcherState}
                        fetcherFormData={fetcherFormData}
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

        {/* Right: Optional Sidebar (Fixed) - Hidden on narrow screens via CSS */}
        {selectedItem && state.currentLanguage === primaryLocale && config.showSeoSidebar && (
          <div className="seo-sidebar-container" style={{ width: "320px", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {sidebarRenderer(selectedItem, state.editableValues)}
            </div>
          </div>
        )}
      </div>

      {/* Clear All Confirmation Modal */}
      <Modal
        open={state.isClearAllModalOpen}
        onClose={handlers.handleClearAllCancel}
        title={t.content?.clearAllConfirmTitle || "Clear All Fields?"}
        primaryAction={{
          content: t.content?.clearAllConfirm || "Clear All",
          onAction: state.currentLanguage === primaryLocale ? handlers.handleClearAllConfirm : handlers.handleClearAllForLocaleConfirm,
          destructive: true,
        }}
        secondaryActions={[
          {
            content: t.content?.cancel || "Cancel",
            onAction: handlers.handleClearAllCancel,
          },
        ]}
      >
        <Modal.Section>
          <TextContainer>
            <Text as="p">
              {state.currentLanguage === primaryLocale
                ? (t.content?.clearAllConfirmMessage ||
                  "Are you sure you want to clear all fields? This will remove all content from the current item. You will need to save the changes to make them permanent.")
                : (t.content?.clearAllForLocaleConfirmMessage ||
                  `Are you sure you want to clear all translations for ${shopLocales.find(l => l.locale === state.currentLanguage)?.name || state.currentLanguage}? This will remove all translated content for this language. You will need to save the changes to make them permanent.`)}
            </Text>
          </TextContainer>
        </Modal.Section>
      </Modal>
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
  onClear?: () => void;
  htmlMode: "html" | "rendered";
  onToggleHtmlMode: () => void;
  shopLocales: any[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: any;
  t: any;
}

function FieldRenderer(props: FieldRendererProps & { state?: any; handlers?: any; fetcherState?: string; fetcherFormData?: FormData }) {
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
    onClear,
    htmlMode,
    onToggleHtmlMode,
    shopLocales,
    currentLanguage,
    primaryLocale,
    selectedItem,
    t,
    state,
    handlers,
    fetcherState,
    fetcherFormData,
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
    // Only render if images array exists and has items
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) {
      return null;
    }

    return (
      <ImageGalleryField
        images={selectedItem.images || []}
        featuredImage={selectedItem.featuredImage}
        currentLanguage={currentLanguage}
        primaryLocale={primaryLocale}
        isPrimaryLocale={isPrimaryLocale}
        isFreePlan={false} // TODO: Get from plan context
        altTexts={state.imageAltTexts}
        onAltTextChange={handlers.handleAltTextChange}
        onGenerateAltText={handlers.handleGenerateAltText}
        onGenerateAllAltTexts={handlers.handleGenerateAllAltTexts}
        onTranslateAltText={handlers.handleTranslateAltText}
        onTranslateAltTextToAllLocales={handlers.handleTranslateAltTextToAllLocales}
        altTextSuggestions={state.altTextSuggestions}
        onAcceptSuggestion={handlers.handleAcceptAltTextSuggestion}
        onRejectSuggestion={handlers.handleRejectAltTextSuggestion}
        onClearAltText={(imageIndex) => handlers.handleAltTextChange(imageIndex, "")}
        isFieldLoading={(index) => {
          // Check if we're loading this specific image's alt-text
          const formData = fetcherFormData;
          if (!formData) return false;
          const action = formData.get("action");
          const imageIndex = formData.get("imageIndex");
          return (
            fetcherState === "submitting" &&
            (action === "generateAltText" && imageIndex === String(index)) ||
            (action === "translateAltText" && imageIndex === String(index)) ||
            (action === "translateAltTextToAllLocales" && imageIndex === String(index)) ||
            (action === "generateAllAltTexts" && index === -1)
          );
        }}
        t={{
          image: t.products?.image || "Image",
          featuredImage: t.products?.featuredImage || "Featured Image",
          altTextForImage: t.products?.altTextForImage || "Alt-text for image",
          altTextPlaceholder: t.products?.altTextPlaceholder || "Describe the image...",
          generateAllAltTexts: t.products?.generateAllAltTexts || "Generate all alt-texts",
          onlyFeaturedImageAvailable: t.products?.onlyFeaturedImageAvailable || "Only the featured image is available in the free plan.",
          additionalImagesLocked: t.products?.additionalImagesLocked || "Additional images are locked",
          availableInBasicPlan: t.products?.availableInBasicPlan || "Available in Basic plan and above",
        }}
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

  // Determine if Clear button should be shown (hide for title in primary locale)
  const shouldShowClear = !(field.key === "title" && isPrimaryLocale);

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
        onGenerateAI={field.supportsAI !== false && isPrimaryLocale ? onGenerateAI : undefined}
        onFormatAI={field.supportsFormatting !== false && isPrimaryLocale ? onFormatAI : undefined}
        onTranslate={field.supportsTranslation !== false ? onTranslate : undefined}
        onTranslateToAllLocales={field.supportsTranslation !== false ? onTranslateToAllLocales : undefined}
        onAcceptSuggestion={onAcceptSuggestion}
        onAcceptAndTranslate={onAcceptAndTranslate}
        onRejectSuggestion={onRejectSuggestion}
        onClear={shouldShowClear ? onClear : undefined}
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
      onGenerateAI={field.supportsAI !== false && isPrimaryLocale ? onGenerateAI : undefined}
      onFormatAI={field.supportsFormatting !== false && isPrimaryLocale ? onFormatAI : undefined}
      onTranslate={field.supportsTranslation !== false ? onTranslate : undefined}
      onTranslateToAllLocales={field.supportsTranslation !== false ? onTranslateToAllLocales : undefined}
      onAcceptSuggestion={onAcceptSuggestion}
      onAcceptAndTranslate={onAcceptAndTranslate}
      onRejectSuggestion={onRejectSuggestion}
      onClear={shouldShowClear ? onClear : undefined}
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

function getResourceType(contentType: string): "product" | "collection" | "page" | "article" | "policy" {
  const resourceTypeMap: Record<string, "product" | "collection" | "page" | "article" | "policy"> = {
    blogs: "article",
    pages: "page",
    policies: "policy",
    collections: "collection",
    products: "product",
  };
  return resourceTypeMap[contentType] || contentType as any;
}

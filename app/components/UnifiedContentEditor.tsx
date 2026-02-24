/**
 * Unified Content Editor Layout
 *
 * Generic layout component for all content types (collections, blogs, pages, policies)
 * Based on the products page structure with all bug fixes included.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Page, Card, Text, BlockStack, InlineStack, Button, Modal, TextContainer, TextField, Icon, Spinner, Checkbox } from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";
import { UnifiedItemList } from "./unified/UnifiedItemList";
import { UnifiedLanguageBar } from "./unified/UnifiedLanguageBar";
import { MobileToolbar } from "./unified/MobileToolbar";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { OptionsField } from "./unified/OptionsField";
import { MetafieldsField } from "./unified/MetafieldsField";
import { ReloadButton } from "./ReloadButton";
import type { SubResourceState, SubResourceHandlers } from "../hooks/useProductSubResources";
import { HelpTooltip } from "./HelpTooltip";
import { SeoSidebar } from "./SeoSidebar";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { usePlan } from "../contexts/PlanContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { contentEditorStyles, getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { useI18n } from "../contexts/I18nContext";
import { ENABLE_THEME_PRIMARY_EDIT } from "../config/constants";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
import "../styles/UnifiedContentEditor.css";
import type { ContentEditorConfig, UseContentEditorReturn, FieldDefinition } from "../types/content-editor.types";
import type { UnifiedItem, SortOption } from "./unified/UnifiedItemList";

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

  /** Optional: Show category badges in item list (e.g., for blogs) */
  showItemListCategoryBadge?: boolean;

  /** Optional: Plan limit configuration */
  planLimit?: {
    isAtLimit: boolean;
    maxItems: number;
    currentPlan: string;
    nextPlan?: string;
  };

  /** Optional: Field pagination for templates */
  fieldPagination?: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    search: string;
  } | null;

  /** Optional: Handler for field page changes */
  onFieldPageChange?: (page: number) => void;

  /** Optional: Handler for field search */
  onFieldSearch?: (search: string) => void;

  /** Optional: Loading state for field pagination */
  isFieldsLoading?: boolean;

  /** Optional: Remix revalidator for non-destructive data reload */
  revalidator?: { state: "idle" | "loading"; revalidate: () => void };

  /** Optional: Sort options for the item list */
  sortOptions?: SortOption[];

  /** Optional: Sub-resource state (options + metafields translations) */
  subResourceState?: SubResourceState;

  /** Optional: Sub-resource handlers */
  subResourceHandlers?: SubResourceHandlers;
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
    showItemListCategoryBadge = false,
    planLimit,
    fieldPagination,
    onFieldPageChange,
    onFieldSearch,
    isFieldsLoading = false,
    revalidator,
    sortOptions,
    subResourceState,
    subResourceHandlers,
  } = props;

  // Local state for search input - synced with fieldPagination.search
  const [fieldSearchInput, setFieldSearchInput] = useState(fieldPagination?.search || "");

  // Sync local search input when fieldPagination.search changes externally (e.g. group switch)
  const prevFieldSearchRef = useRef(fieldPagination?.search || "");
  useEffect(() => {
    const serverSearch = fieldPagination?.search || "";
    if (prevFieldSearchRef.current !== serverSearch) {
      prevFieldSearchRef.current = serverSearch;
      setFieldSearchInput(serverSearch);
    }
  }, [fieldPagination?.search]);

  const { state, handlers, selectedItem, navigationGuard, helpers, effectiveFieldDefinitions } = editor;
  const { getMaxProducts } = usePlan();
  const { showInfoBox } = useInfoBox();
  const { registerItems, clearItems } = useItemSelector();

  // Combined reload handler: refresh main editor + sub-resources
  const handleReloadComplete = useCallback(() => {
    helpers.triggerDataRefresh();
    subResourceHandlers?.resetForReload?.();
  }, [helpers, subResourceHandlers]);

  // Use effective field definitions (dynamic for templates, static for other content types)
  const fieldDefinitions = effectiveFieldDefinitions || config.fieldDefinitions;

  // AI actions that should block all other AI buttons while running (for global actions like translateAll)
  // "All locales" actions block every language; "ForLocale" actions only block the targeted locale
  const ALL_LOCALES_AI_ACTIONS = [
    "translateAll",
    "translateAllAltTextsToAllLocales",
  ];
  const PER_LOCALE_AI_ACTIONS = [
    "translateAllForLocale",
    "translateAllAltTextsForLocale",
  ];

  // Check if a global AI action is currently running (affects all fields)
  // Only block buttons for the item that is actually being translated
  const currentAction = fetcherFormData?.get("action");
  const fetcherTargetLocale = fetcherFormData?.get("targetLocale") as string | null;
  const fetcherItemId = fetcherFormData?.get("itemId") as string | null;
  const isSameItem = fetcherItemId === state.selectedItemId;
  const isAllLocalesActionRunning = fetcherState !== "idle" && isSameItem && ALL_LOCALES_AI_ACTIONS.includes(currentAction as string);
  const isPerLocaleActionRunning = fetcherState !== "idle" && isSameItem
    && PER_LOCALE_AI_ACTIONS.includes(currentAction as string)
    && fetcherTargetLocale === state.currentLanguage;
  const isGlobalAIActionRunning = isAllLocalesActionRunning || isPerLocaleActionRunning;

  // Get the set of fields with loading AI actions (for per-field loading states)
  const loadingFieldKeys = state.loadingFieldKeys;

  // Translated resource names for the item list
  const resourceNames = t.content?.resourceNames || {};
  const translatedResourceName = {
    singular: resourceNames[config.contentType === "pages" ? "pageSingular" : config.displayNameSingular.toLowerCase()] || config.displayNameSingular,
    plural: resourceNames[config.contentType] || config.displayName,
  };

  // Transform items to UnifiedItem format (memoized to prevent re-render cascades)
  const unifiedItems: UnifiedItem[] = useMemo(() => items.map((item) => {
    let subtitle = config.getSubtitle ? config.getSubtitle(item, t) : undefined;
    // Translate "translatable fields" for templates
    if (config.contentType === "templates" && item.contentCount !== undefined) {
      subtitle = `${item.contentCount || 0} ${t.content?.translatableFields || "translatable fields"}`;
    }
    return {
      ...item,
      id: item.id,
      title: config.getPrimaryField ? config.getPrimaryField(item, t) : item.title,
      subtitle,
      category: item.blogTitle || item.category,
      status: item.status,
      image: item.featuredImage || item.image,
    };
  }), [items, config.getPrimaryField, config.getSubtitle, config.contentType, t]);

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

  // Stable ref for handleItemSelect to avoid re-triggering useEffect
  const handleItemSelectRef = useRef(handlers.handleItemSelect);
  handleItemSelectRef.current = handlers.handleItemSelect;

  // Register items in navbar item selector context (stable deps only)
  useEffect(() => {
    registerItems({
      items: unifiedItems,
      selectedItemId: state.selectedItemId,
      onItemSelect: (itemId: string) => handleItemSelectRef.current(itemId),
      resourceName: translatedResourceName,
      t: {
        searchPlaceholder: t.content?.searchPlaceholder,
        noResults: t.content?.noResults || "No items found",
        selectItem: t.content?.selectItem || `Select ${translatedResourceName.singular}`,
      },
    });
  }, [unifiedItems, state.selectedItemId, translatedResourceName.singular, translatedResourceName.plural]);

  // Cleanup: clear items when component unmounts
  useEffect(() => {
    return () => { clearItems(); };
  }, [clearItems]);

  return (
    <Page fullWidth>
      <style>{contentEditorStyles}</style>

      <div
        className="unified-content-editor-layout"
        style={{
          height: "100%",
          minHeight: 0,
          display: "flex",
          gap: "16px",
          padding: "16px",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        {/* Left Sidebar - Unified Item List (Desktop only via CSS) */}
        <div className="unified-item-list-container">
          <div className="desktop-only">
            <UnifiedItemList
            items={unifiedItems}
          selectedItemId={state.selectedItemId}
          onItemSelect={handlers.handleItemSelect}
          resourceName={translatedResourceName}
          renderItem={renderListItem}
          showSearch={true}
          showPagination={true}
          showStatusStripe={!hideItemListStatusBars}
          showThumbnails={!hideItemListImages}
          showCategoryBadge={showItemListCategoryBadge}
          planLimit={finalPlanLimit}
          onSyncAll={revalidator ? () => revalidator.revalidate() : undefined}
          isSyncing={revalidator?.state === "loading"}
          sortOptions={sortOptions}
          t={{
            searchPlaceholder: t.content?.searchPlaceholder,
            paginationOf: t.content?.paginationOf || "of",
            paginationPrevious: t.content?.paginationPrevious || "Previous",
            paginationNext: t.content?.paginationNext || "Next",
          }}
          />
          </div>
        </div>

        {/* Middle: Content Editor */}
        <div className="unified-editor-container" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          {selectedItem ? (
            <>

              {/* Mobile: Compact single-row toolbar (< 768px) */}
              <div className="toolbar-mobile-only">
                <MobileToolbar
                  shopLocales={shopLocales}
                  currentLanguage={state.currentLanguage}
                  primaryLocale={primaryLocale}
                  selectedItem={selectedItem}
                  contentType={config.contentType}
                  hasChanges={state.hasChanges || (subResourceState?.hasChanges ?? false)}
                  onLanguageChange={handlers.handleLanguageChange}
                  enabledLanguages={state.enabledLanguages}
                  isLoadingData={state.isLoadingData}
                  onTranslateAll={state.currentLanguage === primaryLocale ? handlers.handleTranslateAll : handlers.handleTranslateAllForLocale}
                  onClearAll={state.currentLanguage === primaryLocale ? handlers.handleClearAllClick : handlers.handleClearAllForLocaleClick}
                  onSave={() => {
                    handlers.handleSave();
                    subResourceHandlers?.saveSubResources?.();
                  }}
                  onDiscard={() => {
                    handlers.handleDiscard();
                    subResourceHandlers?.resetChanges?.();
                  }}
                  onToggleSendImageToAI={handlers.handleToggleSendImageToAI}
                  sendImageToAI={state.sendImageToAI}
                  images={state.images}
                  featuredImage={state.featuredImage}
                  fetcherState={fetcherState}
                  fetcherFormData={fetcherFormData}
                  highlightSaveButton={navigationGuard.highlightSaveButton}
                  reloadResourceId={selectedItem.id}
                  reloadResourceType={getResourceType(config.contentType)}
                  reloadLocale={state.currentLanguage}
                  onReloadComplete={handleReloadComplete}
                  revalidator={revalidator}
                  t={{
                    primaryLocaleSuffix: t.content?.primaryLanguageSuffix || "Primary",
                    translateAll: t.content?.translateAll || "🌍 Translate All",
                    translating: t.content?.translating || "Translating...",
                    clearAll: t.content?.clearAll || "Clear All",
                    save: t.content?.save || "Save",
                    discardChanges: t.content?.discardChanges || "Discard",
                    sendImageToAI: t.content?.sendImageToAI || "📷 Send image to AI",
                  }}
                />
              </div>

              {/* Desktop: Language Bar + Operation Buttons (>= 769px) */}
              <div className="toolbar-desktop-only">
                {/* Language Selection Bar */}
                <Card padding="400">
                  <UnifiedLanguageBar
                    shopLocales={shopLocales}
                    currentLanguage={state.currentLanguage}
                    primaryLocale={primaryLocale}
                    selectedItem={selectedItem}
                    contentType={config.contentType}
                    hasChanges={state.hasChanges || (subResourceState?.hasChanges ?? false)}
                    onLanguageChange={handlers.handleLanguageChange}
                    enabledLanguages={state.enabledLanguages}
                    onToggleLanguage={handlers.handleToggleLanguage}
                    onTranslateAll={handlers.handleTranslateAll}
                    isTranslating={fetcherState !== "idle" && fetcherFormData?.get("action") === "translateAll"}
                    showTranslateAll={true}
                    showReloadButton={true}
                    isLoadingData={state.isLoadingData}
                    t={{
                      primaryLocaleSuffix: t.content?.primaryLanguageSuffix || "Primary",
                      translateAll: t.content?.translateAll || "🌍 Translate All",
                      translating: t.content?.translating || "Translating...",
                    }}
                  />
                </Card>

                {/* Operation Buttons */}
                <div style={{ marginTop: "1rem" }}>
                  <Card padding="400">
                  <InlineStack align="space-between" blockAlign="center">
                    {/* Left: Translate All + Clear All Buttons */}
                    {/* Hidden for templates in primary locale when themeFilesUpsert is not enabled */}
                    <InlineStack gap="200">
                      {state.currentLanguage === primaryLocale ? (
                        <>
                          {/* Primary locale: Translate to ALL foreign languages */}
                          <Button
                            onClick={handlers.handleTranslateAll}
                            loading={isAllLocalesActionRunning}
                            disabled={isAllLocalesActionRunning}
                            size="slim"
                          >
                            {isAllLocalesActionRunning
                              ? (t.content?.translating || "Translating...")
                              : (t.content?.translateAll || "🌍 Translate All")}
                          </Button>
                          {/* Clear All: hidden for templates when primary edit is not enabled */}
                          {!(config.contentType === 'templates' && !ENABLE_THEME_PRIMARY_EDIT) && (
                            <Button
                              onClick={handlers.handleClearAllClick}
                              size="slim"
                              tone="critical"
                            >
                              🗑️ {t.content?.clearAll || "Clear All"}
                            </Button>
                          )}
                          {/* Send Image to AI checkbox - only in main language for products/collections/blogs with images */}
                          {(config.contentType === "products" || config.contentType === "collections" || config.contentType === "blogs") &&
                           (state.images?.length > 0 || state.featuredImage?.url) && (
                            <Checkbox
                              label={t.content?.sendImageToAI || "📷 Send image to AI"}
                              checked={state.sendImageToAI}
                              onChange={handlers.handleToggleSendImageToAI}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          {/* Foreign locale: Translate ONLY this locale */}
                          <Button
                            onClick={handlers.handleTranslateAllForLocale}
                            loading={isPerLocaleActionRunning || isAllLocalesActionRunning}
                            disabled={isPerLocaleActionRunning || isAllLocalesActionRunning}
                            size="slim"
                          >
                            {isPerLocaleActionRunning || isAllLocalesActionRunning
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

                    {/* Right: Save/Discard + Reload Buttons - nowrap to stay together */}
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0, flexWrap: "nowrap" }}>
                      <Button
                        onClick={() => {
                          handlers.handleDiscard();
                          subResourceHandlers?.resetChanges?.();
                        }}
                        disabled={!(state.hasChanges || (subResourceState?.hasChanges ?? false)) || fetcherState !== "idle"}
                        size="slim"
                      >
                        {t.content?.discardChanges || "Discard"}
                      </Button>
                      <div
                        style={{
                          animation: navigationGuard.highlightSaveButton ? "pulse 1.5s ease-in-out infinite" : "none",
                          borderRadius: "8px",
                        }}
                      >
                        <Button
                          variant={(state.hasChanges || (subResourceState?.hasChanges ?? false)) ? "primary" : undefined}
                          onClick={() => {
                            handlers.handleSave();
                            subResourceHandlers?.saveSubResources?.();
                          }}
                          disabled={!(state.hasChanges || (subResourceState?.hasChanges ?? false))}
                          loading={fetcherState !== "idle" && (
                            fetcherFormData?.get("action") === "updateContent" ||
                            fetcherFormData?.get("action") === "savePrimarySubResources" ||
                            fetcherFormData?.get("action") === "saveSubResourceTranslations"
                          )}
                          size="slim"
                        >
                          {t.content?.save || "Save"}
                        </Button>
                      </div>
                      <ReloadButton
                        resourceId={selectedItem.id}
                        resourceType={getResourceType(config.contentType)}
                        locale={state.currentLanguage}
                        onReloadComplete={handleReloadComplete}
                        onReloadSuccess={() => showInfoBox(t.content?.reloadSuccess || "Data reloaded successfully!", "success", t.content?.success || "Success!")}
                        revalidator={revalidator}
                      />
                      <HelpTooltip helpKey="mobileToolbarActions" position="below" />
                    </div>
                  </InlineStack>
                </Card>
                </div>
              </div>

              {/* Scrollable Content Area */}
              <div className="field-editor-area" style={{ flex: 1, overflowY: "auto", marginTop: "1rem" }}>
                <Card padding="600">
                  <BlockStack gap="500">
                    {/* Card heading for products */}
                    {config.contentType === "products" && (
                      <Text as="h2" variant="headingMd" fontWeight="bold">
                        {t.products?.productCardTitle || "Product"}
                      </Text>
                    )}
                    {/* Field Search (always visible when available) */}
                    {onFieldSearch && (
                      <div className="field-search-always-clear" style={{ outline: 'none', marginBottom: '0.5rem' }} onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onFieldSearch(fieldSearchInput);
                        }
                      }}>
                        <TextField
                          label=""
                          value={fieldSearchInput}
                          onChange={(value) => {
                            setFieldSearchInput(value);
                          }}
                          placeholder={t.content?.searchFields || "Search fields..."}
                          autoComplete="off"
                          prefix={<Icon source={SearchIcon} />}
                          clearButton
                          onClearButtonClick={() => {
                            setFieldSearchInput("");
                            onFieldSearch("");
                          }}
                          connectedRight={
                            <Button onClick={() => onFieldSearch(fieldSearchInput)} size="slim">
                              {t.content?.search || "Search"}
                            </Button>
                          }
                        />
                      </div>
                    )}

                    {/* Field Pagination Info (only when needed) */}
                    {fieldPagination && (fieldPagination.totalPages > 1 || fieldPagination.search) && (
                      <div style={{
                        padding: "0.75rem",
                        backgroundColor: "var(--p-color-bg-surface-secondary)",
                        borderRadius: "8px",
                        marginBottom: "0.5rem"
                      }}>
                        <BlockStack gap="300">
                          {/* Pagination Info & Controls */}
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.content?.showingFields || "Showing"} {((fieldPagination.page - 1) * fieldPagination.limit) + 1}-
                              {Math.min(fieldPagination.page * fieldPagination.limit, fieldPagination.totalCount)} {t.content?.of || "of"}{" "}
                              {fieldPagination.totalCount} {t.content?.fields || "fields"}
                              {fieldPagination.search && (
                                <> ({t.content?.filtered || "filtered"})</>
                              )}
                            </Text>
                            {onFieldPageChange && fieldPagination.totalPages > 1 && (
                              <InlineStack gap="200" blockAlign="center">
                                <Button
                                  icon={ChevronLeftIcon}
                                  onClick={() => onFieldPageChange(fieldPagination.page - 1)}
                                  disabled={fieldPagination.page <= 1 || isFieldsLoading}
                                  accessibilityLabel={t.content?.previousPage || "Previous page"}
                                  size="slim"
                                />
                                <Text as="span" variant="bodySm">
                                  {fieldPagination.page} / {fieldPagination.totalPages}
                                </Text>
                                <Button
                                  icon={ChevronRightIcon}
                                  onClick={() => onFieldPageChange(fieldPagination.page + 1)}
                                  disabled={fieldPagination.page >= fieldPagination.totalPages || isFieldsLoading}
                                  accessibilityLabel={t.content?.nextPage || "Next page"}
                                  size="slim"
                                />
                              </InlineStack>
                            )}
                          </InlineStack>
                        </BlockStack>
                      </div>
                    )}

                    {/* Loading indicator */}
                    {isFieldsLoading && (
                      <div style={{ display: "flex", justifyContent: "center", padding: "1rem" }}>
                        <Spinner size="small" />
                      </div>
                    )}

                    {/* Empty state for metaobject types with 0 entries */}
                    {!isFieldsLoading && config.dynamicFields && fieldDefinitions.length === 0 && selectedItem && (
                      <div style={{
                        padding: "2rem",
                        textAlign: "center",
                        color: "var(--p-color-text-subdued)",
                      }}>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {t.content?.metaobjectsNoEntries || "This metaobject type has no entries to display."}
                        </Text>
                      </div>
                    )}

                    {/* Dynamic Fields */}
                    {!isFieldsLoading && (() => {
                      // Template primary locale: read-only when themeFilesUpsert is not enabled
                      const isTemplatePrimaryReadOnly = config.contentType === 'templates'
                        && state.currentLanguage === primaryLocale
                        && !ENABLE_THEME_PRIMARY_EDIT;

                      return fieldDefinitions.map((field) => (
                        <FieldRenderer
                          key={field.key}
                          field={field}
                          value={helpers.getEditableValue(field.key)}
                          onChange={(value) => handlers.handleValueChange(field.key, value)}
                          suggestion={state.aiSuggestions[field.key]}
                          isPrimaryLocale={state.currentLanguage === primaryLocale}
                          isTranslated={helpers.isFieldTranslated(field.key)}
                          isLoading={isGlobalAIActionRunning || loadingFieldKeys.has(field.key)}
                          isDataLoading={!state.isInitialDataReady}
                          sourceTextAvailable={!!getSourceText(selectedItem, field.key, primaryLocale)}
                          disableGeneration={config.contentType === 'templates'}
                          isFallbackValue={state.fallbackFields?.has(field.key) || false}
                          readOnly={isTemplatePrimaryReadOnly}
                          onGenerateAI={isTemplatePrimaryReadOnly ? undefined : (field.supportsAI !== false ? () => handlers.handleGenerateAI(field.key) : undefined)}
                          onFormatAI={isTemplatePrimaryReadOnly ? undefined : (field.supportsFormatting !== false ? () => handlers.handleFormatAI(field.key) : undefined)}
                          onTranslate={field.supportsTranslation !== false ? () => handlers.handleTranslateField(field.key) : undefined}
                          onTranslateToAllLocales={field.supportsTranslation !== false ? () => handlers.handleTranslateFieldToAllLocales(field.key) : undefined}
                          onAcceptSuggestion={() => handlers.handleAcceptSuggestion(field.key)}
                          onAcceptAndTranslate={() => handlers.handleAcceptAndTranslate(field.key)}
                          onRejectSuggestion={() => handlers.handleRejectSuggestion(field.key)}
                          onClear={isTemplatePrimaryReadOnly ? undefined : (field.key === "title" && state.currentLanguage === primaryLocale ? undefined : () => handlers.handleClearField(field.key))}
                          htmlMode={state.htmlModes[field.key] || "rendered"}
                          onToggleHtmlMode={() => handlers.handleToggleHtmlMode(field.key)}
                          shopLocales={shopLocales}
                          currentLanguage={state.currentLanguage}
                          primaryLocale={primaryLocale}
                          selectedItem={selectedItem}
                          contentType={config.contentType}
                          t={t}
                          state={state}
                          handlers={handlers}
                          fetcherState={fetcherState}
                          fetcherFormData={fetcherFormData}
                        />
                      ));
                    })()}

                    {/* Bottom Pagination (for easier navigation after scrolling) */}
                    {fieldPagination && fieldPagination.totalPages > 1 && onFieldPageChange && !isFieldsLoading && (
                      <div style={{
                        padding: "0.75rem",
                        backgroundColor: "var(--p-color-bg-surface-secondary)",
                        borderRadius: "8px",
                        marginTop: "0.5rem"
                      }}>
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p" variant="bodySm" tone="subdued">
                            {t.content?.page || "Page"} {fieldPagination.page} {t.content?.of || "of"} {fieldPagination.totalPages}
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Button
                              icon={ChevronLeftIcon}
                              onClick={() => onFieldPageChange(fieldPagination.page - 1)}
                              disabled={fieldPagination.page <= 1}
                              accessibilityLabel={t.content?.previousPage || "Previous page"}
                              size="slim"
                            />
                            <Text as="span" variant="bodySm">
                              {fieldPagination.page} / {fieldPagination.totalPages}
                            </Text>
                            <Button
                              icon={ChevronRightIcon}
                              onClick={() => onFieldPageChange(fieldPagination.page + 1)}
                              disabled={fieldPagination.page >= fieldPagination.totalPages}
                              accessibilityLabel={t.content?.nextPage || "Next page"}
                              size="slim"
                            />
                          </InlineStack>
                        </InlineStack>
                      </div>
                    )}
                  </BlockStack>
                </Card>

                {/* Product Options Card */}
                {config.contentType === "products" && subResourceState && subResourceHandlers &&
                  selectedItem?.options && selectedItem.options.length > 0 && (
                  <div style={{ marginTop: "1rem" }}>
                    <OptionsField
                      options={selectedItem.options}
                      isPrimaryLocale={state.currentLanguage === primaryLocale}
                      currentLanguage={state.currentLanguage}
                      shopLocales={shopLocales}
                      translations={subResourceState.optionTranslations}
                      onTranslate={subResourceHandlers.translateOption}
                      onTranslateField={subResourceHandlers.translateOptionField}
                      onOptionNameChange={subResourceHandlers.handleOptionNameChange}
                      onOptionValueChange={subResourceHandlers.handleOptionValueChange}
                      onPrimaryOptionNameChange={subResourceHandlers.handlePrimaryOptionNameChange}
                      onPrimaryOptionValuesChange={subResourceHandlers.handlePrimaryOptionValuesChange}
                      primaryOptions={subResourceState.primaryOptionEdits}
                      translatingFieldIds={subResourceState.translatingFieldIds}
                      t={{
                        title: t.products?.productOptions,
                        notEditableInPrimary: t.products?.optionsNotEditableInPrimary,
                        editInstructionPrimary: t.products?.optionsEditInstructionPrimary,
                        translateButton: t.products?.translateEntireOption,
                        translateFieldButton: t.products?.translateFieldButton,
                        linkedOptionHint: t.products?.linkedOptionHint,
                        linkedOptionHintBefore: t.products?.linkedOptionHintBefore,
                        linkedOptionHintAfter: t.products?.linkedOptionHintAfter,
                        linkedBadge: t.products?.linkedBadge,
                        optionNameLabel: t.products?.optionNameLabel,
                        valuesLabel: t.products?.valuesLabel,
                        linkedNotEditableHint: t.products?.linkedNotEditableHint,
                        linkedNotEditableHintBefore: t.products?.linkedNotEditableHintBefore,
                        linkedNotEditableHintAfter: t.products?.linkedNotEditableHintAfter,
                        metaobjectsLinkText: t.products?.metaobjectsLinkText,
                        optionPositionLabel: t.products?.optionPositionLabel,
                        clearButton: t.products?.clearButton,
                      }}
                    />
                  </div>
                )}

                {/* Metafields Card */}
                {config.contentType === "products" && subResourceState && subResourceHandlers &&
                  selectedItem?.metafields && selectedItem.metafields.length > 0 && (
                  <div style={{ marginTop: "1rem" }}>
                    <MetafieldsField
                      metafields={selectedItem.metafields}
                      isPrimaryLocale={state.currentLanguage === primaryLocale}
                      currentLanguage={state.currentLanguage}
                      translations={subResourceState.metafieldTranslations}
                      onTranslate={subResourceHandlers.translateMetafield}
                      onMetafieldChange={subResourceHandlers.handleMetafieldChange}
                      onPrimaryMetafieldChange={subResourceHandlers.handlePrimaryMetafieldChange}
                      primaryValues={subResourceState.primaryMetafieldEdits}
                      translatingFieldIds={subResourceState.translatingFieldIds}
                      t={{
                        title: t.products?.productMetafields,
                        notEditableInPrimary: t.products?.metafieldsNotEditableInPrimary,
                        editInstructionPrimary: t.products?.metafieldsEditInstructionPrimary,
                        translateButton: t.products?.translateMetafield,
                      }}
                    />
                  </div>
                )}
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
  isDataLoading?: boolean;
  sourceTextAvailable: boolean;
  /** If true, only "Improve with AI" is shown (disabled when empty). Used for templates. */
  disableGeneration?: boolean;
  /** If true, the value is a fallback from primary locale (shown in gray) */
  isFallbackValue?: boolean;
  /** If true, the field is read-only (disabled). Used when primary locale template editing is not enabled. */
  readOnly?: boolean;
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
  contentType: string;
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
    isDataLoading,
    sourceTextAvailable,
    disableGeneration,
    isFallbackValue,
    readOnly,
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
    contentType,
    t,
    state,
    handlers,
    fetcherState,
    fetcherFormData,
  } = props;

  // Image AI actions: split into "all locales" vs "per locale" (same pattern as text fields)
  const IMAGE_ALL_LOCALES_ACTIONS = [
    "generateAltText",
    "translateAltText",
    "translateAltTextToAllLocales",
    "translateAllAltTextsToAllLocales",
  ];
  const IMAGE_PER_LOCALE_ACTIONS = [
    "translateAllAltTextsForLocale",
  ];

  // Check if an image-related AI action is currently running (used for ImageGalleryField)
  // Only block for the same item; per-locale actions only block the targeted locale
  const currentAction = fetcherFormData?.get("action");
  const fetcherTargetLocale = fetcherFormData?.get("targetLocale") as string | null;
  const fetcherItemId = fetcherFormData?.get("itemId") as string | null;
  const isSameItem = fetcherItemId === selectedItem?.id;
  const isImageAIActionRunning = fetcherState !== "idle" && isSameItem && (
    IMAGE_ALL_LOCALES_ACTIONS.includes(currentAction as string) ||
    (IMAGE_PER_LOCALE_ACTIONS.includes(currentAction as string) && fetcherTargetLocale === currentLanguage)
  );

  // Get locale name for label (localized to app language)
  const { locale: appLocale } = useI18n();
  const localeName = getLocalizedLanguageName(currentLanguage, appLocale, shopLocales.find((l: any) => l.locale === currentLanguage)?.name);

  // Build label (use i18n field label if available, fallback to config label)
  const fieldLabelMap: Record<string, string> = t.content?.fieldLabels || {};
  const translatedFieldLabel = fieldLabelMap[field.key] || field.label;
  const label = `${translatedFieldLabel} (${localeName})`;

  // Build help text
  let helpText = "";
  if (typeof field.helpText === "function") {
    helpText = field.helpText(value);
  } else if (field.helpText) {
    helpText = field.helpText;
  } else if (field.type === "text" || field.type === "textarea") {
    helpText = `${value.length} ${t.content?.characters || "characters"}`;
  }

  // Map field keys to help tooltip keys
  const helpKeyMap: Record<string, string> = {
    title: "title",
    description: "description",
    body: "description",
    handle: "handle",
    seoTitle: "seoTitle",
    metaDescription: "metaDescription",
    altText: "altText",
    productType: "productType",
  };
  const helpKey = helpKeyMap[field.key];

  // Determine if required indicator should be shown
  // Templates & Metaobjects: All fields are required in primary locale (Shopify removes fields if empty)
  // Products: Only title field is required in primary locale
  const requiredIndicator = isPrimaryLocale && !readOnly && (
    contentType === 'templates' || // All template fields
    contentType === 'metaobjects' || // All metaobject entries
    (contentType === 'products' && field.key === 'title') // Only product title
  );

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
    // Render if images array has items OR if featuredImage exists (for collections/blogs)
    const hasImages = selectedItem?.images && selectedItem.images.length > 0;
    const hasFeaturedImage = selectedItem?.featuredImage;

    if (!selectedItem || (!hasImages && !hasFeaturedImage)) {
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
        onTranslateAllAltTexts={handlers.handleTranslateAllAltTexts}
        onTranslateAllAltTextsForLocale={handlers.handleTranslateAllAltTextsForLocale}
        altTextSuggestions={state.altTextSuggestions}
        onAcceptSuggestion={handlers.handleAcceptAltTextSuggestion}
        onAcceptAndTranslateSuggestion={handlers.handleAcceptAndTranslateAltText}
        onRejectSuggestion={handlers.handleRejectAltTextSuggestion}
        onClearAltText={(imageIndex) => handlers.handleAltTextChange(imageIndex, "")}
        isFieldLoading={(imageIndex) => {
          // Check both global key (all-locales) and locale-specific key (per-locale)
          const isBulkTranslating = (state?.loadingFieldKeys?.has("allAltTextsTranslate") ?? false)
            || (state?.loadingFieldKeys?.has(`allAltTextsTranslate_${currentLanguage}`) ?? false);
          const isBulkGenerating = state?.loadingFieldKeys?.has("allAltTextsGenerate") ?? false;
          if (imageIndex === -1) return isImageAIActionRunning || isBulkTranslating || isBulkGenerating;
          return isImageAIActionRunning || isBulkTranslating || isBulkGenerating || (state?.loadingFieldKeys?.has(`altText_${imageIndex}`) ?? false);
        }}
        t={{
          image: t.products?.image || "Image",
          featuredImage: t.products?.featuredImage || "Featured Image",
          altTextForImage: t.products?.altTextForImage || "Alt-text for image",
          altTextPlaceholder: t.products?.altTextPlaceholder || "Describe the image...",
          generateAllAltTexts: t.products?.generateAllAltTexts || "Generate all alt-texts",
          translateAllAltTexts: t.products?.translateAllAltTexts || "Translate all alt-texts",
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
        helpKey={helpKey}
        isLoading={isLoading}
        isDataLoading={isDataLoading}
        sourceTextAvailable={sourceTextAvailable}
        disableGeneration={disableGeneration}
        readOnly={readOnly}
        requiredIndicator={requiredIndicator}
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
      helpKey={helpKey}
      multiline={field.multiline}
      isLoading={isLoading}
      isDataLoading={isDataLoading}
      sourceTextAvailable={sourceTextAvailable}
      disableGeneration={disableGeneration}
      isFallbackValue={isFallbackValue}
      readOnly={readOnly}
      requiredIndicator={requiredIndicator}
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
    productType: item.productType || "",
    seoTitle: item.seo?.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
  };

  // Check predefined field mappings first
  if (fieldMappings[fieldKey]) {
    return fieldMappings[fieldKey];
  }

  // For dynamic fields (e.g., templates), check translatableContent
  if (item.translatableContent && Array.isArray(item.translatableContent)) {
    const contentItem = item.translatableContent.find((c: any) => c != null && c.key === fieldKey);
    if (contentItem?.value) {
      return contentItem.value;
    }
  }

  // For metaobjects: fieldKey is a metaobject GID, look up the label field value
  if (fieldKey.startsWith("gid://shopify/Metaobject/") && item.metaobjects && Array.isArray(item.metaobjects)) {
    const metaobj = item.metaobjects.find((m: any) => m.id === fieldKey);
    if (metaobj) {
      const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
      return labelField?.value || metaobj.displayName || "";
    }
  }

  return "";
}

function getResourceType(contentType: string): "product" | "collection" | "page" | "article" | "policy" | "templates" {
  const resourceTypeMap: Record<string, "product" | "collection" | "page" | "article" | "policy" | "templates"> = {
    blogs: "article",
    pages: "page",
    policies: "policy",
    collections: "collection",
    products: "product",
    templates: "templates",
  };
  return resourceTypeMap[contentType] || contentType as any;
}

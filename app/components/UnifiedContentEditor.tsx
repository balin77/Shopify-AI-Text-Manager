/**
 * Unified Content Editor Layout
 *
 * Generic layout component for all content types (collections, blogs, pages, policies)
 * Based on the products page structure with all bug fixes included.
 */

import { isThemeContentType } from "~/utils/content-type-groups";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Page, Card, Text, BlockStack, InlineStack, Button, Modal, TextContainer, TextField, Icon, Spinner, Checkbox } from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { useSeoSettings } from "../contexts/SeoSettingsContext";
import { UnifiedItemList } from "./unified/UnifiedItemList";
import { UnifiedFieldRenderer } from "./UnifiedFieldRenderer";
import { UnifiedLanguageBar, shouldRenderLanguageBar } from "./unified/UnifiedLanguageBar";
import { MobileToolbar } from "./unified/MobileToolbar";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { OptionsField } from "./unified/OptionsField";
import { MetafieldsField } from "./unified/MetafieldsField";
import { ReloadButton } from "./ReloadButton";
import { AppSaveBar } from "./AppSaveBar";
import type { SubResourceState, SubResourceHandlers } from "../hooks/useProductSubResources";
import { HelpTooltip } from "./HelpTooltip";
import { SeoSidebar } from "./SeoSidebar";
import {
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  type JsonLd,
} from "../services/structured-data.service";
import type { KeywordResourceType } from "../services/seo/keywords.service";
import { BulkImageUploadPanel } from "./image-manager/BulkImageUploadPanel";
import { BulkAltTextPanel } from "./image-manager/BulkAltTextPanel";
import { usePlan } from "../contexts/PlanContext";
import { getPlanDisplayName as getPlanDisplayNameUtil } from "../utils/planUtils";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import { getLocalizedLanguageName, hasPrimaryContentMissing, getLocaleButtonTooltip } from "../utils/contentEditor.utils";
import type { MetaobjectEntry, ValidationOverlays } from "../utils/contentEditor.utils";
import { useI18n } from "../contexts/I18nContext";
import { LocaleAvailabilityProvider } from "../contexts/LocaleAvailabilityContext";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { ENABLE_THEME_PRIMARY_EDIT } from "../config/constants";
import { useGlobalActionState, useLoadingFieldKeys } from "../hooks/useAIOperationsStore";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
import "../styles/UnifiedContentEditor.css";
import "../styles/content-editor-global.css";
import type { ContentEditorConfig, UseContentEditorReturn, FieldDefinition, TranslatableContentItem, ShopLocale } from "../types/content-editor.types";
import type { Translation as I18nTranslation } from "~/i18n/de";
import type { UnifiedItem, SortOption } from "./unified/UnifiedItemList";

interface UnifiedContentEditorProps {
  /** Configuration for this content type */
  config: ContentEditorConfig;

  /** Items to display in the list */
  items: TranslatableContentItem[];

  /** Shop locales */
  shopLocales: ShopLocale[];

  /** Primary locale */
  primaryLocale: string;

  /**
   * When set, the market selector is shown but force-disabled with this reason as
   * its tooltip (e.g. cookie banner: no market scoping in the Customer Privacy API).
   */
  marketDisabledReason?: string;

  /** Return value from useUnifiedContentEditor hook */
  editor: UseContentEditorReturn;

  /** Fetcher state */
  fetcherState: string;

  /** Fetcher form data */
  fetcherFormData: FormData | undefined;

  /** Translation function */
  t: I18nTranslation;

  /** Optional: Custom render for sidebar */
  renderSidebar?: (item: TranslatableContentItem, editableValues: Record<string, string>) => React.ReactNode;

  /** Optional: Custom render for list item */
  renderListItem?: (item: TranslatableContentItem, isSelected: boolean) => React.ReactNode;

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

  /** Optional: replaces the image-gallery field for Pro/Max users */
  imageGalleryReplacement?: React.ReactNode;

  /** Optional: Variant Image Manager für Pro/Max */
  showImageManager?: boolean;

  /** Optional: Image Manager State + Handlers */
  imageManager?: {
    bulkItems: import("./image-manager/types").StagedItem[];
    onBulkItemsChange: (updater: (prev: import("./image-manager/types").StagedItem[]) => import("./image-manager/types").StagedItem[]) => void;
    selectedBulkIds: Set<string>;
    activeAction: "copy" | "move" | null;
    onSetAction: (action: "copy" | "move" | null) => void;
    onBulkSelect: (id: string, selected: boolean) => void;
    onRemoveBulk: (ids: string[]) => void;
    activeRightTab: "seo" | "images";
    onTabChange: (tab: "seo" | "images") => void;
    activeImageSubTab: "bulkUpload" | "bulkAltText";
    onImageSubTabChange: (tab: "bulkUpload" | "bulkAltText") => void;
    imageManagerSettings: { firstImageBig: boolean; showAltTags: boolean; autoAltText: boolean };
    variantsForBulk?: import("./image-manager/types").VariantWithGallery[];
    onVariantsLoaded?: (variants: import("./image-manager/types").VariantWithGallery[]) => void;
    selectedGalleryGids?: string[];
    onConfirm?: () => Promise<string | null>;
    isApplying?: boolean;
    productTitle?: string;
    productId?: string;
    onApplySuccess?: () => void;
  };

  /** Optional: product IDs that have variants with missing main images (for yellow dot in list) */
  extraMissingPrimaryIds?: Set<string>;

  /**
   * Optional: Theme-Auswahl. Only rendered for theme-content types
   * (isThemeContentType) and when more than one theme exists. Lets the merchant
   * pick which installed theme's content is edited/translated.
   */
  themeSelector?: {
    options: { label: string; value: string }[];
    selectedThemeId: string;
    onChange: (themeId: string) => void;
    /** Non-MAIN theme with no own synced rows → surface the sync prompt even when
     * shared "" rows keep the nav list non-empty (PLAN_THEME_SELECTION_B_LITE). */
    needsThemeSync?: boolean;
  };
}

export function UnifiedContentEditor(props: UnifiedContentEditorProps) {
  const {
    config,
    items,
    shopLocales,
    primaryLocale,
    marketDisabledReason,
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
    themeSelector,
    subResourceState,
    subResourceHandlers,
    showImageManager,
    imageManager,
    imageGalleryReplacement,
    extraMissingPrimaryIds,
  } = props;

  const { locale } = useI18n();

  // Local state for search input - synced with fieldPagination.search
  const [fieldSearchInput, setFieldSearchInput] = useState(fieldPagination?.search || "");

  // Resizable SEO/bulk sidebar
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const sidebarWidthRef = useRef(320);
  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(600, startWidth + (startX - ev.clientX)));
      sidebarWidthRef.current = newWidth;
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // Sync local search input when fieldPagination.search changes externally (e.g. group switch)
  const prevFieldSearchRef = useRef(fieldPagination?.search || "");
  useEffect(() => {
    const serverSearch = fieldPagination?.search || "";
    if (prevFieldSearchRef.current !== serverSearch) {
      prevFieldSearchRef.current = serverSearch;
      setFieldSearchInput(serverSearch);
    }
  }, [fieldPagination?.search]);

  const { state, handlers, selectedItem, helpers, effectiveFieldDefinitions } = editor;

  // Overlay-aware snapshot: re-derived whenever baselineVersion ticks (overlays changed)
  const validationOverlays = useMemo(
    () => helpers.getValidationOverlays(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [helpers.validationVersion]
  );

  const { plan, getMaxProducts, getNextPlanUpgrade } = usePlan();
  const { showInfoBox } = useInfoBox();
  const { registerItems, clearItems } = useItemSelector();

  // Combined reload handler: refresh main editor + sub-resources
  const handleReloadComplete = useCallback(() => {
    helpers.triggerDataRefresh();
    subResourceHandlers?.resetForReload?.();
  }, [helpers, subResourceHandlers]);

  // Use effective field definitions (dynamic for templates, static for other content types)
  const fieldDefinitions = effectiveFieldDefinitions || config.fieldDefinitions;

  // List-level "sync from Shopify" (discovery): trigger a real full sync of this
  // content type from Shopify, THEN revalidate so newly-created items appear in
  // the list. (The per-item ReloadButton in the language bar stays a single-item
  // refresh.) Falls back to a plain revalidate for content types without a
  // discovery endpoint.
  const [isDiscovering, setIsDiscovering] = useState(false);
  // True once a sync-from-Shopify has been attempted for the current theme. Lets
  // the empty-state distinguish "not synced yet" from "synced, genuinely empty"
  // (a theme can legitimately have 0 entries in a tab). Reset on theme switch.
  const [syncAttempted, setSyncAttempted] = useState(false);
  const handleSyncAll = useCallback(async () => {
    if (!revalidator) return;
    const ct = config.contentType;
    const endpoint =
      ct === "products"
        ? "/api/sync-products"
        : SYNC_CONTENT_TYPE[ct]
          ? `/api/sync-content?types=${SYNC_CONTENT_TYPE[ct]}`
          : null;
    if (!endpoint) {
      revalidator.revalidate();
      return;
    }
    setIsDiscovering(true);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Don't block the revalidate — the DB may still hold fresher data than the
      // current view even if the Shopify pull failed.
      console.error("[UnifiedContentEditor] sync-from-Shopify failed:", err);
    } finally {
      setIsDiscovering(false);
      setSyncAttempted(true);
      revalidator.revalidate();
    }
  }, [revalidator, config.contentType]);

  // A theme switch means a different data set — forget the previous theme's
  // sync-attempt so its empty-state starts from "not synced yet" again.
  const themeSelectorThemeId = themeSelector?.selectedThemeId;
  useEffect(() => {
    setSyncAttempted(false);
  }, [themeSelectorThemeId]);

  // Check if a global AI action is currently running (affects all fields)
  // Uses global AI operations store — spinners persist across item navigation.
  const { isAllLocalesRunning: isAllLocalesActionRunning, isPerLocaleRunning: isPerLocaleActionRunning } =
    useGlobalActionState(state.selectedItemId || "", state.currentLanguage);
  // Get the set of fields with loading AI actions (for per-field loading states)
  const loadingFieldKeys = useLoadingFieldKeys(state.selectedItemId || "");

  const isGlobalAIActionRunning = isAllLocalesActionRunning || isPerLocaleActionRunning
    || loadingFieldKeys.has("__translateAll__");

  // App-embed groups are technical content (CSS selectors / config). Editing or
  // translating them would break the embed on the storefront, so we lock every
  // field — in the primary language AND in all foreign locales — while still
  // showing the items (parity with Translate & Adapt). Server loader marks the
  // group with `embedTechnical` (theme-content-domain.server.ts).
  const isEmbedTechnical = !!(selectedItem as any)?.embedTechnical;

  // Single-language shop: every translate / copy-to-all-locales action has no
  // target and would only ever produce a "no target languages" warning. The
  // buttons stay visible but greyed out with an explaining tooltip, and the
  // language bar disappears entirely (nothing to switch between).
  const hasMultipleLocales = shopLocales.length > 1;
  const singleLocaleHint = hasMultipleLocales ? undefined : t.common?.requiresSecondLanguage;

  // Translated resource names for the item list
  const resourceNames = (t.content?.resourceNames || {}) as Record<string, string>;
  const translatedResourceName = {
    singular: resourceNames[config.contentType === "pages" ? "pageSingular" : config.displayNameSingular.toLowerCase()] || config.displayNameSingular,
    plural: resourceNames[config.contentType] || config.displayName,
  };

  // German always capitalizes nouns; English/Spanish lowercase them mid-sentence.
  const itemNoun =
    locale === "de"
      ? translatedResourceName.plural
      : translatedResourceName.plural.toLowerCase();

  // Transform items to UnifiedItem format (memoized to prevent re-render cascades)
  const unifiedItems: UnifiedItem[] = useMemo(() => {
    const tooltipI18n = {
      missingContent: t.common?.missingContent ?? "Missing content:",
      missingTranslations: t.common?.missingTranslations ?? "Missing translations:",
      fieldLabels: (t.common?.fieldLabels ?? {}) as Record<string, string>,
    };
    const primaryLocaleObj = shopLocales.find((l) => l.primary) ?? { locale: primaryLocale, primary: true };
    const foreignLocales = shopLocales.filter((l) => !l.primary);

    return items.map((item) => {
      let subtitle = config.getSubtitle ? config.getSubtitle(item, t) : undefined;
      // Translate "translatable fields" for templates
      if (isThemeContentType(config.contentType) && item.contentCount !== undefined) {
        subtitle = `${item.contentCount || 0} ${t.content?.translatableFields || "translatable fields"}`;
      }
      const itemOverlays = item.id === selectedItem?.id ? validationOverlays : undefined;
      const hasMissingPrimary = hasPrimaryContentMissing(item, config.contentType, itemOverlays) || (extraMissingPrimaryIds?.has(item.id) ?? false);
      const missingPrimaryTooltip = hasMissingPrimary
        ? getLocaleButtonTooltip(primaryLocaleObj, item, primaryLocale, config.contentType, false, tooltipI18n, itemOverlays)
        : null;

      const foreignMissingParts = foreignLocales
        .map((l) => {
          const tip = getLocaleButtonTooltip(l, item, primaryLocale, config.contentType, false, tooltipI18n, itemOverlays);
          if (!tip) return null;
          const fieldsStr = tip.replace(/^[^:]+:\s*/, "");
          return `${l.locale.toUpperCase()}: ${fieldsStr}`;
        })
        .filter(Boolean);
      const hasMissingTranslations = foreignMissingParts.length > 0;
      const missingTranslationsTooltip = hasMissingTranslations
        ? `${tooltipI18n.missingTranslations} ${foreignMissingParts.join(" • ")}`
        : null;

      const itemAny = item as any;
      return {
        ...item,
        id: item.id,
        title: config.getPrimaryField ? config.getPrimaryField(item, t) : item.title,
        subtitle,
        category: item.blogTitle || itemAny.category,
        status: itemAny.status,
        image: item.featuredImage || itemAny.image,
        hasMissingPrimary,
        hasMissingTranslations,
        missingPrimaryTooltip,
        missingTranslationsTooltip,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, config.getPrimaryField, config.getSubtitle, config.contentType, t, shopLocales, primaryLocale, extraMissingPrimaryIds, validationOverlays, helpers.validationVersion]);

  // Plan limit configuration
  const maxItems = getMaxProducts(); // This works for all content types
  const nextPlan = getNextPlanUpgrade();
  const defaultPlanLimit = {
    isAtLimit: items.length >= maxItems && maxItems !== Infinity,
    maxItems,
    currentPlan: getPlanDisplayNameUtil(plan),
    nextPlan: nextPlan ? getPlanDisplayNameUtil(nextPlan) : undefined,
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
  const defaultRenderSidebar = (item: TranslatableContentItem, editableValues: Record<string, string>) => {
    if (!config.showSeoSidebar) return null;

    const itemAny = item as any;
    const isBlogContainer = !!itemAny.isBlogContainer;

    // Calculate image alt text stats for SEO score
    // Include featured image if no gallery images exist (e.g. articles)
    const images = (item as TranslatableContentItem & { images?: Array<{ url?: string; altText?: string | null }> }).images ?? [];
    const featuredImg = (item as TranslatableContentItem & { featuredImage?: { url?: string; altText?: string | null } }).featuredImage;
    let totalImages = images.length;
    let imagesWithAlt = images.filter((img, index) => {
      const localAltText = state.imageAltTexts?.[index];
      const originalAltText = img.altText;
      return !!(localAltText || originalAltText);
    }).length;

    // Count featured image when no gallery images exist
    if (totalImages === 0 && featuredImg) {
      totalImages = 1;
      const localAltText = state.imageAltTexts?.[0];
      const originalAltText = featuredImg.altText;
      imagesWithAlt = !!(localAltText || originalAltText) ? 1 : 0;
    }

    // JSON-LD preview for the SEO sidebar. The shop's storefront domain is
    // not available in this translation editor, so URLs are intentionally
    // omitted by the service (still valid schema.org); the storefront theme
    // extension emits the absolute-URL version automatically. This makes the
    // copyable block + schema validation reachable for the SEO-relevant types.
    const title = editableValues.title || "";
    const desc = editableValues.description || editableValues.body || "";
    const handle = editableValues.handle || "";
    const metaDescription = editableValues.metaDescription || "";
    const sdShop = { domain: "", name: "" };
    // Fall back to the first gallery image when Shopify's `featuredImage` is
    // null (variant-only products, articles synced before featuredImage was
    // populated). Otherwise the sidebar warns "Product has no image" even
    // though the storefront Liquid block will render one from the same media.
    const primaryImageUrl =
      featuredImg?.url || (images.length > 0 ? images[0]?.url : undefined) || undefined;
    let structuredData: JsonLd | null = null;
    if (!isBlogContainer && title) {
      if (config.contentType === "products") {
        structuredData = buildProductJsonLd(
          {
            title,
            descriptionHtml: desc,
            handle,
            seoDescription: metaDescription,
            featuredImageUrl: primaryImageUrl,
          },
          sdShop,
        );
      } else if (config.contentType === "collections") {
        structuredData = buildCollectionJsonLd(
          { title, descriptionHtml: desc, handle, seoDescription: metaDescription },
          sdShop,
        );
      } else if (config.contentType === "blogs") {
        // blogHandle is derived from the article's blog TITLE (slugified),
        // matching how the standalone Structured Data preview route builds it.
        // Using `handle` here would produce `/blogs/<article-handle>/<article-handle>`.
        // Currently masked by `sdShop.domain = ""` (absoluteUrl returns ""), but
        // keeping the shape correct guards against future domain wiring.
        const blogTitle =
          (item as TranslatableContentItem & { blogTitle?: string }).blogTitle || "";
        const blogHandle = blogTitle
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || handle;
        structuredData = buildArticleJsonLd(
          { title, body: desc, handle, blogHandle, imageUrl: primaryImageUrl },
          sdShop,
        );
      }
    }

    // Target-keyword tracking is per-item (locale ""), not per-translation, so
    // it's only offered while editing the primary locale — matches the pattern
    // used elsewhere in this file (e.g. handleClearAllClick vs ...ForLocaleClick).
    const keywordResourceType =
      !isBlogContainer && state.currentLanguage === primaryLocale
        ? getKeywordResourceType(config.contentType)
        : undefined;

    return (
      <SeoSidebar
        title={editableValues.title || ""}
        description={editableValues.description || editableValues.body || ""}
        handle={editableValues.handle || ""}
        seoTitle={editableValues.seoTitle || ""}
        metaDescription={editableValues.metaDescription || ""}
        totalImages={totalImages}
        imagesWithAlt={imagesWithAlt}
        excludeDescription={isBlogContainer}
        excludeImages={isBlogContainer}
        structuredData={structuredData}
        structuredDataPreviewMode
        resourceId={keywordResourceType ? item.id : undefined}
        resourceType={keywordResourceType}
      />
    );
  };

  const sidebarRenderer = renderSidebar || defaultRenderSidebar;

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

  // Below 1100px the sidebar column is hidden by CSS, so its content is only
  // reachable through the nav toggle. Tell the nav a sidebar exists (and take
  // the registration back on unmount — the toggle would otherwise survive onto
  // a page that has no sidebar at all).
  const hasSidebar = !!selectedItem && !!config.showSeoSidebar;
  const { open: sidebarPanelOpen, setAvailable: setSidebarPanelAvailable, close: closeSidebarPanel } = useSidebarPanel();
  useEffect(() => {
    setSidebarPanelAvailable(hasSidebar);
  }, [hasSidebar, setSidebarPanelAvailable]);
  useEffect(() => {
    return () => { setSidebarPanelAvailable(false); };
  }, [setSidebarPanelAvailable]);

  // Compute which option/value IDs have missing translations in any foreign locale.
  // Used to show blue highlight on primary locale option fields (same pattern as regular fields).
  const optionMissingTranslationIds = (() => {
    const ids = new Set<string>();
    if (state.currentLanguage !== primaryLocale || !selectedItem?.options) return ids;
    const foreignLocales = shopLocales.filter((l: any) => !l.primary).map((l: any) => l.locale as string);
    const subRT: Record<string, Array<{ key: string; value: string; locale: string }>> =
      (selectedItem as any).subResourceTranslations || {};
    for (const option of selectedItem.options) {
      if (!option.name) continue;
      const nameMissing = foreignLocales.some((locale) => {
        const t = (subRT[option.id] || []).find((x) => x.key === "name" && x.locale === locale);
        return !t || !t.value;
      });
      if (nameMissing) ids.add(option.id);
      if (!option.isLinked) {
        for (const value of option.values) {
          if (!value.name || !value.id) continue;
          const valueMissing = foreignLocales.some((locale) => {
            const t = (subRT[value.id] || []).find((x) => x.key === "name" && x.locale === locale);
            return !t || !t.value;
          });
          if (valueMissing) ids.add(value.id);
        }
      }
    }
    return ids;
  })();

  return (
    // Tells every nested field/action whether translating is possible at all —
    // a single-language shop greys out the translate/copy-to-all buttons.
    <LocaleAvailabilityProvider hasMultipleLocales={hasMultipleLocales}>
    <Page fullWidth>
      <div
        // `sidebar-panel-open` only bites below 1100px, where it swaps the item
        // list + editor for the sidebar column (see UnifiedContentEditor.css).
        // Above that the class is inert and the normal three-column layout wins.
        // Gated on `hasSidebar` too: the panel state is context-owned, so an
        // item that disappears (route change, resync clearing the selection)
        // would otherwise hide the editor for a frame while the sidebar column
        // is already unrendered — a blank content area until the effect below
        // resets `open` after paint.
        className={`unified-content-editor-layout${sidebarPanelOpen && hasSidebar ? " sidebar-panel-open" : ""}`}
        style={{
          // Fill the real available space via flexbox instead of a viewport
          // calc. The <Page> wrapper's content box (.Polaris-Page__Content) is
          // made a column flex container in content-editor-global.css, so this
          // row grows to exactly what's left after the page's grey padding
          // border AND any banner rendered above the editor (e.g. the
          // "Technical content" warning on theme pages). A viewport calc
          // (100vh - nav) could account for neither, so it overshot and clipped
          // the bottom of both columns. minHeight:0 lets the columns scroll
          // internally instead of stretching the row.
          flex: 1,
          minHeight: 0,
          display: "flex",
          gap: "16px",
          // Single source of truth for the page margin — shared with the
          // simple Polaris pages via responsive.css (.Polaris-Page padding).
          padding: "var(--app-page-padding)",
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
          renderItem={renderListItem ? (item, isSelected) => renderListItem(item as TranslatableContentItem, isSelected) : undefined}
          showSearch={true}
          showPagination={true}
          showStatusStripe={!hideItemListStatusBars}
          showThumbnails={!hideItemListImages}
          showCategoryBadge={showItemListCategoryBadge}
          planLimit={finalPlanLimit}
          onSyncAll={revalidator ? handleSyncAll : undefined}
          isSyncing={isDiscovering || revalidator?.state === "loading"}
          sortOptions={sortOptions}
          themeSelector={
            themeSelector && isThemeContentType(config.contentType) && themeSelector.options.length > 1
              ? {
                  options: themeSelector.options,
                  value: themeSelector.selectedThemeId,
                  onChange: themeSelector.onChange,
                  disabled: isDiscovering || revalidator?.state === "loading",
                  label: t.content?.themeSelectorLabel || "Theme",
                  helpText: t.content?.themeSelectorHelp,
                }
              : undefined
          }
          t={{
            searchPlaceholder: t.content?.searchPlaceholder,
            paginationOf: t.content?.paginationOf || "of",
            paginationPrevious: t.content?.paginationPrevious || "Previous",
            paginationNext: t.content?.paginationNext || "Next",
            planLimitReached: t.content?.planLimitReached,
            upgradeForMore: t.content?.upgradeForMore,
            itemNoun,
            noItemsFound: t.content?.noItemsFound,
            noItemsFoundMatching: t.content?.noItemsFoundMatching,
            sortTooltip: t.content?.sortTooltip,
            reloadAllTooltip: t.content?.reloadAllTooltip,
            filterTooltip: t.content?.filterTooltip,
            filterTitle: t.content?.filterTitle,
            statusLabels: t.content?.productStatusLabels,
          }}
          />
          </div>
        </div>

        {/* Middle: Content Editor */}
        <div className="unified-editor-container" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          {selectedItem ? (
            <>

              {/* Native Shopify save bar (Built for Shopify). Rendered ONCE for
                  the editor — shared by the mobile + desktop toolbars, which are
                  both mounted and only toggled via CSS. */}
              <AppSaveBar
                id="unified-content-editor-save-bar"
                hasChanges={state.hasChanges || (subResourceState?.hasChanges ?? false)}
                loading={state.isSavingCurrentItem || (subResourceState?.isSaving ?? false)}
                onSave={() => {
                  // Guard against double-submit: a long-running image save
                  // (up to ~38s for big 3D models) must not fire a duplicate
                  // /api/update-variant-galleries POST (→ Shopify 422 on the
                  // duplicate productCreateMedia for the same staging URL).
                  if (state.isSavingCurrentItem || subResourceState?.isSaving) return;
                  handlers.handleSave();
                  subResourceHandlers?.saveSubResources?.();
                }}
                onDiscard={() => {
                  handlers.handleDiscard();
                  subResourceHandlers?.resetChanges?.();
                }}
                saveText={t.content?.save || "Save"}
                discardText={t.content?.discardChanges || "Discard"}
              />

              {/* Mobile: Compact single-row toolbar (< 768px) */}
              <div className="toolbar-mobile-only">
                <MobileToolbar
                  shopLocales={shopLocales}
                  currentLanguage={state.currentLanguage}
                  primaryLocale={primaryLocale}
                  selectedItem={selectedItem}
                  contentType={config.contentType}
                  onLanguageChange={handlers.handleLanguageChange}
                  markets={state.markets}
                  selectedMarketId={state.selectedMarketId}
                  onMarketChange={handlers.handleMarketChange}
                  enabledLanguages={state.enabledLanguages}
                  isLoadingData={state.isLoadingData}
                  validationOverlays={validationOverlays}
                  validationVersion={helpers.validationVersion}
                  onTranslateAll={state.currentLanguage === primaryLocale ? handlers.handleTranslateAll : handlers.handleTranslateAllForLocale}
                  onClearAll={state.currentLanguage === primaryLocale ? handlers.handleClearAllClick : handlers.handleClearAllForLocaleClick}
                  disableBulkActions={isEmbedTechnical}
                  onToggleSendImageToAI={handlers.handleToggleSendImageToAI}
                  sendImageToAI={state.sendImageToAI}
                  images={state.images}
                  featuredImage={state.featuredImage ?? undefined}
                  isTranslatingGlobal={isAllLocalesActionRunning || isPerLocaleActionRunning}
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
                    sendImageToAI: t.content?.sendImageToAI || "📷 Send image to AI",
                    reloadItemTooltip: t.content?.reloadItemTooltip,
                    allMarketsGlobal: t.content?.market?.allMarketsGlobal || "All markets (global)",
                    marketSelectorLabel: t.content?.market?.selectorLabel || "Market",
                    marketTooltip: t.content?.market?.tooltip,
                    marketPrimaryDisabledHint: t.content?.market?.primaryDisabledHint,
                    marketDisabledReason,
                  }}
                />
              </div>

              {/* Desktop: Language Bar + Operation Buttons (>= 769px) */}
              <div className="toolbar-desktop-only">
                {/* Language Selection Bar — skipped entirely for single-language
                    shops (the bar itself renders null; the Card would stay as an
                    empty box). */}
                {shouldRenderLanguageBar({
                  localeCount: shopLocales.length,
                  marketCount: state.markets?.length ?? 0,
                  hasMarketHandler: true,
                }) && (
                <Card padding="400">
                  <UnifiedLanguageBar
                    shopLocales={shopLocales}
                    currentLanguage={state.currentLanguage}
                    primaryLocale={primaryLocale}
                    selectedItem={selectedItem}
                    contentType={config.contentType}
                    hasChanges={state.hasChanges || (subResourceState?.hasChanges ?? false)}
                    onLanguageChange={handlers.handleLanguageChange}
                    markets={state.markets}
                    selectedMarketId={state.selectedMarketId}
                    onMarketChange={handlers.handleMarketChange}
                    enabledLanguages={state.enabledLanguages}
                    onToggleLanguage={handlers.handleToggleLanguage}
                    onTranslateAll={handlers.handleTranslateAll}
                    isTranslating={isAllLocalesActionRunning}
                    showTranslateAll={!isEmbedTechnical}
                    showReloadButton={true}
                    isLoadingData={state.isLoadingData}
                    validationOverlays={validationOverlays}
                    validationVersion={helpers.validationVersion}
                    t={{
                      primaryLocaleSuffix: t.content?.primaryLanguageSuffix || "Primary",
                      translateAll: t.content?.translateAll || "🌍 Translate All",
                      translating: t.content?.translating || "Translating...",
                      allMarketsGlobal: t.content?.market?.allMarketsGlobal || "All markets (global)",
                      marketSelectorLabel: t.content?.market?.selectorLabel || "Market",
                      marketTooltip: t.content?.market?.tooltip,
                      marketPrimaryDisabledHint: t.content?.market?.primaryDisabledHint,
                      marketDisabledReason,
                    }}
                  />
                </Card>
                )}

                {/* Operation Buttons */}
                <div style={{ marginTop: "1rem" }}>
                  <Card padding="400">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    {/* Left: Translate All + Clear All Buttons */}
                    {/* Hidden for templates in primary locale when themeFilesUpsert is not enabled */}
                    <InlineStack gap="200">
                      {state.currentLanguage === primaryLocale ? (
                        <>
                          {/* Primary locale: Translate to ALL foreign languages.
                              Hidden for app-embed technical groups — translating
                              CSS selectors / config would break the embed. */}
                          {!isEmbedTechnical && (
                          <DisabledActionTooltip hint={singleLocaleHint}>
                            <Button
                              onClick={handlers.handleTranslateAll}
                              loading={isAllLocalesActionRunning}
                              disabled={isAllLocalesActionRunning || !!singleLocaleHint}
                              size="slim"
                            >
                              {isAllLocalesActionRunning
                                ? (t.content?.translating || "Translating...")
                                : (t.content?.translateAll || "🌍 Translate All")}
                            </Button>
                          </DisabledActionTooltip>
                          )}
                          {/* Clear All: hidden for templates when primary edit is not
                              enabled, and for app-embed technical groups. */}
                          {!isEmbedTechnical && !(isThemeContentType(config.contentType) && !ENABLE_THEME_PRIMARY_EDIT) && (
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
                          {/* Foreign locale: Translate ONLY this locale. Hidden for
                              app-embed technical groups (locked in every locale). */}
                          {!isEmbedTechnical && (
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
                          )}
                          {!isEmbedTechnical && (
                          <Button
                            onClick={handlers.handleClearAllForLocaleClick}
                            size="slim"
                            tone="critical"
                          >
                            🗑️ {t.content?.clearAll || "Clear All"}
                          </Button>
                          )}
                        </>
                      )}
                    </InlineStack>

                    {/* Right: Reload Button (Save/Discard handled by the native
                        Shopify save bar — see AppSaveBar above) */}
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0, flexWrap: "nowrap" }}>
                      <ReloadButton
                        resourceId={selectedItem.id}
                        resourceType={getResourceType(config.contentType)}
                        locale={state.currentLanguage}
                        tooltip={t.content?.reloadItemTooltip}
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
                      // Primary-language editing writes to a theme file
                      // (themeFilesUpsert), which only exists for the `theme`
                      // domain (contentType "templates"). It is read-only when:
                      //  - themeFilesUpsert is not enabled (templates), OR
                      //  - the rubric is a resource-backed theme-content family
                      //    member (System/Versand/Abo-Pläne/Filter) — those have
                      //    no theme file, so their original lives in Shopify admin
                      //    and the server rejects primary saves for them.
                      const isTemplatePrimaryReadOnly = isThemeContentType(config.contentType)
                        && state.currentLanguage === primaryLocale
                        && (!ENABLE_THEME_PRIMARY_EDIT || config.contentType !== "templates");

                      // App-embed technical fields are locked in every locale.
                      const isFieldReadOnly = isTemplatePrimaryReadOnly || isEmbedTechnical;

                      return fieldDefinitions.map((field) => {
                        if (field.type === "image-gallery" && imageGalleryReplacement) {
                          return <div key={field.key}>{imageGalleryReplacement}</div>;
                        }
                        return (
                        <UnifiedFieldRenderer
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
                          disableGeneration={isThemeContentType(config.contentType)}
                          isFallbackValue={state.fallbackFields?.has(field.key) || false}
                          fieldError={state.fieldErrors?.[field.key]}
                          readOnly={isFieldReadOnly}
                          embedTechnical={isEmbedTechnical}
                          selectedMarketId={state.selectedMarketId}
                          onGenerateAI={isFieldReadOnly ? undefined : (field.supportsAI !== false ? (userInstruction?: string) => handlers.handleGenerateAI(field.key, userInstruction) : undefined)}
                          onFormatAI={isFieldReadOnly ? undefined : (field.supportsFormatting !== false ? () => handlers.handleFormatAI(field.key) : undefined)}
                          onTranslate={isEmbedTechnical ? undefined : (field.supportsTranslation !== false ? () => handlers.handleTranslateField(field.key) : undefined)}
                          onTranslateToAllLocales={isEmbedTechnical ? undefined : (field.supportsTranslation !== false ? () => handlers.handleTranslateFieldToAllLocales(field.key) : undefined)}
                          onCopy={isEmbedTechnical ? undefined : (field.supportsTranslation !== false ? () => handlers.handleCopyField(field.key) : undefined)}
                          onCopyToAllLocales={isEmbedTechnical ? undefined : (field.supportsTranslation !== false ? () => handlers.handleCopyFieldToAllLocales(field.key) : undefined)}
                          onAcceptSuggestion={() => handlers.handleAcceptSuggestion(field.key)}
                          onAcceptAndTranslate={() => handlers.handleAcceptAndTranslate(field.key)}
                          onRejectSuggestion={() => handlers.handleRejectSuggestion(field.key)}
                          onClear={isFieldReadOnly ? undefined : (field.key === "title" && state.currentLanguage === primaryLocale ? undefined : () => handlers.handleClearField(field.key))}
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
                          validationOverlays={validationOverlays}
                        />
                        );
                      });
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
                      fallbackResourceIds={subResourceState.fallbackResourceIds}
                      onTranslate={subResourceHandlers.translateOption}
                      onTranslateField={subResourceHandlers.translateOptionField}
                      onCopyField={subResourceHandlers.copyOptionField}
                      onCopyFieldToAllLocales={subResourceHandlers.copyOptionFieldToAllLocales}
                      onOptionNameChange={subResourceHandlers.handleOptionNameChange}
                      onOptionValueChange={subResourceHandlers.handleOptionValueChange}
                      onPrimaryOptionNameChange={subResourceHandlers.handlePrimaryOptionNameChange}
                      onPrimaryOptionValuesChange={subResourceHandlers.handlePrimaryOptionValuesChange}
                      primaryOptions={subResourceState.primaryOptionEdits}
                      translatingFieldIds={subResourceState.translatingFieldIds}
                      missingTranslationIds={optionMissingTranslationIds}
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
                        copyButton: t.products?.copy,
                        copyToAllLocalesButton: t.products?.copyToAllLocales,
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
                      fallbackResourceIds={subResourceState.fallbackResourceIds}
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
            // Empty state fills the editor column so it matches the item-list
            // column height when nothing is selected (both equal height when
            // empty). The injected style forces the Polaris Card to full height
            // and vertically centers the hint — mirrors UnifiedItemList's
            // full-height card pattern. The item-list height is left untouched.
            <div className="unified-editor-empty" style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <style dangerouslySetInnerHTML={{ __html: `
                .unified-editor-empty > .Polaris-Card {
                  height: 100% !important;
                  display: flex !important;
                  flex-direction: column !important;
                }
                .unified-editor-empty .Polaris-Card > div {
                  flex: 1 !important;
                  display: flex !important;
                  align-items: center !important;
                  justify-content: center !important;
                }
              ` }} />
              <Card padding="600">
                <div style={{ textAlign: "center", padding: "2rem" }}>
                  {themeSelector && (items.length === 0 || themeSelector.needsThemeSync) ? (
                    // Theme-Auswahl: the selected theme has no content in this tab.
                    // Before a sync attempt this reads as "not synced yet" + a
                    // primary sync button; AFTER an attempt that still returns
                    // nothing, it reads as "genuinely empty" + a secondary retry,
                    // so the "not synced" text doesn't get stuck forever on a theme
                    // that simply has no entries here.
                    <BlockStack gap="400" inlineAlign="center">
                      <Text as="p" variant="headingMd" tone="subdued">
                        {syncAttempted
                          ? (t.content?.themeNoEntries || "No entries for this theme in this section.")
                          : (t.content?.themeSwitchNeedsSync || "This theme hasn't been synced yet.")}
                      </Text>
                      {revalidator && (
                        <Button
                          variant={syncAttempted ? "secondary" : "primary"}
                          loading={isDiscovering}
                          onClick={handleSyncAll}
                        >
                          {syncAttempted
                            ? (t.content?.themeSyncRetry || "Sync again")
                            : (t.content?.themeSyncNow || "Load all entries now")}
                        </Button>
                      )}
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="headingLg" tone="subdued">
                      {t.content?.selectFromList || "Select an item from the list"}
                    </Text>
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>

        {/* Resizer handle between editor and sidebar */}
        {selectedItem && config.showSeoSidebar && (
          <div
            className="sidebar-resizer desktop-only"
            onMouseDown={handleResizerMouseDown}
            style={{
              width: 8,
              flexShrink: 0,
              cursor: "col-resize",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginInline: -4,
              zIndex: 10,
            }}
          >
            <div style={{
              width: 4,
              height: 40,
              borderRadius: 2,
              background: "var(--p-color-border)",
              transition: "background 150ms",
            }} />
          </div>
        )}

        {/* Right: Optional Sidebar (Fixed). Hidden below 1100px via CSS — there
            it is reachable through the nav toggle, which makes this column
            replace the editor instead (`.sidebar-panel-open`). */}
        {selectedItem && config.showSeoSidebar && (
          <div className="seo-sidebar-container" style={{ width: sidebarWidth, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Way back to the content. `open` can survive a resize past the
                breakpoint, where the sidebar is shown normally and this row
                would be meaningless — the class hides it there. */}
            {sidebarPanelOpen && (
              <div className="sidebar-panel-back" style={{ marginBottom: 8, flexShrink: 0 }}>
                <Button icon={ChevronLeftIcon} onClick={closeSidebarPanel} fullWidth textAlign="left">
                  {t.seo?.hidePanel || "Back to content"}
                </Button>
              </div>
            )}
            {/* Tab-Toggle für Pro/Max Image Manager */}
            {showImageManager && imageManager && (
              <div style={{ display: "flex", borderBottom: "1px solid #e1e3e5", marginBottom: 8, flexShrink: 0 }}>
                <button
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    border: "none",
                    background: "none",
                    borderBottom: imageManager.activeRightTab === "seo" ? "2px solid #005bd3" : "2px solid transparent",
                    cursor: "pointer",
                    fontWeight: imageManager.activeRightTab === "seo" ? 600 : 400,
                    fontSize: 13,
                    color: imageManager.activeRightTab === "seo" ? "#005bd3" : "#616161",
                  }}
                  onClick={() => imageManager.onTabChange("seo")}
                >
                  {t.imageManager?.seoScoreTab ?? "SEO Score"}
                </button>
                <button
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    border: "none",
                    background: "none",
                    borderBottom: imageManager.activeRightTab === "images" ? "2px solid #005bd3" : "2px solid transparent",
                    cursor: "pointer",
                    fontWeight: imageManager.activeRightTab === "images" ? 600 : 400,
                    fontSize: 13,
                    color: imageManager.activeRightTab === "images" ? "#005bd3" : "#616161",
                  }}
                  onClick={() => imageManager.onTabChange("images")}
                >
                  {t.imageManager?.imagesTab ?? "Bulk Upload"}
                </button>
              </div>
            )}
            {/* Sub-Tab bar for Image Processing tab */}
            {showImageManager && imageManager && imageManager.activeRightTab === "images" && (
              <div style={{ display: "flex", borderBottom: "1px solid #e1e3e5", marginBottom: 4, flexShrink: 0, paddingLeft: 4 }}>
                <button
                  style={{
                    padding: "6px 10px",
                    border: "none",
                    background: "none",
                    borderBottom: imageManager.activeImageSubTab === "bulkUpload" ? "2px solid #005bd3" : "2px solid transparent",
                    cursor: "pointer",
                    fontWeight: imageManager.activeImageSubTab === "bulkUpload" ? 600 : 400,
                    fontSize: 12,
                    color: imageManager.activeImageSubTab === "bulkUpload" ? "#005bd3" : "#616161",
                  }}
                  onClick={() => imageManager.onImageSubTabChange("bulkUpload")}
                >
                  {t.imageManager?.bulkUploadSubTab ?? "Bulk Upload"}
                </button>
                <button
                  style={{
                    padding: "6px 10px",
                    border: "none",
                    background: "none",
                    borderBottom: imageManager.activeImageSubTab === "bulkAltText" ? "2px solid #005bd3" : "2px solid transparent",
                    cursor: "pointer",
                    fontWeight: imageManager.activeImageSubTab === "bulkAltText" ? 600 : 400,
                    fontSize: 12,
                    color: imageManager.activeImageSubTab === "bulkAltText" ? "#005bd3" : "#616161",
                  }}
                  onClick={() => imageManager.onImageSubTabChange("bulkAltText")}
                >
                  {t.imageManager?.bulkAltTextSubTab ?? "Bulk Alt Text"}
                </button>
              </div>
            )}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {(!showImageManager || !imageManager || imageManager.activeRightTab === "seo") && (
                sidebarRenderer(selectedItem, state.editableValues)
              )}
              {showImageManager && imageManager && imageManager.activeRightTab === "images" && imageManager.activeImageSubTab === "bulkUpload" && (
                <BulkImageUploadPanel
                  items={imageManager.bulkItems}
                  selectedUniqueIds={imageManager.selectedBulkIds}
                  variants={imageManager.variantsForBulk}
                  productTitle={imageManager.productTitle}
                  productId={imageManager.productId}
                  primaryLocale={primaryLocale}
                  onItemsChange={imageManager.onBulkItemsChange}
                  onSelect={imageManager.onBulkSelect}
                  onRemove={imageManager.onRemoveBulk}
                  onConfirm={imageManager.onConfirm}
                  isConfirming={imageManager.isApplying}
                />
              )}
              {showImageManager && imageManager && imageManager.activeRightTab === "images" && imageManager.activeImageSubTab === "bulkAltText" && (
                <BulkAltTextPanel
                  productId={imageManager.productId ?? ""}
                  productTitle={imageManager.productTitle ?? ""}
                  variants={imageManager.variantsForBulk ?? []}
                  shopLocales={shopLocales.map((l) => l.locale)}
                  primaryLocale={primaryLocale}
                  onApplySuccess={imageManager.onApplySuccess}
                  selectedGids={imageManager.selectedGalleryGids}
                />
              )}
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
    </LocaleAvailabilityProvider>
  );
}


// ============================================================================
// UTILITIES
// ============================================================================

function getSourceText(item: TranslatableContentItem, fieldKey: string, primaryLocale: string): string {
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
    const contentItem = item.translatableContent.find((c: { key: string; value: string | null }) => c != null && c.key === fieldKey);
    if (contentItem?.value) {
      return contentItem.value;
    }
  }

  // For metaobjects: fieldKey is a metaobject GID, look up the label field value
  const itemWithMetaobjects = item as TranslatableContentItem & { metaobjects?: MetaobjectEntry[] };
  if (fieldKey.startsWith("gid://shopify/Metaobject/") && itemWithMetaobjects.metaobjects && Array.isArray(itemWithMetaobjects.metaobjects)) {
    const metaobj = itemWithMetaobjects.metaobjects.find((m) => m.id === fieldKey);
    if (metaobj) {
      const labelField = metaobj.fields?.find((f) => isMetaobjectLabelField(f.key));
      return labelField?.value || metaobj.displayName || "";
    }
  }

  return "";
}

// Target-keyword tracking (SeoKeyword model) only covers these four content
// types — everything else (policies, templates, metaobjects, ...) returns
// undefined so the sidebar's "Target keyword" section stays hidden for them.
function getKeywordResourceType(contentType: string): KeywordResourceType | undefined {
  const map: Record<string, KeywordResourceType> = {
    products: "Product",
    collections: "Collection",
    blogs: "Article",
    pages: "Page",
  };
  return map[contentType];
}

/**
 * contentType → the `types` value for POST /api/sync-content, used by the
 * list-level "sync from Shopify" (discovery) button. `products` is special-cased
 * to its own /api/sync-products endpoint by the caller. Content types absent
 * here have no full-discovery endpoint and fall back to a plain revalidate.
 */
const SYNC_CONTENT_TYPE: Record<string, string> = {
  collections: "collections",
  blogs: "articles",
  pages: "pages",
  policies: "policies",
  templates: "themes",
  metaobjects: "metaobjects",
  system: "system",
  delivery: "delivery",
  onlineStoreExtras: "onlineStoreExtras",
  sellingPlans: "sellingPlans",
};

function getResourceType(contentType: string): "product" | "collection" | "page" | "article" | "policy" | "templates" {
  // The whole theme-content family (templates + system / delivery / sellingPlans
  // / onlineStoreExtras) reloads through the single-group theme-content path
  // (api.sync-single-resource → syncSingleThemeGroup, which is now domain-aware).
  // Without this, non-templates rubrics posted their raw contentType and the
  // route rejected it ("Unknown resource type: sellingPlans").
  if (isThemeContentType(contentType)) return "templates";
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

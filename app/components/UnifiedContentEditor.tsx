/**
 * Unified Content Editor Layout
 *
 * Generic layout component for all content types (collections, blogs, pages, policies)
 * Based on the products page structure with all bug fixes included.
 */

import { isThemeContentType } from "~/utils/content-type-groups";
import { isAttributeField } from "~/services/content-attributes.shared";
import {
  groupDetailsFields,
  shouldRenderDetailsSections,
  detailsSectionLabel,
} from "~/config/details-sections";

/**
 * Attribute field types that need the editor's full width.
 *
 * Everything else is a short answer — a vendor, a status, a template name — and
 * shares a row. These four are lists or panels: a tag combobox with chips, a
 * membership picker, the rule builder and the stock panel all grow downwards
 * and would be squeezed into a column half their useful width.
 */
const WIDE_ATTRIBUTE_FIELDS = new Set(["tags", "collections", "collectionRules", "commerce"]);
import { useCommerceSaveRegistry } from "../contexts/CommerceSaveContext";
import { getReloadResourceType } from "~/utils/reload-resource-type";
import { useCreateItem } from "../hooks/useCreateItem";
import { CreateItemModal } from "./create/CreateItemModal";
import { CreateResultBanner } from "./create/CreateResultBanner";
import { CreateResourceChooser } from "./create/CreateResourceChooser";
import type { CreatableResource, DeletableResource } from "../config/create-fields.config";
import { useDeleteItem } from "../hooks/useDeleteItem";
import { DeleteItemModal } from "./create/DeleteItemModal";
import { useDuplicateItem } from "../hooks/useDuplicateItem";
import { useRouteLoaderData } from "react-router";
import { rulesAvailableOn, RULES_MIN_API_VERSION } from "../config/collection-rules.shared";
import { buildAttributeChecklist, needsAttributeSync } from "../services/attribute-checklist.shared";
import { DuplicateItemModal } from "./create/DuplicateItemModal";
import { ItemStatusSwitch } from "./unified/ItemStatusSwitch";
import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import type { RenderedGroupField } from "../types/content-editor.types";
import { Page, Card, Text, BlockStack, InlineStack, Button, Modal, TextContainer, TextField, Icon, Spinner, Checkbox } from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
import { useSeoSettings } from "../contexts/SeoSettingsContext";
import { UnifiedItemList } from "./unified/UnifiedItemList";
import { UnifiedFieldRenderer } from "./UnifiedFieldRenderer";
import { UnifiedLanguageBar, shouldRenderLanguageBar } from "./unified/UnifiedLanguageBar";
import { MarketPublicationNotice } from "./unified/MarketPublicationNotice";
import { MobileToolbar } from "./unified/MobileToolbar";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { OptionsField } from "./unified/OptionsField";
import { MetafieldsField } from "./unified/MetafieldsField";
import { ReloadButton } from "./ReloadButton";
import { AppSaveBar } from "./AppSaveBar";
import type { SubResourceState, SubResourceHandlers } from "../hooks/useProductSubResources";
import { HelpTooltip } from "./HelpTooltip";
import { ItemSidebar } from "./ItemSidebar";
import { SidebarTabBar } from "./SidebarTabBar";
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
import { countImagesWithAltForLocale } from "../utils/field-validation.utils";
import type { MetaobjectEntry, ValidationOverlays } from "../utils/contentEditor.utils";
import { isGidOfResource } from "../config/create-fields.config";
import {
  metaobjectFieldValueFor,
  type MetaobjectDefinitionFieldLike,
  type MetaobjectEntryLike,
} from "../services/metaobject-fields.shared";
import { useI18n } from "../contexts/I18nContext";
import { CommerceDataProvider } from "../contexts/CommerceDataContext";
import { CommerceVariantsSection } from "./unified/CommerceVariantsSection";
import { LocaleAvailabilityProvider } from "../contexts/LocaleAvailabilityContext";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { ENABLE_THEME_PRIMARY_EDIT } from "../config/constants";
import { useGlobalActionState, useLoadingFieldKeys } from "../hooks/useAIOperationsStore";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
import "../styles/UnifiedContentEditor.css";
import "../styles/content-editor-global.css";
import type { ContentEditorConfig, UseContentEditorReturn, FieldDefinition, TranslatableContentItem, ShopLocale, ContentImage } from "../types/content-editor.types";
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
    /**
     * What is being paged, already translated and plural — "fields" when the
     * caller says nothing.
     *
     * The theme pages really do page FIELDS. The metaobjects tab pages ENTRIES
     * and each entry carries several fields, so the strip counted one thing and
     * named another: "Showing 1-25 of 40 fields" over a list of forty entries,
     * on the very page whose entries were already hard enough to tell from
     * their details.
     */
    noun?: string;
  } | null;

  /** Optional: Handler for field page changes */
  onFieldPageChange?: (page: number) => void;

  /** Optional: Handler for field search */
  onFieldSearch?: (search: string) => void;

  /** Placeholder for the search box above the fields — same reason as `noun`. */
  fieldSearchPlaceholder?: string;

  /** Optional: Loading state for field pagination */
  isFieldsLoading?: boolean;

  /**
   * An action on the CONTAINER the listed items belong to — today the
   * metaobject DEFINITION whose entries fill the page.
   *
   * A prop rather than a config flag because only the route knows the
   * container's id, and `disabledReason` is a string rather than a boolean so
   * a refusal always arrives with its cause: "why is this greyed out" is the
   * question a bare disabled button never answers.
   */
  containerAction?: {
    label: string;
    onAction: () => void;
    disabledReason?: string | null;
  } | null;

  /**
   * Optional: wrap each GROUP of dynamic fields in the page's own chrome.
   *
   * Fields carrying the same `groupId` are handed over together, in order, and
   * whatever comes back is rendered in their place. The metaobjects tab uses
   * it to draw one CARD per entry (title, handle, swatch, delete) around that
   * entry's controls -- chrome the generic editor has no business knowing
   * about. Without this prop nothing changes: the fields render as a flat list
   * exactly as before.
   *
   * Each entry carries its DEFINITION and its current VALUE next to the
   * rendered node, not just the node: a page that wants to put one control
   * somewhere else (the metaobjects card lifts the colour into its header)
   * has to be able to pick it out BY KEY rather than by position, and to paint
   * the live value beside it while the merchant is still typing.
   */
  renderFieldGroup?: (groupId: string, children: RenderedGroupField[]) => ReactNode;

  /**
   * Optional: values the create form opens with.
   *
   * The metaobjects tab uses it to preselect the TYPE the merchant is already
   * looking at. The picker stays visible -- they may have meant a different
   * type -- but asking again for something the page already knows is how the
   * create button came to feel like a detour.
   */
  createPrefill?: Record<string, string>;

  /**
   * Optional: lock every dynamic field, with the page saying why elsewhere.
   *
   * The metaobjects tab uses it for a definition Shopify does not let this app
   * write (§7.2). It is one flag rather than one per field because this page
   * shows one definition at a time, and an editor that can save some of its
   * controls and not others has to explain that per control -- which is the
   * card's job, not the field's.
   */
  fieldsReadOnly?: boolean;

  /**
   * Optional: told after a successful create, INCLUDING when the cache sync
   * failed (`synced: false`). The editor's own handling stays as it was; a page
   * that keeps its own list (the metaobjects entries) needs to reload it, and
   * "created but not synced" is precisely the case where it must NOT jump to
   * the new object.
   */
  onItemCreated?: (info: { id: string; resource: string; synced: boolean; title: string | null }) => void;

  /**
   * Optional: the group ids to render, in order — INCLUDING groups that have
   * no editable field at all.
   *
   * Deriving the order from the fields alone would drop exactly the entry with
   * nothing editable on it, and an entry that silently disappears is the bug
   * this whole page is being fixed for. With no value here the order comes
   * from the fields themselves.
   */
  fieldGroupOrder?: string[];

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
  /** PLAN §Phase 3.2 — shop currency for the `money` field's suffix. Shop-wide,
   *  so it is passed once rather than resolved per field. */
  currencyCode?: string;
  /** PLAN §Phase 3.1 — the Shopify API version this app talks to. The rule
   *  editor needs 2026-07; below that it renders its reason instead. */
  apiVersion?: string;
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
    currencyCode,
    apiVersion,
    planLimit,
    fieldPagination,
    fieldSearchPlaceholder,
    onFieldPageChange,
    onFieldSearch,
    isFieldsLoading = false,
  containerAction,
  renderFieldGroup,
    createPrefill,
    fieldsReadOnly = false,
    onItemCreated,
    fieldGroupOrder,
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

  // Resizable SEO/bulk sidebar. `null` means "not dragged yet" and renders the
  // DEFAULT width straight from --app-editor-sidebar-width (responsive.css
  // :root) — so the default, like every other width in the app, is stated in
  // exactly one place and this panel can be reused elsewhere without carrying a
  // number along. Once dragged, the state holds real pixels.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const sidebarWidthRef = useRef<number | null>(null);
  const sidebarElRef = useRef<HTMLDivElement | null>(null);
  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = sidebarElRef.current;
    if (!el) return;
    const startX = e.clientX;
    // Before the first drag there is no state to start from — measure what the
    // CSS default actually rendered as, rather than restating the number.
    const startWidth = sidebarWidthRef.current ?? el.getBoundingClientRect().width;
    // Drag bounds come from the same :root tokens. Read per drag (cheap, and
    // picks up a breakpoint override); a token that isn't a px value simply
    // drops its half of the clamp instead of producing NaN.
    const styles = getComputedStyle(el);
    const readPx = (name: string) => {
      const parsed = parseFloat(styles.getPropertyValue(name));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const minWidth = readPx("--app-editor-sidebar-min-width");
    const maxWidth = readPx("--app-editor-sidebar-max-width");
    const onMouseMove = (ev: MouseEvent) => {
      let newWidth = startWidth + (startX - ev.clientX);
      if (maxWidth !== null) newWidth = Math.min(maxWidth, newWidth);
      if (minWidth !== null) newWidth = Math.max(minWidth, newWidth);
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

  // PLAN §Phase 3 — the shop's existing tags, for the `tags` field's
  // autocomplete. Derived from the ALREADY-LOADED list rather than fetched:
  // a tag vocabulary is worth suggesting precisely because it is in use, and
  // the items on screen are the ones using it. Capped so a catalogue with
  // thousands of one-off tags does not turn the picker into a wall.
  const tagSuggestions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const item of items as unknown as Array<{ tags?: unknown }>) {
      if (!Array.isArray(item?.tags)) continue;
      for (const raw of item.tags as string[]) {
        const tag = String(raw).trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        const seen = counts.get(key);
        if (seen) seen.count += 1;
        else counts.set(key, { label: tag, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 50)
      .map((entry) => entry.label);
  }, [items]);

  // PLAN §2.4 — the SAME discriminator the sidebar checklist gates on, applied
  // to the editable controls. `undefined` (a type with no attribute block, or a
  // loader that does not carry the stamp) reads as known: only an explicit
  // absence of the stamp means "these are the migration's defaults".
  const itemAttributesKnown =
    selectedItem && "attributesSyncedAt" in (selectedItem as unknown as Record<string, unknown>)
      ? !!(selectedItem as unknown as { attributesSyncedAt?: unknown }).attributesSyncedAt
      : undefined;

  const { plan, getMaxProducts, getNextPlanUpgrade } = usePlan();
  const { showInfoBox } = useInfoBox();
  const { registerItems, clearItems } = useItemSelector();

  // Combined reload handler: refresh main editor + sub-resources
  /** Set once the registry below exists — `handleReloadComplete` is declared
   *  before it and a ref is cheaper than reordering the whole component. */
  const commerceSaveRef = useRef<(() => void) | null>(null);

  const handleReloadComplete = useCallback(() => {
    helpers.triggerDataRefresh();
    subResourceHandlers?.resetForReload?.();
    // The stock panel reads LIVE from its own endpoint, so a cache refresh
    // does not reach it. It used to carry a third Reload button for that;
    // the signal goes down from the editor's buttons instead.
    commerceSaveRef.current?.();
  }, [helpers, subResourceHandlers]);

  // Use effective field definitions (dynamic for templates, static for other content types)
  const fieldDefinitions = effectiveFieldDefinitions || config.fieldDefinitions;

  /**
   * The one field that decides whether an item is visible in the shop, lifted
   * out of the field list and into the action bar — it is the answer merchants
   * look for first, and hunting for it among twenty text fields is not that.
   *
   * Which field that IS differs per type, and two of the five have none:
   *
   *   products           `status`, four values. Only ACTIVE ⇄ DRAFT is a
   *                      toggle; UNLISTED and ARCHIVED are real states this
   *                      app must not silently overwrite, so the switch locks
   *                      and says which state it is in.
   *   pages, articles    `isPublished`, a true toggle.
   *   collections        visibility lives in publications, which this app has
   *                      no scope for — there is nothing honest to show.
   *   blogs, policies,   no such field at all.
   *   theme content
   *
   * Derived from the CONFIG rather than hardcoded per content type: a type
   * that gains one of these fields gets the switch without anyone remembering.
   */
  const statusControl = useMemo(() => {
    const has = (key: string) => fieldDefinitions.some((f) => f.key === key);
    if (config.contentType === "products" && has("status")) {
      return { fieldKey: "status", kind: "status" as const };
    }
    if (has("isPublished")) return { fieldKey: "isPublished", kind: "published" as const };
    return null;
  }, [config.contentType, fieldDefinitions]);

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

  /**
   * The stock/channels panel registers itself here, so the ONE save bar drives
   * it alongside the content save and the sub-resource save. The panel keeps
   * its own state and its own endpoint — a volatile quantity must not travel in
   * the editor's value map — but it no longer carries a second Save button.
   */
  const commerceSave = useCommerceSaveRegistry();
  commerceSaveRef.current = commerceSave.requestReload;

  /**
   * Which fields this locale/type actually shows, and how one of them renders.
   *
   * Hoisted out of the JSX because the list is now split across TWO cards: the
   * item's TEXT stays in the main card, its merchandising attributes moved to a
   * card of their own below the product options and metafields. One renderer,
   * two call sites — duplicating the props of `UnifiedFieldRenderer` is how the
   * two halves would start behaving differently.
   */
  const visibleFields = useMemo(() => {
    return fieldDefinitions.filter((field) => {
      // The status/visibility control lives in the action bar above — ONE
      // control per value. Two of them on one screen invite the question which
      // counts, and the answer ("both, they write the same field") is not one a
      // merchant should have to work out.
      if (statusControl && field.key === statusControl.fieldKey) return false;
      return true;
    });
  }, [fieldDefinitions, statusControl]);

  // Three splits, not two. The item's TEXT stays in the main card; the three
  // fields Shopify's own admin groups under "Search engine listing" (SEO
  // title, meta description, URL handle) get a card right below it; the
  // merchandising attributes keep theirs at the bottom. The search-engine
  // split is config-driven (`card: "searchEngine"`) rather than a key list,
  // so a dynamic field that happens to be called `handle` cannot fall into
  // it.
  const contentFields = useMemo(
    () => visibleFields.filter((f) => !isAttributeField(f) && f.card !== "searchEngine"),
    [visibleFields]
  );
  const searchEngineFields = useMemo(
    () => visibleFields.filter((f) => f.card === "searchEngine"),
    [visibleFields]
  );
  const attributeFields = useMemo(() => visibleFields.filter((f) => isAttributeField(f)), [visibleFields]);

  // The Details card's own split into subcards. Derived from the ALREADY
  // filtered list, so a section whose fields all dropped out (the status
  // control is hoisted into the action bar, the default price only exists for
  // a single-variant product) simply never appears.
  const detailsSections = useMemo(() => groupDetailsFields(attributeFields), [attributeFields]);
  const renderDetailsSections = shouldRenderDetailsSections(detailsSections);

  /**
   * Primary-language editing writes to a theme file (themeFilesUpsert), which
   * only exists for the `theme` domain. Read-only when that is off, when the
   * rubric is a resource-backed theme-content family member (their original
   * lives in the Shopify admin and the server rejects primary saves), or for
   * app-embed technical fields, which are locked in every locale.
   */
  const isFieldReadOnly =
    (isThemeContentType(config.contentType) &&
      state.currentLanguage === primaryLocale &&
      (!ENABLE_THEME_PRIMARY_EDIT || config.contentType !== "templates")) ||
    isEmbedTechnical ||
    // §7.2 — the page knows this definition refuses our writes.
    fieldsReadOnly;

  const renderEditorField = (field: FieldDefinition) => (
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
          sourceTextAvailable={!!selectedItem && !!getSourceText(selectedItem, field.key, primaryLocale)}
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
          tagSuggestions={tagSuggestions}
          attributesKnown={itemAttributesKnown}
          currencyCode={currencyCode}
          apiVersion={apiVersion}
          onReloadAttributes={() => { void handleSyncAll(); }}
        />
  );

  /**
   * The Details card's field grid: two columns where a field does not need a
   * line of its own. A vendor is one word and a status is one dropdown; giving
   * each the full width of the editor turned eight short answers into eight
   * rows of mostly empty space. The wide ones keep the full width — a tag list,
   * a membership picker and the stock panel all use it.
   */
  const renderAttributeGrid = (fields: FieldDefinition[]) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: "1rem",
        alignItems: "start",
      }}
    >
      {fields.map((field) => (
        <div
          key={field.key}
          style={WIDE_ATTRIBUTE_FIELDS.has(field.type) ? { gridColumn: "1 / -1" } : undefined}
        >
          {renderEditorField(field)}
        </div>
      ))}
    </div>
  );

  /** One dynamic field, with the product image gallery's replacement slot. */
  const renderContentField = (field: FieldDefinition): ReactNode => {
    if (field.type === "image-gallery" && imageGalleryReplacement) {
      return <div key={field.key}>{imageGalleryReplacement}</div>;
    }
    return renderEditorField(field);
  };

  /**
   * The dynamic fields, bucketed by `groupId`, in the order `fieldGroupOrder`
   * names — or first-appearance order when it does not.
   *
   * `fieldGroupOrder` also contributes EMPTY groups: an entry whose fields are
   * all read-only still gets its card, with the card saying why it is empty.
   */
  const groupedContentFields = useMemo((): Array<[string, FieldDefinition[]]> => {
    const buckets = new Map<string, FieldDefinition[]>();
    for (const id of fieldGroupOrder ?? []) buckets.set(id, []);
    for (const field of contentFields) {
      const id = field.groupId ?? field.key;
      const bucket = buckets.get(id);
      if (bucket) bucket.push(field);
      else buckets.set(id, [field]);
    }
    return [...buckets.entries()];
  }, [contentFields, fieldGroupOrder]);

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

  // ── PLAN_CONTENT_CREATION §1.1/§1.2 — the "+" button ────────────────────
  // The tab declares WHAT it can create; the gate decides whether it may.
  // Both refusals stay visible-and-disabled with their own reason: a hidden
  // button reads as a missing feature, and "limit reached" shown to someone
  // whose plan simply lacks the type sends them deleting things that will not
  // help (§1.2).
  const createResources = (config.createSupport?.resources ?? []) as CreatableResource[];
  const [chooserOpen, setChooserOpen] = useState(false);
  /**
   * §2.5a — the shop's published locales minus the primary one.
   *
   * `state.enabledLanguages` is the merchant's per-session SELECTION and can be
   * narrower; the create dialog's promise is "into all languages", so it uses
   * the shop's own list. An empty result means the shop has one locale, which
   * is what disables the checkbox rather than hiding it.
   */
  const createTargetLocales = useMemo(
    () => shopLocales.filter((l) => !l.primary).map((l) => l.locale),
    [shopLocales],
  );

  const createItem = useCreateItem({
    plan,
    resources: createResources,
    atLimit: finalPlanLimit.isAtLimit,
    targetLocales: createTargetLocales,
    // The chained translation lands in the DB after the create's own
    // revalidation has already run, so the list needs a second look.
    onTranslated: () => revalidator?.revalidate(),
    onCreated: (info) => {
      // A page with its own sub-list hears about EVERY create, synced or not:
      // it is the "not synced" case that decides whether it may jump to the
      // new object, so withholding it would leave that decision unmade.
      onItemCreated?.({ id: info.id, resource: info.resource, synced: info.synced, title: info.title });
      // §1.6: select the new item and refresh. When the cache sync failed the
      // item is NOT in the list yet — the banner says so and offers a reload
      // rather than pretending the create failed.
      if (!info.synced) return;
      // The metaobjects tab lists TYPES (`metaobject_type_<type>`), not
      // entries, so the new entry's GID matches no row — selecting it would
      // silently clear the selection. Refresh and leave the selection alone.
      if (info.resource !== "metaobject") handleItemSelectRef.current(info.id);
      revalidator?.revalidate();
    },
  });

  // registerItems() sets context state on every call, and every consumer
  // re-renders when it does. Depending that effect on a callback whose
  // identity changes each render is therefore not a missing-dep nicety but an
  // infinite loop. The handler goes through a ref so the effect can depend on
  // VALUES only.
  const handleAddItemRef = useRef<() => void>(() => {});
  const stableAddItem = useCallback(() => handleAddItemRef.current(), []);

  // The ONE delete path. Offered on the same tabs that can create — the types
  // this app cannot create are exactly the ones Shopify has no delete API for.
  // §1.4b — the rule editor needs `sources[]`, which exists from API 2026-07.
  // Below that only manual collections are creatable, and the type choice says
  // so instead of offering an editor whose payload would be refused.
  const appData = useRouteLoaderData("routes/app") as { shopifyApiVersion?: string } | undefined;
  const rulesAvailable = rulesAvailableOn(appData?.shopifyApiVersion ?? "");

  const deleteItem = useDeleteItem({
    onDeleted: (target) => {
      // The selection now points at something that no longer exists.
      handleItemSelectRef.current("");
      revalidator?.revalidate();
      showInfoBox(
        (t.content?.deletedMessage || "“{name}” was deleted.").replace("{name}", target.title || target.id),
        "success",
        t.content?.success || "Success!",
      );
    },
  });

  /**
   * Which resource a given item id IS — the blogs tab holds two kinds.
   *
   * `null` means "this item is not a deletable object", and that is a real
   * answer, not a fallback: the metaobjects tab lists TYPES
   * (`metaobject_type_<type>`), which have no delete API at all. It used to
   * return the tab's single create-resource for ANY id, so the type row got a
   * Delete button that reached `deleteContent` with a pseudo id and 400d —
   * after the merchant had typed the type name into the confirmation. The id
   * now has to carry the resource's own GID segment.
   */
  const resourceOfItem = useCallback(
    (itemId: string): DeletableResource | null => {
      if (itemId.includes("/Blog/")) return "blog";
      if (itemId.includes("/Article/")) return "article";
      const single = createResources.length === 1 ? createResources[0] : null;
      if (single && isGidOfResource(itemId, single)) return single;
      return null;
    },
    [createResources],
  );

  const handleDeleteItem = useCallback(
    (itemId: string) => {
      const resource = resourceOfItem(itemId);
      if (!resource) return;
      const item = unifiedItems.find((i) => i.id === itemId);
      deleteItem.request({
        id: itemId,
        title: (item?.title as string) || itemId,
        resource,
      });
    },
    [resourceOfItem, unifiedItems, deleteItem],
  );

  // §1.9 — "create like this one". Products and collections duplicate
  // SERVER-side (Shopify carries variants, media, metafields and publications
  // across); the other types prefill the ordinary create form from the cache,
  // because Shopify has no duplicate mutation for them and a copy is not a
  // different operation.
  const duplicateItem = useDuplicateItem({
    onDuplicated: (outcome) => {
      if (outcome.pending || !outcome.id) {
        // Honest: the copy is still being assembled. Selecting it now would
        // show an empty editor and invite a second duplicate.
        showInfoBox(
          t.content?.duplicatePending ||
            "The copy is being created. Reload in a moment to see it.",
          "info",
        );
        return;
      }
      handleItemSelectRef.current(outcome.id);
      revalidator?.revalidate();
    },
  });

  const handleDuplicateItem = useCallback(
    (itemId: string) => {
      const item = unifiedItems.find((i) => i.id === itemId);
      const title = (item?.title as string) || "";
      if (itemId.includes("/Product/")) {
        duplicateItem.request({ sourceId: itemId, sourceTitle: title, resource: "product" });
        return;
      }
      if (itemId.includes("/Collection/")) {
        duplicateItem.request({ sourceId: itemId, sourceTitle: title, resource: "collection" });
        return;
      }
      // Prefill path: page / article / blog. Straight into the create form
      // with the source's values, through the ordinary createContent action.
      const resource = itemId.includes("/Blog/")
        ? "blog"
        : itemId.includes("/Article/")
          ? "article"
          : itemId.includes("/Page/")
            ? "page"
            : null;
      if (!resource) return;
      const prefill: Record<string, string> = {};
      const source = item as Record<string, unknown> | undefined;
      if (title) prefill.title = `${title} (copy)`;
      for (const [from, to] of [["body", "body"], ["summary", "summary"], ["description", "descriptionHtml"]] as const) {
        const value = source?.[from];
        if (typeof value === "string" && value) prefill[to] = value;
      }
      // Deliberately NOT copied: handle (it must be unique) and the SEO
      // fields (a duplicated meta description is a duplicate-content finding
      // in this app's own crawl report).
      createItem.open(resource, prefill);
    },
    [unifiedItems, duplicateItem, createItem],
  );


  const handleAddItem = useCallback(() => {
    if (createResources.length === 0) return;
    // One creatable resource opens its form directly; the blogs tab has two
    // (an article and the blog it lives in) and asks first.
    if (createResources.length === 1) {
      createItem.open(createResources[0], createPrefill);
      return;
    }
    setChooserOpen(true);
  }, [createResources, createItem, createPrefill]);
  handleAddItemRef.current = handleAddItem;

  const createDisabledReason = useMemo(() => {
    if (createResources.length === 0 || createItem.anyAllowed) return null;
    const refused = createItem.gates.find((g) => !g.gate.allowed)?.gate;
    if (!refused || refused.allowed) return null;
    if (refused.reason === "planContentType") {
      return t.content?.createPlanContentType || "Your plan does not include this content type.";
    }
    if (refused.reason === "planLimit") {
      return t.content?.createPlanLimit || "You have reached your plan's limit for this content type.";
    }
    return t.content?.createUnavailable || "Creating is not available here.";
  }, [createResources.length, createItem.anyAllowed, createItem.gates, t.content]);

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
    if (!config.showItemSidebar) return null;

    const itemAny = item as any;
    const isBlogContainer = !!itemAny.isBlogContainer;

    // Calculate image alt text stats for SEO score
    // Include featured image if no gallery images exist (e.g. articles)
    const images = (item as TranslatableContentItem & { images?: ContentImage[] }).images ?? [];
    const featuredImg = (item as TranslatableContentItem & { featuredImage?: ContentImage }).featuredImage;
    // The same list useEditorAltText indexes its alt-text state by: the gallery
    // when it has entries, otherwise the single featured image at index 0.
    const scoredImages: ContentImage[] =
      images.length > 0 ? images : featuredImg ? [featuredImg] : [];
    const totalImages = scoredImages.length;
    // Per LOCALE, not per item: in a foreign language an image only counts as
    // covered when its alt text is TRANSLATED. Counting the primary alt made
    // the sidebar's image block score identically in every language, so a
    // product with no alt translations at all still read "all images have alt
    // text" — while the SEO dashboard, reading the same locale's
    // ProductImageAltTranslation rows, reported them as missing.
    const imagesWithAlt = countImagesWithAltForLocale(
      scoredImages,
      state.currentLanguage,
      primaryLocale,
      state.imageAltTexts,
    );

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

    // Target-keyword tracking is per (item, locale): a French page ranks for
    // French terms, so the panel follows the editor's language instead of
    // disappearing on every locale but the primary — which is what it used to
    // do, leaving no way to enter foreign-language keywords at all. `""` is the
    // SeoKeyword convention for the primary locale.
    const keywordResourceType = !isBlogContainer
      ? getKeywordResourceType(config.contentType)
      : undefined;
    const keywordLocale = state.currentLanguage === primaryLocale ? "" : state.currentLanguage;

    // ── PLAN_CONTENT_CREATION §2 — the attribute checklist ────────────────
    // Only the four types that HAVE merchandising attributes; everything else
    // gets no tab rather than an empty one.
    const attributeResource =
      config.contentType === "products" ? "product"
      : config.contentType === "collections" ? "collection"
      : config.contentType === "pages" ? "page"
      : config.contentType === "blogs" && !isBlogContainer ? "article"
      : null;

    const attributes = attributeResource
      ? (() => {
          const row = item as unknown as Record<string, unknown>;
          const checklistRows = buildAttributeChecklist({
            resource: attributeResource,
            // THE gate. Absent on an item the route does not carry it on,
            // which is the honest "we have not fetched this" rather than a
            // pile of red findings (§2.4).
            attributesSyncedAt: (row.attributesSyncedAt as string | null | undefined) ?? null,
            status: (row.status as string | null | undefined) ?? null,
            vendor: (row.vendor as string | null | undefined) ?? null,
            productType: (row.productType as string | null | undefined) ?? null,
            categoryName: (row.categoryName as string | null | undefined) ?? null,
            tags: (row.tags as string[] | null | undefined) ?? null,
            collectionCount: Array.isArray(row.collections) ? (row.collections as unknown[]).length : null,
            hasMoreCollections: row.hasMoreCollections === true,
            defaultVariantPrice: (row.defaultVariantPrice as string | null | undefined) ?? null,
            sortOrder: (row.sortOrder as string | null | undefined) ?? null,
            author: (row.author as string | null | undefined) ?? null,
            isPublished: (row.isPublished as boolean | null | undefined) ?? null,
            featuredImageUrl: (row.featuredImageUrl as string | null | undefined) ?? primaryImageUrl ?? null,
            templateSuffix: (row.templateSuffix as string | null | undefined) ?? null,
            hasKeyword: null,
          });
          return {
            rows: checklistRows,
            needsSync: needsAttributeSync(checklistRows),
            onReload: () => { void handleSyncAll(); },
            // §2.4 — tags, vendor and category are not translatable, so acting
            // on a finding here while a translation is selected would edit the
            // primary value from a screen that says otherwise.
            readOnlyReason:
              state.currentLanguage !== primaryLocale
                ? t.content?.attributesForeignLocale ||
                  "These details exist once per item, not per language. Switch to the primary language to change them."
                : null,
          };
        })()
      : undefined;

    return (
      <ItemSidebar
        attributes={attributes}
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
        keywordLocale={keywordLocale}
        contentLocale={state.currentLanguage}
        keywordLocaleName={
          shopLocales.find((l) => l.locale === state.currentLanguage)?.name || state.currentLanguage
        }
        onInsertKeywords={handlers.handleInsertKeywords}
        insertKeywordsLoading={handlers.isInsertingKeywords}
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
      // §1.2 — the SAME entry point on mobile. Without it the "+" lives only
      // on the desktop list and creating is unreachable on a phone.
      onAddItem: createResources.length > 0 ? stableAddItem : null,
      addDisabledReason: createDisabledReason,
      // The mobile mirror said `Add ${resourceName.singular}` in bare English,
      // which on this tab named "Metaobject Type" -- the one object this app
      // cannot create. It takes the same label the desktop bar shows.
      addLabel: config.createSupport?.fromActionBar
        ? t.content?.createEntryButtonLabel
        : t.content?.createButtonLabel,
      t: {
        searchPlaceholder: t.content?.searchPlaceholder,
        noResults: t.content?.noResults || "No items found",
        selectItem: t.content?.selectItem || `Select ${translatedResourceName.singular}`,
      },
    });
  }, [unifiedItems, state.selectedItemId, translatedResourceName.singular, translatedResourceName.plural, createResources.length, stableAddItem, createDisabledReason]);

  // Cleanup: clear items when component unmounts
  useEffect(() => {
    return () => { clearItems(); };
  }, [clearItems]);

  // Below 1100px the sidebar column is hidden by CSS, so its content is only
  // reachable through the nav toggle. Tell the nav a sidebar exists (and take
  // the registration back on unmount — the toggle would otherwise survive onto
  // a page that has no sidebar at all).
  const hasSidebar = !!selectedItem && !!config.showItemSidebar;
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
    {/* The stock panel registers its save through this — see the save bar. */}
    <commerceSave.Provider value={commerceSave.value}>
    {/* One live load, one set of pending edits, one registration — consumed by
        the channels field in the attributes card AND by the variants section
        inside the variants card. Two loads would mean two `compareQuantity`
        baselines for the same stock. */}
    <CommerceDataProvider
      productId={config.contentType === "products" ? String(selectedItem?.id ?? "") : ""}
      isPrimaryLocale={state.currentLanguage === primaryLocale}
      t={{
        ...((t.content?.commerce ?? {}) as Record<string, string>),
        warnings: (t.content?.commerceWarnings ?? {}) as Record<string, string>,
        // The shared enum vocabulary — this panel's weight unit is the same
        // kind of value as the status and sort-order options above.
        enumLabels: (t.content?.enumLabels ?? {}) as Record<string, string>,
      }}
    >
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
        // The width class states the choice rather than leaving it implicit
        // (responsive.css :root owns both tokens): WITH the item sidebar the
        // editor is a three-column workbench and takes the whole width; WITHOUT
        // it nothing caps the middle column and it just keeps growing on a wide
        // screen, so the page is capped at --app-page-width-with-list — the
        // item column PLUS the reading width, so the editor beside the list is
        // as wide as an SEO page rather than that width minus the list.
        // Left-aligned, so the item list stays flush with the gutter.
        // Keyed on config, not on `hasSidebar`: the latter also drops when no
        // item is selected, and the page must not change width on selection.
        className={`unified-content-editor-layout ${config.showItemSidebar ? "app-page-width-full" : "app-page-width-start"}${sidebarPanelOpen && hasSidebar ? " sidebar-panel-open" : ""}`}
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
          // The column gap is the page gutter — the same token, not a second
          // 16px: --app-page-width-with-list is derived from it (responsive.css
          // :root), so a gap that drifts would make the cap come out wrong.
          gap: "var(--app-page-padding)",
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
            {/* Duplicate and Delete are NOT passed any more: they moved to the
            editor's action bar. Above a LIST they looked like list actions
            while acting on whichever row happened to be selected. */}
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
          // Suppressed where the ACTION BAR carries create: the config comment
          // argues that a "+" over a list of TYPES reads as "add a type", and
          // leaving it standing next to the new button would have left exactly
          // the click that lands in the wrong form.
          showAddButton={createResources.length > 0 && !config.createSupport?.fromActionBar}
          onAddItem={handleAddItem}
          // Visible-but-disabled with the reason, the same as the mobile path.
          // Labelling it without disabling it let a merchant fill in a whole
          // form only to meet a 403 — and made the two entry points disagree.
          addButtonDisabled={!!createDisabledReason}
          addButtonLabel={createDisabledReason || t.content?.createButtonLabel || "Create"}
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
                hasChanges={state.hasChanges || (subResourceState?.hasChanges ?? false) || commerceSave.hasChanges}
                loading={state.isSavingCurrentItem || (subResourceState?.isSaving ?? false)}
                onSave={() => {
                  // Guard against double-submit: a long-running image save
                  // (up to ~38s for big 3D models) must not fire a duplicate
                  // /api/update-variant-galleries POST (→ Shopify 422 on the
                  // duplicate productCreateMedia for the same staging URL).
                  if (state.isSavingCurrentItem || subResourceState?.isSaving) return;
                  handlers.handleSave();
                  subResourceHandlers?.saveSubResources?.();
                  // Third writer, same button. Its failures surface INSIDE the
                  // panel (a refused stock write names the number that moved),
                  // so nothing is awaited here and nothing can fail the save.
                  void commerceSave.save?.();
                }}
                onDiscard={() => {
                  handlers.handleDiscard();
                  subResourceHandlers?.resetChanges?.();
                  // Third writer, same button — as with Save. Without this a
                  // discarded quantity stayed in the input AND kept the bar
                  // visible, and the next unrelated Save fired the stock write
                  // the merchant thought they had dropped.
                  commerceSave.discard();
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
                  reloadResourceType={getReloadResourceType(config.contentType, selectedItem.id)}
                  reloadLocale={state.currentLanguage}
                  onReloadComplete={handleReloadComplete}
                  revalidator={revalidator}
                  // Mirror of the desktop action bar — see `statusControl`.
                  // The status field is no longer in the form, so without this
                  // a phone could not reach it at all.
                  itemActions={{
                    ...(statusControl && selectedItem
                      ? (() => {
                          const value = helpers.getEditableValue(statusControl.fieldKey);
                          const checked =
                            statusControl.kind === "status"
                              ? value.toUpperCase() === "ACTIVE"
                              : value !== "false";
                          const foreign = state.currentLanguage !== primaryLocale;
                          // The SAME discriminator as the desktop control. An
                          // article cached before the attribute sync reads
                          // `isPublished: true` from the schema default, and a
                          // menu row saying "✓ Visible" would be that default
                          // presented as an answer — one tap from unpublishing
                          // an article whose state nobody ever measured.
                          const known =
                            statusControl.kind === "status" ||
                            (selectedItem as { attributesSyncedAt?: string | null }).attributesSyncedAt != null;
                          // UNLISTED / ARCHIVED are real states, and a two-way
                          // menu row would overwrite them on one tap.
                          const lockedStatus =
                            statusControl.kind === "status" &&
                            !["ACTIVE", "DRAFT"].includes(value.toUpperCase());
                          const toggle = (t.content?.statusToggle ?? {}) as Record<string, string>;
                          const enums = (t.content?.enumLabels ?? {}) as Record<string, string>;
                          // The row NAMES the state rather than showing a
                          // generic "Active" with a tick: on a phone there is
                          // no second control to disambiguate it, and UNLISTED
                          // rendered as unticked-Active is a lie.
                          const stateWord =
                            statusControl.kind === "status"
                              ? enums[`status.${(value || "DRAFT").toUpperCase()}`] ?? value
                              : checked
                                ? toggle.published || "Visible"
                                : toggle.hidden || "Hidden";
                          return {
                            statusLabel: known ? stateWord : toggle.unknown || "Status not loaded",
                            statusChecked: known && checked,
                            // Only the two-state half can be toggled from a
                            // menu row; a four-value enum needs the Select in
                            // the desktop bar, and the row says so instead of
                            // pretending otherwise.
                            statusDisabled: foreign || !known || lockedStatus,
                            statusHelp: foreign
                              ? t.content?.attributesForeignLocale
                              : !known
                                ? toggle.unknown
                                : lockedStatus
                                  ? enums[`status.${value.toUpperCase()}`]
                                  : checked
                                    ? statusControl.kind === "status" ? toggle.activeHint : toggle.publishedHint
                                    : statusControl.kind === "status" ? toggle.draftHint : toggle.unpublishedHint,
                            onToggleStatus: () =>
                              handlers.handleValueChange(
                                statusControl.fieldKey,
                                statusControl.kind === "status"
                                  ? (checked ? "DRAFT" : "ACTIVE")
                                  : (checked ? "false" : "true"),
                              ),
                          };
                        })()
                      : {}),
                    ...(selectedItem && resourceOfItem(selectedItem.id) !== null
                      ? {
                          onDuplicate: () => handleDuplicateItem(selectedItem.id),
                          duplicateLabel: t.content?.duplicateButtonLabel || "Duplicate",
                          onDelete: () => handleDeleteItem(selectedItem.id),
                          deleteLabel: t.content?.deleteButtonLabel || "Delete",
                        }
                      : {}),
                  }}
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

                    {/* Middle: what happens to the ITEM — visible/not, copy it,
                        delete it. Separated from the translate/clear actions on
                        the left, which act on its TEXT. Both used to live
                        elsewhere: the switch among twenty fields, the two
                        buttons over the item list, where they belonged to
                        whichever row happened to be selected. */}
                    <InlineStack gap="300" blockAlign="center">
                      {statusControl && selectedItem && (
                        <ItemStatusSwitch
                          kind={statusControl.kind}
                          value={helpers.getEditableValue(statusControl.fieldKey)}
                          onChange={(next) => handlers.handleValueChange(statusControl.fieldKey, next)}
                          // Visibility exists once per item, not per language —
                          // the same rule every other attribute follows.
                          disabled={state.currentLanguage !== primaryLocale}
                          disabledHint={
                            state.currentLanguage !== primaryLocale
                              ? t.content?.attributesForeignLocale
                              : undefined
                          }
                          // `isPublished` defaults to TRUE on a row an older
                          // sync wrote, so without this an unsynced draft would
                          // present itself as visible.
                          // A product's `status` is NOT part of the attribute
                          // block — it is non-null in the schema and predates
                          // it — so it is trustworthy on every row. Only the
                          // `isPublished` half needs the discriminator.
                          known={
                            statusControl.kind === "status" ||
                            (selectedItem as { attributesSyncedAt?: string | null }).attributesSyncedAt != null
                          }
                          optionLabels={(t.content?.enumLabels ?? {}) as Record<string, string>}
                          t={(t.content?.statusToggle ?? {}) as Record<string, string>}
                        />
                      )}
                      {selectedItem && resourceOfItem(selectedItem.id) !== null && (
                        <>
                          <Button size="slim" onClick={() => handleDuplicateItem(selectedItem.id)}>
                            {t.content?.duplicateButtonLabel || "Duplicate"}
                          </Button>
                          <Button size="slim" tone="critical" onClick={() => handleDeleteItem(selectedItem.id)}>
                            {t.content?.deleteButtonLabel || "Delete"}
                          </Button>
                        </>
                      )}
                    </InlineStack>

                    {/* Right: Reload Button (Save/Discard handled by the native
                        Shopify save bar — see AppSaveBar above) */}
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0, flexWrap: "nowrap" }}>
                      {/* Create, where the item list does not list what gets
                          created — see `createSupport.fromActionBar`. It calls
                          the SAME `handleAddItem` as the "+" above the list, so
                          the resource chooser and the prefill still apply and
                          there is no second create path. */}
                      {config.createSupport?.fromActionBar && createResources.length > 0 && (
                        <DisabledActionTooltip hint={createDisabledReason ?? undefined}>
                          <Button
                            size="slim"
                            variant="primary"
                            icon={PlusIcon}
                            disabled={!!createDisabledReason}
                            onClick={handleAddItem}
                          >
                            {t.content?.createEntryButtonLabel || "Add entry"}
                          </Button>
                        </DisabledActionTooltip>
                      )}
                      {/* Deleting the CONTAINER the entries live in — a
                          metaobject definition. Supplied by the route, and
                          DISABLED WITH ITS REASON rather than hidden wherever
                          it cannot be done. */}
                      {containerAction && (
                        <DisabledActionTooltip hint={containerAction.disabledReason ?? undefined}>
                          <Button
                            size="slim"
                            tone="critical"
                            icon={DeleteIcon}
                            disabled={!!containerAction.disabledReason}
                            onClick={containerAction.onAction}
                          >
                            {containerAction.label}
                          </Button>
                        </DisabledActionTooltip>
                      )}
                      <ReloadButton
                        resourceId={selectedItem.id}
                        resourceType={getReloadResourceType(config.contentType, selectedItem.id)}
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

              {/* The market selector raises a question neither toolbar can
                  answer: a product missing from the selected market's catalog
                  cannot be seen there, so every translation made for that
                  market is invisible by construction. OUTSIDE both toolbars on
                  purpose — the desktop one is `display: none` below 769px
                  while MobileToolbar offers the same selector, so a warning
                  inside either half would be missing from the other. Products
                  only (publications are a product thing here), and the
                  component itself stays silent whenever the answer is not
                  certain. */}
              {config.contentType === "products" && (
                <MarketPublicationNotice
                  productId={String(selectedItem?.id ?? "")}
                  selectedMarketId={state.selectedMarketId}
                  marketName={state.markets?.find((m) => m.id === state.selectedMarketId)?.name ?? ""}
                  notPublishedText={
                    t.content?.market?.notPublishedInMarket ||
                    "This product is not in the catalog of the market “{market}”, so nobody there can see it — translations for this market stay invisible until it is published there."
                  }
                />
              )}

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
                          placeholder={fieldSearchPlaceholder || t.content?.searchFields || "Search fields..."}
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
                              {fieldPagination.totalCount} {fieldPagination.noun || t.content?.fields || "fields"}
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

                    {/* Dynamic Fields — the item's TEXT. Its merchandising
                        attributes render in their own card further down.
                        With `renderFieldGroup` the page wraps each group of
                        them in its own chrome (the metaobjects tab draws one
                        card per entry); without it this is the flat list it
                        has always been. */}
                    {!isFieldsLoading && !renderFieldGroup && contentFields.map(renderContentField)}
                    {!isFieldsLoading && renderFieldGroup &&
                      groupedContentFields.map(([groupId, fields]) => (
                        <Fragment key={groupId}>
                          {renderFieldGroup(
                            groupId,
                            fields.map((field) => ({
                              field,
                              value: helpers.getEditableValue(field.key),
                              node: renderContentField(field),
                            })),
                          )}
                        </Fragment>
                      ))}

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

                {/* Search engine listing — Shopify's own name for the trio of
                    SEO title, meta description and URL handle. Directly below
                    the text they summarise, and above the cards that describe
                    the item rather than what it says. */}
                {searchEngineFields.length > 0 && !isFieldsLoading && (
                  <div style={{ marginTop: "1rem" }}>
                    <Card padding="400">
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          {t.content?.searchEngineListing || "Search engine listing"}
                        </Text>
                        {searchEngineFields.map((field) => renderEditorField(field))}
                      </BlockStack>
                    </Card>
                  </div>
                )}

                {/* Variants card. No `options.length > 0` gate: a product with
                    only the default single variant has NO options (the loader
                    drops Shopify's "Title" placeholder), and that is exactly
                    the product for which "add a variant" is the point. The
                    foreign-locale branch still renders nothing — there is no
                    translation to make. */}
                {config.contentType === "products" && subResourceState && subResourceHandlers && selectedItem && (
                  <div style={{ marginTop: "1rem" }}>
                    <OptionsField
                      options={selectedItem.options ?? []}
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
                      productId={selectedItem.id}
                      savedNonce={subResourceState.savedNonce}
                      footer={<CommerceVariantsSection />}
                      valuesToAdd={subResourceState.optionValuesToAdd}
                      linkedValuesToAdd={subResourceState.optionLinkedValuesToAdd}
                      valuesToDelete={subResourceState.optionValuesToDelete}
                      optionsToCreate={subResourceState.optionsToCreate}
                      optionsToDelete={subResourceState.optionsToDelete}
                      onAddOptionValue={subResourceHandlers.handleAddOptionValue}
                      onAddLinkedOptionValue={subResourceHandlers.handleAddLinkedOptionValue}
                      onRemoveLinkedOptionValue={subResourceHandlers.handleRemoveLinkedOptionValue}
                      onRemoveOptionValue={subResourceHandlers.handleRemoveOptionValue}
                      onEditPendingValue={subResourceHandlers.handleEditPendingValue}
                      onCreateOption={subResourceHandlers.handleCreateOption}
                      onCancelCreateOption={subResourceHandlers.handleCancelCreateOption}
                      onDeleteOption={subResourceHandlers.handleDeleteOption}
                      onReorderOptions={subResourceHandlers.handleReorderOptions}
                      onReorderOptionValues={subResourceHandlers.handleReorderOptionValues}
                      translatingFieldIds={subResourceState.translatingFieldIds}
                      missingTranslationIds={optionMissingTranslationIds}
                      t={{
                        title: t.products?.variantsTitle || t.products?.productOptions,
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
                        clearButton: t.products?.clearButton,
                        copyButton: t.products?.copy,
                        copyToAllLocalesButton: t.products?.copyToAllLocales,
                        addOption: t.products?.addOption,
                        optionNamePlaceholder: t.products?.optionNamePlaceholder,
                        deleteOption: t.products?.deleteOption,
                        deleteOptionConfirm: t.products?.deleteOptionConfirm,
                        deleteOptionTitle: t.products?.deleteOptionTitle,
                        editMetaobject: t.products?.editMetaobject,
                        choicesUnavailable: t.products?.choicesUnavailable,
                        choicesAllUsed: t.products?.choicesAllUsed,
                        choicesTruncated: t.products?.choicesTruncated,
                        choicesSyncedAt: t.products?.choicesSyncedAt,
                        loading: t.common?.loading,
                        deleteValueTitle: t.products?.deleteValueTitle,
                        deleteValueCount: t.products?.deleteValueCount,
                        deleteValueUnknown: t.products?.deleteValueUnknown,
                        pendingBadge: t.products?.pendingBadge,
                        done: t.common?.done,
                        cancel: t.common?.cancel,
                        add: t.common?.add,
                        valueLabel: t.products?.valueLabel,
                        addValue: t.products?.addValue,
                        removeValue: t.products?.removeValue,
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

                {/* Merchandising attributes — their own card, BELOW the
                    options and metafields. They are facts ABOUT the item
                    (status, vendor, tags, category, memberships, stock) rather
                    than things it says, and mixed into the text fields they
                    pushed the actual content off the first screen. */}
                {attributeFields.length > 0 && !isFieldsLoading && (
                  <div style={{ marginTop: "1rem" }}>
                    <Card padding="400">
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          {t.content?.attributesCardTitle || "Details"}
                        </Text>
                        {/* Subcards, the same nested-Card shape the Variants
                            card uses — but only once there are at least two of
                            them (`shouldRenderDetailsSections`): a page whose
                            only attribute is the theme template would otherwise
                            get a titled box inside a titled box. */}
                        {detailsSections.map((section) => {
                          // Keyed by the first field, NOT by the section id
                          // alone: a section split by another renders as two
                          // blocks, and two siblings keyed "organization" would
                          // collide and reconcile into each other's subcard.
                          const key = `${section.id ?? "unsectioned"}-${section.fields[0].key}`;
                          if (!renderDetailsSections || !section.id) {
                            return <Fragment key={key}>{renderAttributeGrid(section.fields)}</Fragment>;
                          }
                          return (
                            <Card key={key} background="bg-surface-secondary" padding="300">
                              <BlockStack gap="300">
                                <Text as="h3" variant="bodyMd" fontWeight="semibold">
                                  {detailsSectionLabel(t, section.id)}
                                </Text>
                                {renderAttributeGrid(section.fields)}
                              </BlockStack>
                            </Card>
                          );
                        })}
                      </BlockStack>
                    </Card>
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
        {selectedItem && config.showItemSidebar && (
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
        {selectedItem && config.showItemSidebar && (
          <div
            ref={sidebarElRef}
            className="seo-sidebar-container"
            style={{ width: sidebarWidth ?? "var(--app-editor-sidebar-width)", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
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
            {/* Section switch (Pro/Max image manager) */}
            {showImageManager && imageManager && (
              <SidebarTabBar
                size="md"
                items={[
                  { id: "seo", label: t.imageManager?.seoScoreTab ?? "SEO Score" },
                  { id: "images", label: t.imageManager?.imagesTab ?? "Image processing" },
                ]}
                activeId={imageManager.activeRightTab}
                onSelect={(id) => imageManager.onTabChange(id as "seo" | "images")}
                containerStyle={{ marginBottom: 8 }}
              />
            )}
            {/* Image-processing tabs. Same component and the same trailing "?"
                as the SEO card's own tab row one level over — the section used
                to carry a differently-styled bar and no help at all. */}
            {showImageManager && imageManager && imageManager.activeRightTab === "images" && (
              <SidebarTabBar
                items={[
                  { id: "bulkUpload", label: t.imageManager?.bulkUploadSubTab ?? "Bulk Upload" },
                  { id: "bulkAltText", label: t.imageManager?.bulkAltTextSubTab ?? "Bulk Alt Text" },
                ]}
                activeId={imageManager.activeImageSubTab}
                onSelect={(id) =>
                  imageManager.onImageSubTabChange(id as "bulkUpload" | "bulkAltText")
                }
                helpKey={
                  imageManager.activeImageSubTab === "bulkAltText"
                    ? "imageBulkAltText"
                    : "imageBulkUpload"
                }
                containerStyle={{ marginBottom: 4 }}
              />
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

      {/* §1.6 — the post-create box. Rendered even when the cache sync failed:
          the object EXISTS, and calling that an error is what produces a
          second click and a duplicate. */}
      {duplicateItem.target && (
        <DuplicateItemModal
          open={!!duplicateItem.target}
          onClose={duplicateItem.cancel}
          sourceTitle={duplicateItem.target.sourceTitle}
          newTitle={duplicateItem.newTitle}
          onNewTitleChange={duplicateItem.setNewTitle}
          onConfirm={duplicateItem.confirm}
          submitting={duplicateItem.submitting}
          error={duplicateItem.error}
          t={t.content?.duplicateModal}
        />
      )}

      {deleteItem.target && (
        <DeleteItemModal
          open={!!deleteItem.target}
          onClose={deleteItem.cancel}
          item={deleteItem.target}
          onConfirm={deleteItem.confirm}
          deleting={deleteItem.deleting}
          error={deleteItem.error}
          t={t.content?.deleteModal}
        />
      )}

      {createItem.created && (
        <div style={{ padding: "0 1rem 1rem" }}>
          <CreateResultBanner
            info={createItem.created}
            onDismiss={createItem.dismissCreated}
            // No undo. It was the §1.8 idea and it earned its removal: the
            // thing that was just created is deletable from its own card, with
            // the same confirmation, so a second path to the same delete only
            // added a destructive button to a SUCCESS banner.
            translating={createItem.translating}
            onReload={
              createItem.created.synced
                ? undefined
                : () => {
                    void handleSyncAll();
                    createItem.dismissCreated();
                  }
            }
            t={{
              createdTitle: t.content?.createdTitle,
              createdNotSyncedTitle: t.content?.createdNotSyncedTitle,
              createdNotSyncedBody: t.content?.createdNotSyncedBody,
              handleChanged: t.content?.createdHandle,
              reload: t.content?.reloadAllTooltip,
              translating: t.content?.createModal?.translatingAfterCreate,
              warnings: t.content?.createModal?.createWarnings,
            }}
          />
        </div>
      )}

      {/* PLAN_CONTENT_CREATION §1.1/§1.4 — create flow. Rendered at the page
          root so the modal is not clipped by the editor's overflow:hidden
          columns. */}
      {chooserOpen && (
        <CreateResourceChooser
          open={chooserOpen}
          onClose={() => setChooserOpen(false)}
          resources={createItem.gates}
          onChoose={(resource) => {
            setChooserOpen(false);
            createItem.open(resource);
          }}
          labels={t.content?.createResourceLabels}
          reasons={{
            planContentType: t.content?.createPlanContentType,
            planLimit: t.content?.createPlanLimit,
            unavailable: t.content?.createUnavailable,
          }}
          title={t.content?.createChooserTitle}
          cancel={t.content?.cancel}
        />
      )}

      {createItem.openResource && (
        <CreateItemModal
          open={!!createItem.openResource}
          onClose={createItem.close}
          resource={createItem.openResource}
          initialValues={createItem.initialValues}
          rulesAvailable={rulesAvailable}
          rulesUnavailableReason={
            rulesAvailable
              ? undefined
              : (t.content?.rulesNeedApiUpgrade ||
                  "Automated collections need Shopify API {version}. Until this app moves to it, you can create collections and pick their products yourself."
                ).replace("{version}", RULES_MIN_API_VERSION)
          }
          dynamicOptions={createItem.dynamicOptions}
          extraFieldsByOption={createItem.extraFieldsByOption}
          extraFieldsKey={createItem.openResource === "metaobject" ? "type" : undefined}
          // Opened from a type's own page, the type is fixed by the page. It
          // still travels in `initialValues` and is still submitted.
          lockedFieldKeys={
            createItem.openResource === "metaobject" && createItem.initialValues?.type ? ["type"] : undefined
          }
          blocked={
            createItem.openResource === "article" && createItem.needsBlogFirst
              ? {
                  message:
                    t.content?.createNeedsBlogFirst ||
                    "This shop has no blog yet. A post has to live in one, so create the blog first.",
                  actionLabel: t.content?.createResourceLabels?.blog || "Blog",
                  onAction: () => createItem.open("blog"),
                }
              : null
          }
          onSubmit={createItem.create}
          submitting={createItem.submitting}
          error={createItem.error}
          pendingNotice={createItem.pendingNotice}
          fieldErrors={createItem.fieldErrors}
          // The rule builder's strings live at the top level because the
          // editor's own rule FIELD renders the same builder — one block, two
          // surfaces, no drift.
          t={{
            ...(t.content?.createModal ?? {}),
            rules: t.collectionRules,
            // The modal titles itself "New {resource}". It used to interpolate
            // the config's own slug, which is an English word on every locale;
            // the chooser already carries translated resource names, so the
            // title reads from the SAME block rather than a second one.
            // With the type LOCKED, the dialog no longer shows which definition
            // the entry lands in — so the title says it instead of the generic
            // "Metaobject entry". Otherwise the resource's own name, as the
            // chooser already translates it.
            resourceLabel:
              createItem.openResource === "metaobject" && createItem.initialValues?.type && selectedItem
                ? selectedItem.title
                : (t.content?.createResourceLabels as Record<string, string> | undefined)?.[
                    createItem.openResource
                  ],
            // The metaobject field controls (the taxonomy picker) live under
            // `content`, not under `createModal`: the ENTRY editor renders the
            // same controls and the strings must not exist twice.
            content: t.content as unknown as Record<string, string>,
            // Same "one block, two surfaces" rule as the rule builder above:
            // the editor's attribute fields render these very values, so the
            // enum vocabulary lives at the top level and both read it.
            options: t.content?.enumLabels,
            // §2.5b — the SCORE strings come from the sidebar's own block, not
            // a second copy: the two show the same findings, and a wording
            // that differs between them reads as two different measurements.
            aiWarnings: t.content?.createModal?.aiWarnings,
            seoScore: {
              heading: t.content?.createModal?.seoScoreHeading,
              outOf: t.content?.createModal?.seoScoreOutOf,
              issues: t.seo?.issues,
            },
          }}
          // §2.5b/§2.5c — the AI prompts need a language NAME, and the modal
          // has no locale state of its own. The shop's primary one, because
          // that is the only language a create writes.
          mainLanguage={shopLocales.find((l) => l.primary)?.name || primaryLocale}
          hasSecondLocale={createTargetLocales.length > 0}
          requiresSecondLanguageHint={t.common?.requiresSecondLanguage}
        />
      )}
    </Page>
    </CommerceDataProvider>
    </commerceSave.Provider>
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

  // Metaobjects: the field key is `<Metaobject GID>#<field key>` (§6.1), so the
  // ONE reader that understands that shape answers here too — a local lookup by
  // bare GID would silently report "no source text" for every field and grey out
  // every translate button on the page.
  const itemWithMetaobjects = item as TranslatableContentItem & {
    metaobjects?: MetaobjectEntry[];
    fieldDefinitions?: MetaobjectDefinitionFieldLike[];
  };
  if (fieldKey.startsWith("gid://shopify/Metaobject/")) {
    return metaobjectFieldValueFor(
      itemWithMetaobjects.metaobjects as MetaobjectEntryLike[] | undefined,
      itemWithMetaobjects.fieldDefinitions,
      fieldKey,
      isMetaobjectLabelField,
    );
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


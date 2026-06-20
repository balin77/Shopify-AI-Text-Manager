/**
 * UnifiedItemList - Universal list component for all content types
 *
 * Combines the best features from ProductList:
 * - Search functionality
 * - Pagination (10 items per page)
 * - Status stripes with color coding
 * - Hover badges
 * - Thumbnail images (optional)
 * - Plan limit warnings
 *
 * Used by: Products, Collections, Pages, Blogs, Articles, Policies, etc.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Button,
  Icon,
  Banner,
  TextField,
  Popover,
  ActionList,
  Tooltip,
} from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon, RefreshIcon, SortIcon, PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
import { Thumbnail } from "@shopify/polaris";
import { useNavigationHeight } from "../../contexts/NavigationHeightContext";

export interface UnifiedItem {
  id: string;
  title?: string;
  subtitle?: string;
  category?: string;
  status?: string;
  image?: {
    url: string;
    altText?: string;
  };
  [key: string]: any;
}

export interface SortOption {
  /** Field key on UnifiedItem to sort by */
  field: string;
  /** Display label */
  label: string;
  /** Sort type: "date" for date fields, defaults to "string" */
  type?: "string" | "date";
}

type SortDirection = "asc" | "desc";

interface UnifiedItemListProps {
  /** Array of items to display */
  items: UnifiedItem[];

  /** Currently selected item ID */
  selectedItemId: string | null;

  /** Callback when item is selected */
  onItemSelect: (itemId: string) => void;

  /** Resource name for accessibility */
  resourceName: { singular: string; plural: string };

  /** Optional: Custom renderer for item content */
  renderItem?: (item: UnifiedItem, isSelected: boolean, isHovered: boolean) => React.ReactNode;

  /** Optional: Search placeholder text */
  searchPlaceholder?: string;

  /** Optional: Show search bar (default: true) */
  showSearch?: boolean;

  /** Optional: Show pagination (default: true) */
  showPagination?: boolean;

  /** Optional: Items per page (default: 10) */
  itemsPerPage?: number;

  /** Optional: Show status stripe (default: false) */
  showStatusStripe?: boolean;

  /** Optional: Show image thumbnails (default: false) */
  showThumbnails?: boolean;

  /** Optional: Show category badge before title (default: false) */
  showCategoryBadge?: boolean;

  /** Optional: Plan limit configuration */
  planLimit?: {
    isAtLimit: boolean;
    maxItems: number;
    currentPlan: string;
    nextPlan?: string;
    upgradeMessage?: string;
  };

  /** Optional: Callback to reload/sync all items from Shopify */
  onSyncAll?: () => void;

  /** Optional: Whether sync is in progress */
  isSyncing?: boolean;

  /** Optional: Sort options to show in the sort dropdown */
  sortOptions?: SortOption[];

  /** Optional: Show a "+" add button before the search field (default: false) */
  showAddButton?: boolean;

  /** Optional: Callback when the "+" add button is clicked */
  onAddItem?: () => void;

  /** Optional: Accessible label / tooltip for the add button */
  addButtonLabel?: string;

  /** Optional: Show a trash button to delete the selected entry (default: false).
   *  Only enabled when an item is selected — without a target there is nothing
   *  to remove. Other content tabs can opt-in later; for now used by the
   *  direct-translations tab only. */
  showDeleteButton?: boolean;

  /** Optional: Callback when the delete button is clicked (selected item id). */
  onDeleteItem?: (itemId: string) => void;

  /** Optional: Accessible label / tooltip for the delete button */
  deleteButtonLabel?: string;

  /** Translation strings */
  t?: {
    searchPlaceholder?: string;
    countLabel?: string;
    paginationOf?: string;
    paginationPrevious?: string;
    paginationNext?: string;
    planLimitReached?: string;
    upgradeForMore?: string;
    /** Locale-cased resource noun for plan-limit banner ({items} placeholder) */
    itemNoun?: string;
  };
}

export function UnifiedItemList({
  items,
  selectedItemId,
  onItemSelect,
  resourceName,
  renderItem,
  searchPlaceholder,
  showSearch = true,
  showPagination = true,
  itemsPerPage: fixedItemsPerPage,
  showStatusStripe = false,
  showThumbnails = false,
  showCategoryBadge = false,
  planLimit,
  onSyncAll,
  isSyncing = false,
  sortOptions,
  showAddButton = false,
  onAddItem,
  addButtonLabel,
  showDeleteButton = false,
  onDeleteItem,
  deleteButtonLabel,
  t = {},
}: UnifiedItemListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [dynamicItemsPerPage, setDynamicItemsPerPage] = useState(10);
  const [itemHeight, setItemHeight] = useState(56); // Will be calculated dynamically
  const [sortField, setSortField] = useState<string>("title");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [sortPopoverActive, setSortPopoverActive] = useState(false);

  const toggleSortPopover = useCallback(() => setSortPopoverActive((v) => !v), []);
  const closeSortPopover = useCallback(() => setSortPopoverActive(false), []);

  const { getTotalNavHeight } = useNavigationHeight();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const paginationRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const userChangedPageRef = useRef(false);

  // Use dynamic items per page (calculated from window height)
  const itemsPerPage = fixedItemsPerPage || dynamicItemsPerPage;

  // Filter items based on search
  const filteredItems = showSearch
    ? items.filter((item) => {
        const searchableText = `${item.title || ""} ${item.subtitle || ""}`.toLowerCase();
        return searchableText.includes(searchQuery.toLowerCase());
      })
    : items;

  // Determine if current sort field is a date type
  const currentSortOption = sortOptions?.find((opt) => opt.field === sortField);
  const isDateSort = currentSortOption?.type === "date";

  // Sort filtered items
  const sortedItems = [...filteredItems].sort((a, b) => {
    const valA = a[sortField];
    const valB = b[sortField];

    // Nulls/undefined go to end regardless of direction
    if (valA == null && valB == null) return 0;
    if (valA == null) return 1;
    if (valB == null) return -1;

    // Date fields (explicit type)
    if (isDateSort) {
      const dateA = new Date(valA).getTime();
      const dateB = new Date(valB).getTime();
      return sortDirection === "asc" ? dateA - dateB : dateB - dateA;
    }

    // String comparison
    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();
    const cmp = strA.localeCompare(strB);
    return sortDirection === "asc" ? cmp : -cmp;
  });

  // Pagination
  const totalPages = Math.ceil(sortedItems.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedItems = showPagination
    ? sortedItems.slice(startIndex, startIndex + itemsPerPage)
    : sortedItems;

  // Auto-jump to the page containing the selected item until the user manually paginates.
  // Why: selectedItemId is restored from localStorage on mount, but currentPage was always 1.
  useEffect(() => {
    if (userChangedPageRef.current) return;
    if (!selectedItemId || sortedItems.length === 0 || itemsPerPage <= 0) return;
    const idx = sortedItems.findIndex((item) => item.id === selectedItemId);
    if (idx === -1) return;
    const targetPage = Math.floor(idx / itemsPerPage) + 1;
    if (targetPage !== currentPage) setCurrentPage(targetPage);
  }, [selectedItemId, sortedItems, itemsPerPage, currentPage]);

  // Calculate items per page and item height based on available space
  useEffect(() => {
    const calculateDynamicPagination = () => {
      // Get the wrapper height (from flexbox layout)
      const wrapperHeight = wrapperRef.current?.clientHeight;
      const headerHeight = headerRef.current?.offsetHeight || 100;
      const paginationHeight = showPagination ? 56 : 0;

      // Calculate available height for the list
      let availableHeight: number;

      if (wrapperHeight && wrapperHeight > 200) {
        // Use wrapper height minus header, pagination, and a small buffer for borders/padding
        availableHeight = wrapperHeight - headerHeight - paginationHeight - 20;
      } else {
        // Fallback: calculate from window
        const navHeight = getTotalNavHeight();
        const padding = 32;
        availableHeight = window.innerHeight - navHeight - headerHeight - paginationHeight - padding;
      }

      // Calculate item dimensions
      const minItemHeight = showThumbnails ? 62 : 54;
      const maxItemHeight = 82;

      // Calculate how many items fit based on minimum height
      const itemsThatFit = Math.max(5, Math.floor(availableHeight / minItemHeight));

      // Calculate exact item height to fill the space perfectly
      // This ensures no pixels are wasted and the list fills exactly
      const exactItemHeight = availableHeight / itemsThatFit;
      const calculatedItemHeight = Math.min(maxItemHeight, Math.max(minItemHeight, exactItemHeight));

      setDynamicItemsPerPage(itemsThatFit);
      setItemHeight(calculatedItemHeight);
    };

    // Delay initial calculation to allow DOM to render
    const timer = setTimeout(calculateDynamicPagination, 150);
    window.addEventListener('resize', calculateDynamicPagination);

    // Use ResizeObserver for more reliable height detection
    let resizeObserver: ResizeObserver | null = null;
    if (wrapperRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(calculateDynamicPagination);
      resizeObserver.observe(wrapperRef.current);
    }

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', calculateDynamicPagination);
      resizeObserver?.disconnect();
    };
  }, [getTotalNavHeight, showThumbnails, showPagination]);

  // Reset to page 1 when search changes
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  // Get status color for stripe
  const getStatusColor = (status?: string) => {
    if (!status) return "#babfc3";

    switch (status.toUpperCase()) {
      case "ACTIVE":
        return "#00a047"; // Success green
      case "DRAFT":
        return "#8c9196"; // Gray
      case "ARCHIVED":
        return "#8c9196"; // Subdued gray
      default:
        return "#babfc3"; // Default gray
    }
  };

  // Truncate text to max characters
  const truncateText = (text: string, maxLength: number = 50) => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength).trim() + "…";
  };

  // Default item renderer
  const defaultRenderItem = (item: UnifiedItem, isSelected: boolean, isHovered: boolean) => {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", width: "100%" }}>
        {/* Status Stripe */}
        {showStatusStripe && (
          <div
            style={{
              width: "4px",
              height: "48px",
              backgroundColor: getStatusColor(item.status),
              borderRadius: "2px",
              flexShrink: 0,
            }}
          />
        )}

        {/* Category Badge (standalone - only when no thumbnails) */}
        {showCategoryBadge && !showThumbnails && item.category && (
          <div
            style={{
              backgroundColor: "#e4e5e7",
              color: "#202223",
              padding: "4px 8px",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 500,
              flexShrink: 0,
              maxWidth: "80px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.category}
          >
            {item.category}
          </div>
        )}

        {/* Thumbnail with optional Category Badge overlay */}
        {showThumbnails && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            {item.featuredImage?.url ? (
            <Thumbnail
              source={item.featuredImage.url}
              alt={item.featuredImage.altText || item.title || ""}
              size="small"
            />
            ) : (
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "8px",
                  backgroundColor: "#f1f1f1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "10px",
                  color: "#8c9196",
                  fontWeight: 500,
                }}
              >
                Title
              </div>
            )}
            {/* Category Badge overlay on thumbnail */}
            {showCategoryBadge && item.category && (
              <div
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  backgroundColor: "rgba(0, 0, 0, 0.7)",
                  color: "#fff",
                  padding: "1px 2px",
                  fontSize: "8px",
                  fontWeight: 500,
                  textAlign: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  borderRadius: "0 0 6px 6px",
                }}
                title={item.category}
              >
                {item.category}
              </div>
            )}
            {/* Status Badge on hover */}
            {isHovered && item.status && !showCategoryBadge && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(0, 0, 0, 0.7)",
                  borderRadius: "8px",
                }}
              >
                <Badge tone={item.status === "ACTIVE" ? "success" : "info"}>
                  {item.status}
                </Badge>
              </div>
            )}
          </div>
        )}

        {/* Title and Subtitle */}
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
            {truncateText(item.title || item.id)}
          </Text>
          {item.subtitle && (
            <Text as="p" variant="bodySm" tone="subdued">
              {item.subtitle}
            </Text>
          )}
        </BlockStack>
      </div>
    );
  };

  const itemRenderer = renderItem || defaultRenderItem;

  return (
    <div ref={wrapperRef} style={{ width: "330px", flexShrink: 0, height: "100%", overflow: "hidden" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        /* UnifiedItemList - Full height card with scrollable list */
        .unified-item-list-wrapper {
          height: 100% !important;
          display: flex !important;
          flex-direction: column !important;
        }
        .unified-item-list-wrapper > .Polaris-Card {
          height: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          overflow: hidden !important;
        }
        .unified-item-list-wrapper .Polaris-Card > div {
          display: flex !important;
          flex-direction: column !important;
          height: 100% !important;
          overflow: hidden !important;
        }
        .unified-item-list-scroll {
          flex: 1 !important;
          min-height: 0 !important;
          overflow-y: auto !important;
        }
        /* Dynamic item height */
        .unified-item-list-scroll .Polaris-ResourceItem {
          height: ${itemHeight}px !important;
          min-height: ${itemHeight}px !important;
        }
        .unified-item-list-scroll .Polaris-ResourceItem__Container {
          height: 100% !important;
          display: flex !important;
          align-items: center !important;
        }
      ` }} />
      <div className="unified-item-list-wrapper" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Card padding="0">
        {/* Header */}
        <div ref={headerRef} style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5", flexShrink: 0 }}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {resourceName.plural} ({items.length})
              </Text>
              {/* Order: Sort → Reload → Plus → Delete. Plus is variant=primary
                  to anchor the row; Delete is tone=critical to stand out as a
                  destructive action. */}
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                {sortOptions && sortOptions.length > 0 && (
                  <Popover
                    active={sortPopoverActive}
                    activator={
                      <Button
                        icon={SortIcon}
                        variant="plain"
                        onClick={toggleSortPopover}
                        accessibilityLabel="Sort items"
                        size="slim"
                      />
                    }
                    onClose={closeSortPopover}
                    preferredAlignment="right"
                  >
                    <ActionList
                      items={sortOptions.flatMap((opt) => {
                        const isDate = opt.type === "date";
                        return [
                          {
                            content: `${opt.label} ${isDate ? "↑ Oldest" : "(A–Z)"}`,
                            active: sortField === opt.field && sortDirection === "asc",
                            onAction: () => {
                              setSortField(opt.field);
                              setSortDirection("asc");
                              setCurrentPage(1);
                              closeSortPopover();
                            },
                          },
                          {
                            content: `${opt.label} ${isDate ? "↓ Newest" : "(Z–A)"}`,
                            active: sortField === opt.field && sortDirection === "desc",
                            onAction: () => {
                              setSortField(opt.field);
                              setSortDirection("desc");
                              setCurrentPage(1);
                              closeSortPopover();
                            },
                          },
                        ];
                      })}
                    />
                  </Popover>
                )}
                {onSyncAll && (
                  <Button
                    icon={RefreshIcon}
                    variant="plain"
                    onClick={onSyncAll}
                    loading={isSyncing}
                    accessibilityLabel="Sync from Shopify"
                    size="slim"
                  />
                )}
                {showAddButton && onAddItem && (
                  <Button
                    icon={PlusIcon}
                    variant="primary"
                    onClick={onAddItem}
                    accessibilityLabel={addButtonLabel || "Add"}
                    size="slim"
                  />
                )}
                {showDeleteButton && onDeleteItem && (
                  <Button
                    icon={DeleteIcon}
                    variant="plain"
                    tone="critical"
                    onClick={() => { if (selectedItemId) onDeleteItem(selectedItemId); }}
                    disabled={!selectedItemId}
                    accessibilityLabel={deleteButtonLabel || "Delete entry"}
                    size="slim"
                  />
                )}
              </div>
            </InlineStack>

            {/* Search */}
            {showSearch && (
              <TextField
                label=""
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder={searchPlaceholder || t.searchPlaceholder || `Search ${resourceName.plural.toLowerCase()}...`}
                autoComplete="off"
                prefix={<Icon source={SearchIcon} />}
                clearButton
                onClearButtonClick={() => handleSearchChange("")}
              />
            )}

            {/* Plan Limit Warning */}
            {planLimit?.isAtLimit && (
              <Banner tone="warning">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    {planLimit.upgradeMessage ||
                      (t.planLimitReached || "You've reached the maximum of {max} {items} for the {plan} plan.")
                        .replace("{max}", String(planLimit.maxItems))
                        .replace("{items}", t.itemNoun || resourceName.plural.toLowerCase())
                        .replace("{plan}", planLimit.currentPlan)}
                  </Text>
                  {planLimit.nextPlan && (
                    <Text as="p" variant="bodySm">
                      {(t.upgradeForMore || "Upgrade to {plan} for more {items}.")
                        .replace("{plan}", planLimit.nextPlan)
                        .replace("{items}", t.itemNoun || resourceName.plural.toLowerCase())}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}
          </BlockStack>
        </div>

        {/* Item List - Dynamic height based on window */}
        <div ref={listContainerRef} className="unified-item-list-scroll" style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
          {paginatedItems.length > 0 ? (
            <ResourceList
              resourceName={resourceName}
              items={paginatedItems}
              renderItem={(item: UnifiedItem) => {
                const isSelected = selectedItemId === item.id;
                const isHovered = hoveredItemId === item.id;

                return (
                  <ResourceItem
                    id={item.id}
                    onClick={() => onItemSelect(item.id)}
                  >
                    <div
                      onMouseEnter={() => setHoveredItemId(item.id)}
                      onMouseLeave={() => setHoveredItemId(null)}
                      style={{
                        backgroundColor: isSelected ? "rgba(0, 128, 96, 0.08)" : "transparent",
                        borderLeft: isSelected ? "3px solid #008060" : "3px solid transparent",
                        margin: "-12px -20px",
                        padding: "0 20px",
                        height: `${itemHeight}px`,
                        display: "flex",
                        alignItems: "center",
                        position: "relative",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                        {itemRenderer(item, isSelected, isHovered)}
                      </div>
                      {(item.hasMissingPrimary || item.hasMissingTranslations) && (
                        <div style={{ display: "flex", gap: "4px", flexShrink: 0, marginLeft: "8px", alignItems: "center" }}>
                          {item.hasMissingPrimary && (
                            <Tooltip content={item.missingPrimaryTooltip || "Missing primary content"} dismissOnMouseOut zIndexOverride={1200}>
                              <div
                                style={{
                                  width: "12px",
                                  height: "12px",
                                  borderRadius: "50%",
                                  backgroundColor: "rgba(255, 149, 0, 0.9)",
                                  flexShrink: 0,
                                  cursor: "default",
                                }}
                              />
                            </Tooltip>
                          )}
                          {item.hasMissingTranslations && (
                            <Tooltip content={item.missingTranslationsTooltip || "Missing translations"} dismissOnMouseOut zIndexOverride={1200}>
                              <div
                                style={{
                                  width: "12px",
                                  height: "12px",
                                  borderRadius: "50%",
                                  backgroundColor: "rgba(59, 130, 246, 0.9)",
                                  flexShrink: 0,
                                  cursor: "default",
                                }}
                              />
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </div>
                  </ResourceItem>
                );
              }}
            />
          ) : (
            <div style={{ padding: "2rem", textAlign: "center" }}>
              <Text as="p" variant="bodySm" tone="subdued">
                {searchQuery
                  ? `No ${resourceName.plural.toLowerCase()} found matching "${searchQuery}"`
                  : `No ${resourceName.plural.toLowerCase()} found`}
              </Text>
            </div>
          )}
        </div>

        {/* Pagination */}
        {showPagination && totalPages > 1 && (
          <div ref={paginationRef} style={{ padding: "1rem", borderTop: "1px solid #e1e3e5", flexShrink: 0 }}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {startIndex + 1}-{Math.min(startIndex + itemsPerPage, sortedItems.length)} {t.paginationOf || "of"}{" "}
                {sortedItems.length}
              </Text>
              <InlineStack gap="200">
                <Button
                  icon={ChevronLeftIcon}
                  onClick={() => {
                    userChangedPageRef.current = true;
                    setCurrentPage(currentPage - 1);
                  }}
                  disabled={currentPage === 1}
                  accessibilityLabel={t.paginationPrevious || "Previous page"}
                />
                <Text as="span" variant="bodySm">
                  {currentPage} / {totalPages}
                </Text>
                <Button
                  icon={ChevronRightIcon}
                  onClick={() => {
                    userChangedPageRef.current = true;
                    setCurrentPage(currentPage + 1);
                  }}
                  disabled={currentPage === totalPages}
                  accessibilityLabel={t.paginationNext || "Next page"}
                />
              </InlineStack>
            </InlineStack>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}

/**
 * Unified Item List Mobile - Dropdown Version
 *
 * Mobile-optimized version of the item list that shows as a collapsible dropdown
 * with search functionality and compact item display.
 */

import { useState, useEffect } from "react";
import { Card, TextField, BlockStack, InlineStack, Text, Icon, Button, Thumbnail } from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronUpIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import type { UnifiedItem } from "./UnifiedItemList";

interface UnifiedItemListMobileProps {
  /** Array of items to display */
  items: UnifiedItem[];
  /** Currently selected item ID */
  selectedItemId: string | null;
  /** Callback when item is selected */
  onItemSelect: (itemId: string) => void;
  /** Resource name for display */
  resourceName: {
    singular: string;
    plural: string;
  };
  /** Optional: Custom render for list item */
  renderItem?: (item: UnifiedItem, isSelected: boolean) => React.ReactNode;
  /** Translation strings */
  t?: {
    searchPlaceholder?: string;
    noResults?: string;
    selectItem?: string;
  };
}

export function UnifiedItemListMobile({
  items,
  selectedItemId,
  onItemSelect,
  resourceName,
  renderItem,
  t = {},
}: UnifiedItemListMobileProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  // Find selected item
  const selectedItem = items.find(item => item.id === selectedItemId);

  // Filter items based on search
  const filteredItems = items.filter(item => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      item.title?.toLowerCase().includes(query) ||
      item.handle?.toLowerCase().includes(query) ||
      item.id.toLowerCase().includes(query)
    );
  });

  // Pagination
  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedItems = filteredItems.slice(startIndex, startIndex + itemsPerPage);

  const handleItemSelect = (itemId: string) => {
    onItemSelect(itemId);
    setIsExpanded(false);
    setSearchQuery("");
    setCurrentPage(1);
  };

  // Reset page when search changes
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  // Calculate items per page based on screen height
  useEffect(() => {
    const calculateItemsPerPage = () => {
      const itemHeight = 72; // Height of each item (including padding/margin)
      const searchHeight = 60; // Search field height
      const countHeight = 30; // Count label height
      const paginationHeight = 48; // Pagination controls height
      const headerHeight = 64; // Mobile header/navbar height
      const padding = 40; // Extra padding/margins

      const availableHeight = window.innerHeight - headerHeight - searchHeight - countHeight - paginationHeight - padding;
      const calculatedItems = Math.max(5, Math.floor(availableHeight / itemHeight));

      setItemsPerPage(calculatedItems);
    };

    calculateItemsPerPage();
    window.addEventListener('resize', calculateItemsPerPage);

    return () => {
      window.removeEventListener('resize', calculateItemsPerPage);
    };
  }, []);

  return (
    <div className="unified-item-list-mobile">
      {/* Selected Item Display - Tap to expand */}
      <Card>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: "100%",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
          }}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Close item selector" : "Open item selector"}
        >
          <InlineStack align="space-between" blockAlign="center">
            <div style={{ flex: 1, minWidth: 0 }}>
              {selectedItem ? (
                <InlineStack gap="300" blockAlign="center">
                  {/* Thumbnail */}
                  {selectedItem.image?.url && (
                    <Thumbnail
                      source={selectedItem.image.url}
                      alt={selectedItem.image.altText || selectedItem.title || ""}
                      size="small"
                    />
                  )}

                  {/* Title */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>
                      {selectedItem.title || selectedItem.handle || "Untitled"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued" truncate>
                      {selectedItem.handle}
                    </Text>
                  </div>
                </InlineStack>
              ) : (
                <Text as="p" variant="bodyMd" tone="subdued">
                  {t.selectItem || `Select ${resourceName.singular}`}
                </Text>
              )}
            </div>

            {/* Chevron Icon */}
            <div style={{ marginLeft: "12px" }}>
              <Icon source={isExpanded ? ChevronUpIcon : ChevronDownIcon} />
            </div>
          </InlineStack>
        </button>
      </Card>

      {/* Expanded Item List */}
      {isExpanded && (
        <Card>
          <BlockStack gap="300">
            {/* Search */}
            <div style={{ border: "none" }}>
              <TextField
                label=""
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder={t.searchPlaceholder || `Search ${resourceName.plural}...`}
                prefix={<Icon source={SearchIcon} />}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => handleSearchChange("")}
                autoFocus
              />
            </div>

            {/* Item Count */}
            <Text as="p" variant="bodySm" tone="subdued">
              {filteredItems.length} {filteredItems.length === 1 ? resourceName.singular : resourceName.plural}
            </Text>

            {/* Scrollable Item List */}
            <div
              style={{
                maxHeight: "400px",
                overflowY: "auto",
                margin: "-8px",
                padding: "8px",
              }}
            >
              <BlockStack gap="200">
                {paginatedItems.length === 0 ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {t.noResults || "No items found"}
                    </Text>
                  </div>
                ) : (
                  paginatedItems.map((item) => {
                    const isSelected = item.id === selectedItemId;

                    if (renderItem) {
                      return (
                        <div
                          key={item.id}
                          onClick={() => handleItemSelect(item.id)}
                          style={{ cursor: "pointer" }}
                        >
                          {renderItem(item, isSelected)}
                        </div>
                      );
                    }

                    // Default item rendering
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleItemSelect(item.id)}
                        style={{
                          width: "100%",
                          padding: "12px",
                          border: "none",
                          background: isSelected ? "#e3f2fd" : "white",
                          borderRadius: "8px",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "background-color 150ms ease",
                          borderLeft: isSelected ? "4px solid #0066CC" : "4px solid transparent",
                        }}
                        aria-current={isSelected ? "true" : undefined}
                      >
                        <InlineStack gap="300" blockAlign="center">
                          {/* Thumbnail */}
                          {item.image?.url && (
                            <Thumbnail
                              source={item.image.url}
                              alt={item.image.altText || item.title || ""}
                              size="small"
                            />
                          )}

                          {/* Content */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Text as="p" variant="bodyMd" fontWeight={isSelected ? "semibold" : "regular"} truncate>
                              {item.title || item.handle || "Untitled"}
                            </Text>
                            {item.handle && (
                              <Text as="p" variant="bodySm" tone="subdued" truncate>
                                {item.handle}
                              </Text>
                            )}
                          </div>

                          {/* Status Stripe */}
                          {item.statusStripe && (
                            <div
                              style={{
                                width: "4px",
                                height: "32px",
                                borderRadius: "2px",
                                backgroundColor: item.statusStripe,
                                flexShrink: 0,
                              }}
                              aria-label={`Status: ${item.statusStripe}`}
                            />
                          )}
                        </InlineStack>
                      </button>
                    );
                  })
                )}
              </BlockStack>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ paddingTop: "8px", borderTop: "1px solid #e1e3e5" }}>
                <InlineStack align="center" blockAlign="center" gap="200">
                  <Button
                    icon={ChevronLeftIcon}
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(currentPage - 1)}
                    accessibilityLabel="Previous page"
                  />
                  <Text as="span" variant="bodySm" tone="subdued">
                    {currentPage} of {totalPages}
                  </Text>
                  <Button
                    icon={ChevronRightIcon}
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(currentPage + 1)}
                    accessibilityLabel="Next page"
                  />
                </InlineStack>
              </div>
            )}
          </BlockStack>
        </Card>
      )}

      <style>{`
        /* Remove blue focus border from TextField in dropdown */
        .unified-item-list-mobile .Polaris-TextField__Input:focus {
          border-color: #c9cccf !important;
          box-shadow: none !important;
        }

        .unified-item-list-mobile .Polaris-TextField__Input:focus-visible {
          outline: 2px solid #0066CC;
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}

/**
 * Unified Item Selector Compact - Navbar Version
 *
 * Highly compact version of the item selector designed to fit in the mobile navbar.
 * Shows only the selected item title as a clickable badge/button.
 * Expands to show full dropdown with search when clicked.
 */

import { useState, useEffect } from "react";
import { Card, TextField, BlockStack, InlineStack, Text, Icon, Button, Thumbnail } from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronUpIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import type { UnifiedItem } from "./UnifiedItemList";

interface UnifiedItemSelectorCompactProps {
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
  /** Translation strings */
  t?: {
    searchPlaceholder?: string;
    noResults?: string;
    selectItem?: string;
  };
}

export function UnifiedItemSelectorCompact({
  items,
  selectedItemId,
  onItemSelect,
  resourceName,
  t = {},
}: UnifiedItemSelectorCompactProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 8;

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

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isExpanded]);

  return (
    <div className="mobile-navbar-item-selector">
      {/* Compact Badge - Shows only selected item title */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          width: "100%",
          background: "#f6f6f7",
          border: "1px solid #c9cccf",
          borderRadius: "8px",
          padding: "6px 10px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          minHeight: "44px",
        }}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Close item selector" : "Open item selector"}
      >
        <Text as="span" variant="bodySm" fontWeight="medium" truncate>
          {selectedItem ? (selectedItem.title || selectedItem.handle || "Untitled") : (t.selectItem || "Select")}
        </Text>
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", marginLeft: "auto" }}>
          <Icon source={isExpanded ? ChevronUpIcon : ChevronDownIcon} />
        </span>
      </button>

      {/* Full Dropdown Overlay */}
      {isExpanded && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setIsExpanded(false)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              zIndex: 1100,
            }}
            aria-hidden="true"
          />

          {/* Dropdown Panel */}
          <div
            className="compact-selector-dropdown"
            style={{
              position: "fixed",
              top: "60px",
              left: "12px",
              right: "12px",
              maxHeight: "calc(100vh - 80px)",
              backgroundColor: "white",
              borderRadius: "8px",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
              zIndex: 1101,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ padding: "12px", borderBottom: "1px solid #e1e3e5" }}>
              <TextField
                label=""
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder={t.searchPlaceholder || `Search ${resourceName.plural}...`}
                prefix={<Icon source={SearchIcon} />}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => handleSearchChange("")}
              />
            </div>

            <div style={{ padding: "8px 12px", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="p" variant="bodySm" tone="subdued">
                {filteredItems.length} {filteredItems.length === 1 ? resourceName.singular : resourceName.plural}
              </Text>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
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

                    return (
                      <button
                        key={item.id}
                        onClick={() => handleItemSelect(item.id)}
                        style={{
                          width: "100%",
                          padding: "10px",
                          border: "none",
                          background: isSelected ? "#e3f2fd" : "white",
                          borderRadius: "6px",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "background-color 150ms ease",
                          borderLeft: isSelected ? "3px solid #0066CC" : "3px solid transparent",
                        }}
                        aria-current={isSelected ? "true" : undefined}
                      >
                        <InlineStack gap="200" blockAlign="center">
                          {item.featuredImage?.url && (
                            <Thumbnail
                              source={item.featuredImage.url}
                              alt={item.featuredImage.altText || item.title || ""}
                              size="small"
                            />
                          )}

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
                        </InlineStack>
                      </button>
                    );
                  })
                )}
              </BlockStack>
            </div>

            {totalPages > 1 && (
              <div style={{ padding: "12px", borderTop: "1px solid #e1e3e5" }}>
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
          </div>
        </>
      )}

      <style>{`
        /* Remove ALL focus styles from search field in compact selector dropdown */
        .compact-selector-dropdown .Polaris-TextField__Input,
        .compact-selector-dropdown .Polaris-TextField__Input:focus,
        .compact-selector-dropdown .Polaris-TextField__Input:focus-visible,
        .compact-selector-dropdown .Polaris-TextField__Input:active,
        .compact-selector-dropdown .Polaris-Connected,
        .compact-selector-dropdown .Polaris-Connected:focus-within,
        .compact-selector-dropdown input,
        .compact-selector-dropdown input:focus,
        .compact-selector-dropdown input:focus-visible,
        .compact-selector-dropdown input:active {
          border-color: #c9cccf !important;
          box-shadow: none !important;
          outline: none !important;
        }
      `}</style>
    </div>
  );
}

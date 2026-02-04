/**
 * Unified Item List Mobile - Dropdown Version
 *
 * Mobile-optimized version of the item list that shows as a collapsible dropdown
 * with search functionality and compact item display.
 */

import { useState } from "react";
import { Card, TextField, BlockStack, InlineStack, Text, Icon, Button } from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
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

  const handleItemSelect = (itemId: string) => {
    onItemSelect(itemId);
    setIsExpanded(false);
    setSearchQuery("");
  };

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
                  {selectedItem.thumbnail && (
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        borderRadius: "4px",
                        overflow: "hidden",
                        flexShrink: 0,
                        backgroundColor: "#f3f4f6",
                      }}
                    >
                      <img
                        src={selectedItem.thumbnail}
                        alt=""
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    </div>
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
            <TextField
              label=""
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t.searchPlaceholder || `Search ${resourceName.plural}...`}
              prefix={<Icon source={SearchIcon} />}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearchQuery("")}
              autoFocus
            />

            {/* Item Count */}
            <Text as="p" variant="bodySm" tone="subdued">
              {filteredItems.length} {filteredItems.length === 1 ? resourceName.singular : resourceName.plural}
            </Text>

            {/* Scrollable Item List */}
            <div
              style={{
                maxHeight: "300px",
                overflowY: "auto",
                margin: "-8px",
                padding: "8px",
              }}
            >
              <BlockStack gap="200">
                {filteredItems.length === 0 ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {t.noResults || "No items found"}
                    </Text>
                  </div>
                ) : (
                  filteredItems.map((item) => {
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
                          {item.thumbnail && (
                            <div
                              style={{
                                width: "40px",
                                height: "40px",
                                borderRadius: "4px",
                                overflow: "hidden",
                                flexShrink: 0,
                                backgroundColor: "#f3f4f6",
                              }}
                            >
                              <img
                                src={item.thumbnail}
                                alt=""
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  objectFit: "cover",
                                }}
                              />
                            </div>
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

            {/* Close Button */}
            <Button onClick={() => setIsExpanded(false)} fullWidth>
              Close
            </Button>
          </BlockStack>
        </Card>
      )}
    </div>
  );
}

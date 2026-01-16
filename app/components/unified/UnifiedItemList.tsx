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

import { useState } from "react";
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
} from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { Thumbnail } from "@shopify/polaris";

export interface UnifiedItem {
  id: string;
  title?: string;
  subtitle?: string;
  status?: string;
  image?: {
    url: string;
    altText?: string;
  };
  [key: string]: any;
}

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

  /** Optional: Plan limit configuration */
  planLimit?: {
    isAtLimit: boolean;
    maxItems: number;
    currentPlan: string;
    nextPlan?: string;
    upgradeMessage?: string;
  };

  /** Translation strings */
  t?: {
    searchPlaceholder?: string;
    countLabel?: string;
    paginationOf?: string;
    paginationPrevious?: string;
    paginationNext?: string;
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
  itemsPerPage = 10,
  showStatusStripe = false,
  showThumbnails = false,
  planLimit,
  t = {},
}: UnifiedItemListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

  // Filter items based on search
  const filteredItems = showSearch
    ? items.filter((item) => {
        const searchableText = `${item.title || ""} ${item.subtitle || ""}`.toLowerCase();
        return searchableText.includes(searchQuery.toLowerCase());
      })
    : items;

  // Pagination
  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedItems = showPagination
    ? filteredItems.slice(startIndex, startIndex + itemsPerPage)
    : filteredItems;

  // Debug: Log pagination info
  console.log(`[UnifiedItemList] ${resourceName.plural}:`, {
    totalItems: items.length,
    filteredItems: filteredItems.length,
    itemsPerPage,
    totalPages,
    showPagination,
    willShowPagination: showPagination && totalPages > 1
  });

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

        {/* Thumbnail */}
        {showThumbnails && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <Thumbnail
              source={item.image?.url || ""}
              alt={item.image?.altText || item.title || ""}
              size="small"
            />
            {/* Status Badge on hover */}
            {isHovered && item.status && (
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
            {item.title || item.id}
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
    <div style={{ width: "350px", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, height: "100%" }}>
      <style>{`
        .Polaris-ResourceList__ResourceListWrapper {
          max-height: 100% !important;
          overflow-y: auto !important;
        }
      `}</style>
      <Card padding="0" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5", flexShrink: 0 }}>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {resourceName.plural} ({items.length})
            </Text>

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
                    {planLimit.upgradeMessage || `You've reached the maximum of ${planLimit.maxItems} ${resourceName.plural.toLowerCase()} for the ${planLimit.currentPlan} plan.`}
                  </Text>
                  {planLimit.nextPlan && (
                    <Text as="p" variant="bodySm">
                      Upgrade to {planLimit.nextPlan} for more {resourceName.plural.toLowerCase()}.
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}
          </BlockStack>
        </div>

        {/* Item List - Scrollable */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, maxHeight: "100%" }}>
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
                    onMouseEnter={() => setHoveredItemId(item.id)}
                    onMouseLeave={() => setHoveredItemId(null)}
                  >
                    {itemRenderer(item, isSelected, isHovered)}
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
          <div style={{ padding: "1rem", borderTop: "1px solid #e1e3e5", flexShrink: 0 }}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {startIndex + 1}-{Math.min(startIndex + itemsPerPage, filteredItems.length)} {t.paginationOf || "of"}{" "}
                {filteredItems.length}
              </Text>
              <InlineStack gap="200">
                <Button
                  icon={ChevronLeftIcon}
                  onClick={() => setCurrentPage(currentPage - 1)}
                  disabled={currentPage === 1}
                  accessibilityLabel={t.paginationPrevious || "Previous page"}
                />
                <Text as="span" variant="bodySm">
                  {currentPage} / {totalPages}
                </Text>
                <Button
                  icon={ChevronRightIcon}
                  onClick={() => setCurrentPage(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  accessibilityLabel={t.paginationNext || "Next page"}
                />
              </InlineStack>
            </InlineStack>
          </div>
        )}
      </Card>
    </div>
  );
}

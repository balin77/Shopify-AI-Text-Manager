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
} from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { Thumbnail } from "@shopify/polaris";

interface Product {
  id: string;
  title: string;
  featuredImage?: {
    url: string;
    altText?: string;
  };
  status: string;
}

interface ProductListProps {
  products: Product[];
  selectedProductId: string | null;
  onProductSelect: (productId: string) => void;
  searchPlaceholder: string;
  countLabel: string;
  resourceName: { singular: string; plural: string };
  paginationOf: string;
  paginationPrevious: string;
  paginationNext: string;
}

export function ProductList({
  products,
  selectedProductId,
  onProductSelect,
  searchPlaceholder,
  countLabel,
  resourceName,
  paginationOf,
  paginationPrevious,
  paginationNext,
}: ProductListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredProductId, setHoveredProductId] = useState<string | null>(null);
  const productsPerPage = 10;

  // Filter and pagination
  const filteredProducts = products.filter((p: Product) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  const startIndex = (currentPage - 1) * productsPerPage;
  const paginatedProducts = filteredProducts.slice(startIndex, startIndex + productsPerPage);

  // Get color for status stripe
  const getStatusColor = (status: string) => {
    switch (status) {
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

  return (
    <Card padding="0">
      <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            {countLabel} ({filteredProducts.length})
          </Text>
          <div style={{ position: "relative" }}>
            <div
              style={{
                position: "absolute",
                left: "12px",
                top: "50%",
                transform: "translateY(-50%)",
                pointerEvents: "none",
              }}
            >
              <Icon source={SearchIcon} />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder={searchPlaceholder}
              style={{
                width: "100%",
                padding: "8px 12px 8px 36px",
                border: "1px solid #babfc3",
                borderRadius: "8px",
                fontSize: "14px",
              }}
            />
          </div>
        </BlockStack>
      </div>

      <div style={{ maxHeight: "calc(100vh - 250px)", overflowY: "auto" }}>
        <ResourceList
          resourceName={resourceName}
          items={paginatedProducts}
          renderItem={(item: Product) => {
            const { id, title, featuredImage, status } = item;
            const isSelected = selectedProductId === id;

            return (
              <div style={{ position: "relative" }}>
                {/* Status stripe positioned absolutely at the left edge */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: "10%",
                    height: "80%",
                    width: "6px",
                    backgroundColor: getStatusColor(status),
                    zIndex: 1,
                    borderRadius: "0 3px 3px 0",
                  }}
                />
                <ResourceItem
                  id={id}
                  onClick={() => onProductSelect(id)}
                  media={
                    <div
                      style={{ position: "relative", display: "inline-block", marginLeft: "12px" }}
                      onMouseEnter={() => setHoveredProductId(id)}
                      onMouseLeave={() => setHoveredProductId(null)}
                    >
                      {featuredImage ? (
                        <Thumbnail
                          source={featuredImage.url}
                          alt={featuredImage.altText || title}
                          size="large"
                        />
                      ) : (
                        <div
                          style={{
                            width: "60px",
                            height: "60px",
                            background: "#e1e3e5",
                            borderRadius: "8px",
                          }}
                        />
                      )}
                      {/* Badge on hover - positioned at bottom */}
                      {hoveredProductId === id && (
                        <div
                          style={{
                            position: "absolute",
                            bottom: "8px",
                            left: "50%",
                            transform: "translateX(-50%)",
                            pointerEvents: "none",
                            zIndex: 100,
                            backgroundColor: "rgba(255, 255, 255, 0.9)",
                            borderRadius: "4px",
                            padding: "2px",
                            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                          }}
                        >
                          <Badge
                            tone={
                              status === "ACTIVE"
                                ? "success"
                                : status === "DRAFT"
                                  ? "attention"
                                  : "info"
                            }
                          >
                            {status}
                          </Badge>
                        </div>
                      )}
                    </div>
                  }
                >
                  <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                    {title}
                  </Text>
                </ResourceItem>
              </div>
            );
          }}
        />
      </div>

      {totalPages > 1 && (
        <div style={{ padding: "1rem", borderTop: "1px solid #e1e3e5" }}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              {startIndex + 1}-{Math.min(startIndex + productsPerPage, filteredProducts.length)} {paginationOf}{" "}
              {filteredProducts.length}
            </Text>
            <InlineStack gap="200">
              <Button
                icon={ChevronLeftIcon}
                onClick={() => setCurrentPage(currentPage - 1)}
                disabled={currentPage === 1}
                accessibilityLabel={paginationPrevious}
              />
              <Text as="span" variant="bodySm">
                {currentPage} / {totalPages}
              </Text>
              <Button
                icon={ChevronRightIcon}
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                accessibilityLabel={paginationNext}
              />
            </InlineStack>
          </InlineStack>
        </div>
      )}
    </Card>
  );
}

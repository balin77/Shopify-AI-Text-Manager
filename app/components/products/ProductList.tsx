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
}

export function ProductList({
  products,
  selectedProductId,
  onProductSelect,
  searchPlaceholder,
  countLabel,
}: ProductListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const productsPerPage = 10;

  // Filter and pagination
  const filteredProducts = products.filter((p: Product) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  const startIndex = (currentPage - 1) * productsPerPage;
  const paginatedProducts = filteredProducts.slice(startIndex, startIndex + productsPerPage);

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
          resourceName={{ singular: "Produkt", plural: "Produkte" }}
          items={paginatedProducts}
          renderItem={(item: Product) => {
            const { id, title, featuredImage, status } = item;
            const isSelected = selectedProductId === id;

            return (
              <ResourceItem
                id={id}
                onClick={() => onProductSelect(id)}
                media={
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.25rem",
                      alignItems: "flex-start",
                    }}
                  >
                    {featuredImage ? (
                      <Thumbnail
                        source={featuredImage.url}
                        alt={featuredImage.altText || title}
                        size="small"
                      />
                    ) : (
                      <div
                        style={{
                          width: "40px",
                          height: "40px",
                          background: "#e1e3e5",
                          borderRadius: "8px",
                        }}
                      />
                    )}
                    <Badge tone={status === "ACTIVE" ? "success" : undefined} size="small">
                      {status}
                    </Badge>
                  </div>
                }
              >
                <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                  {title}
                </Text>
              </ResourceItem>
            );
          }}
        />
      </div>

      {totalPages > 1 && (
        <div style={{ padding: "1rem", borderTop: "1px solid #e1e3e5" }}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              {startIndex + 1}-{Math.min(startIndex + productsPerPage, filteredProducts.length)} von{" "}
              {filteredProducts.length}
            </Text>
            <InlineStack gap="200">
              <Button
                icon={ChevronLeftIcon}
                onClick={() => setCurrentPage(currentPage - 1)}
                disabled={currentPage === 1}
                accessibilityLabel="Vorherige Seite"
              />
              <Text as="span" variant="bodySm">
                {currentPage} / {totalPages}
              </Text>
              <Button
                icon={ChevronRightIcon}
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                accessibilityLabel="Nächste Seite"
              />
            </InlineStack>
          </InlineStack>
        </div>
      )}
    </Card>
  );
}

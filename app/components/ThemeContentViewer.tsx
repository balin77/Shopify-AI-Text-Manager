import { Card, Text, BlockStack, Badge, TextField, InlineStack, Banner, Button, Pagination } from "@shopify/polaris";
import { useState, useMemo } from "react";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";

interface ThemeContentViewerProps {
  themeResource: any;
  currentLanguage: string;
  shopLocales: any[];
  primaryLocale: string;
  editableValues: Record<string, string>;
  onValueChange: (key: string, value: string) => void;
  aiSuggestions: Record<string, string>;
  onGenerateAI: (key: string) => void;
  onTranslate: (key: string) => void;
  onTranslateAll: () => void;
  onAcceptSuggestion: (key: string) => void;
  onRejectSuggestion: (key: string) => void;
  isLoading?: boolean;
  htmlModes: Record<string, "html" | "rendered">;
  onToggleHtmlMode: (key: string) => void;
}

// Helper function to extract a human-readable name from a theme key
function extractReadableName(key: string): string {
  // Remove common prefixes and IDs
  let name = key;

  // Remove section prefixes
  name = name.replace(/^section\.(article|collection|index|password|product|page)\.json\./i, '');
  name = name.replace(/^section\.(article|collection|index|password|product|page)\./i, '');

  // Remove collections.json prefix
  name = name.replace(/^collections\.json\./i, '');

  // Remove group.json prefix
  name = name.replace(/^group\.json\./i, '');

  // Remove bar prefix
  name = name.replace(/^bar\./i, '');

  // Remove "Settings Categories:" prefix
  name = name.replace(/^Settings Categories:\s*/i, '');

  // Remove trailing IDs (like :3syj88j, .heading:3jfch, etc.)
  name = name.replace(/:[a-z0-9]+$/i, '');
  name = name.replace(/\.[a-z0-9_]+:[a-z0-9]+$/i, '');

  // Remove common suffixes
  name = name.replace(/\.(heading|text|label|title)$/i, '');

  // Get the last meaningful part
  const parts = name.split('.');
  if (parts.length > 1) {
    // Take the last 2-3 parts for context
    name = parts.slice(-2).join(' › ');
  }

  // Convert underscores to spaces and capitalize
  name = name.replace(/_/g, ' ');
  name = name.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');

  return name || key; // Fallback to original key if parsing fails
}

// Helper function to detect if text contains HTML structure
function hasHtmlStructure(text: string): boolean {
  if (!text) return false;
  return /<(p|h[1-6]|div|span|ul|ol|li|br|strong|em|a|b|i|u)\b[^>]*>/i.test(text);
}

export function ThemeContentViewer({
  themeResource,
  currentLanguage,
  shopLocales,
  primaryLocale,
  editableValues,
  onValueChange,
  aiSuggestions,
  onGenerateAI,
  onTranslate,
  onTranslateAll,
  onAcceptSuggestion,
  onRejectSuggestion,
  isLoading = false,
  htmlModes,
  onToggleHtmlMode,
}: ThemeContentViewerProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50; // Render only 50 fields at a time

  if (!themeResource || !themeResource.translatableContent) {
    return (
      <Banner tone="info">
        <p>No translatable content available for this resource.</p>
      </Banner>
    );
  }

  const isPrimaryLocale = currentLanguage === primaryLocale;

  // Filter translatable content by search term - use useMemo for performance
  const filteredContent = useMemo(() => {
    return themeResource.translatableContent.filter((item: any) =>
      item.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.value?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [themeResource.translatableContent, searchTerm]);

  // Calculate pagination
  const totalPages = Math.ceil(filteredContent.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedContent = filteredContent.slice(startIndex, endIndex);

  // Reset to page 1 when search changes
  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentPage(1);
  };

  // Helper to check if field is translated
  // For primary locale, always true. For translations, check if value exists in editableValues
  const isTranslated = (key: string) => {
    if (isPrimaryLocale) return true;
    // Check if translation exists (not empty)
    return !!(editableValues[key] && editableValues[key].trim().length > 0);
  };

  // Helper to get source text (from primary locale)
  const getSourceText = (key: string) => {
    const item = themeResource.translatableContent.find((item: any) => item.key === key);
    return item?.value || "";
  };

  const currentLocaleName = shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage;

  return (
    <BlockStack gap="400">
      {/* Info Banner */}
      <Banner tone="info">
        <BlockStack gap="200">
          <Text as="p" fontWeight="semibold">Theme Resource: {themeResource.resourceTypeLabel}</Text>
          <Text as="p" variant="bodySm">
            This resource contains {themeResource.contentCount} translatable fields from your theme.
            All fields are now editable with AI-enhanced tools.
          </Text>
        </BlockStack>
      </Banner>

      {/* Search */}
      <TextField
        label="Search translatable content"
        value={searchTerm}
        onChange={handleSearchChange}
        placeholder="Search by key or value..."
        autoComplete="off"
        clearButton
        onClearButtonClick={() => handleSearchChange("")}
      />

      {/* Stats */}
      <InlineStack gap="200">
        <Badge tone="info">
          Showing {startIndex + 1}-{Math.min(endIndex, filteredContent.length)} of {filteredContent.length} fields
          {filteredContent.length !== themeResource.contentCount && ` (filtered from ${themeResource.contentCount})`}
        </Badge>
        <Badge tone={isPrimaryLocale ? "success" : "attention"}>
          {currentLocaleName} {isPrimaryLocale && "(Primary)"}
        </Badge>
        {totalPages > 1 && (
          <Badge>Page {currentPage} of {totalPages}</Badge>
        )}
      </InlineStack>

      {/* Pagination - Top */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Pagination
            hasPrevious={currentPage > 1}
            onPrevious={() => setCurrentPage(currentPage - 1)}
            hasNext={currentPage < totalPages}
            onNext={() => setCurrentPage(currentPage + 1)}
            label={`Page ${currentPage} of ${totalPages}`}
          />
        </div>
      )}

      {/* Content List */}
      <div style={{ maxHeight: "600px", overflowY: "auto" }}>
        <BlockStack gap="300">
          {paginatedContent.length > 0 ? (
            paginatedContent.map((item: any, index: number) => {
              const readableName = extractReadableName(item.key);
              const fieldKey = item.key;
              const sourceText = getSourceText(fieldKey);
              const currentValue = editableValues?.[fieldKey] || "";
              const suggestion = aiSuggestions?.[fieldKey];
              const isHtml = hasHtmlStructure(sourceText); // Primary locale determines HTML mode
              const htmlMode = htmlModes?.[fieldKey] || "rendered";

              return (
                <Card key={index}>
                  <BlockStack gap="200">
                    {/* Readable Name */}
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {readableName}
                    </Text>

                    {/* Original Key (smaller, subdued) */}
                    <Text as="p" variant="bodySm" tone="subdued">
                      Key: {fieldKey}
                    </Text>

                    {/* Editable Field - HTML or Text based on primary locale content */}
                    {isHtml ? (
                      <AIEditableHTMLField
                        label={isPrimaryLocale ? "Primary Value" : `Translation (${currentLocaleName})`}
                        value={currentValue}
                        onChange={(value) => onValueChange(fieldKey, value)}
                        mode={htmlMode}
                        onToggleMode={() => onToggleHtmlMode(fieldKey)}
                        fieldType={fieldKey}
                        suggestion={suggestion}
                        isPrimaryLocale={isPrimaryLocale}
                        isTranslated={isTranslated(fieldKey)}
                        isLoading={isLoading}
                        sourceTextAvailable={!!sourceText}
                        onGenerateAI={() => onGenerateAI(fieldKey)}
                        onTranslate={() => onTranslate(fieldKey)}
                        onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
                        onAcceptSuggestion={() => onAcceptSuggestion(fieldKey)}
                        onRejectSuggestion={() => onRejectSuggestion(fieldKey)}
                      />
                    ) : (
                      <AIEditableField
                        label={isPrimaryLocale ? "Primary Value" : `Translation (${currentLocaleName})`}
                        value={currentValue}
                        onChange={(value) => onValueChange(fieldKey, value)}
                        fieldType={fieldKey}
                        suggestion={suggestion}
                        isPrimaryLocale={isPrimaryLocale}
                        isTranslated={isTranslated(fieldKey)}
                        multiline={3}
                        isLoading={isLoading}
                        sourceTextAvailable={!!sourceText}
                        onGenerateAI={() => onGenerateAI(fieldKey)}
                        onTranslate={() => onTranslate(fieldKey)}
                        onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
                        onAcceptSuggestion={() => onAcceptSuggestion(fieldKey)}
                        onRejectSuggestion={() => onRejectSuggestion(fieldKey)}
                      />
                    )}
                  </BlockStack>
                </Card>
              );
            })
          ) : (
            <Card>
              <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                No matching content found
              </Text>
            </Card>
          )}
        </BlockStack>
      </div>

      {/* Pagination - Bottom */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: "1rem" }}>
          <Pagination
            hasPrevious={currentPage > 1}
            onPrevious={() => {
              setCurrentPage(currentPage - 1);
              // Scroll to top of content
              document.querySelector('[style*="maxHeight"]')?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            hasNext={currentPage < totalPages}
            onNext={() => {
              setCurrentPage(currentPage + 1);
              // Scroll to top of content
              document.querySelector('[style*="maxHeight"]')?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            label={`Page ${currentPage} of ${totalPages}`}
          />
        </div>
      )}
    </BlockStack>
  );
}

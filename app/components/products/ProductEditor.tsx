import { useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Text,
  Banner,
} from "@shopify/polaris";
import { FieldEditor } from "./FieldEditor";
import { DescriptionEditor } from "./DescriptionEditor";
import { ProductOptions } from "./ProductOptions";

interface Product {
  id: string;
  title: string;
  descriptionHtml: string;
  handle: string;
  status: string;
  featuredImage?: {
    url: string;
    altText?: string;
  };
  seo?: {
    title: string;
    description: string;
  };
  images?: Array<{
    url: string;
    altText?: string;
  }>;
  options?: Array<{
    id: string;
    name: string;
    position: number;
    values: string[];
  }>;
  metafields?: Array<{
    id: string;
    namespace: string;
    key: string;
    value: string;
    type: string;
  }>;
}

interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
}

interface ProductEditorProps {
  product: Product | null;
  shopLocales: ShopLocale[];
  primaryLocale: string;
  currentLanguage: string;
  onLanguageChange: (locale: string) => void;
  editableTitle: string;
  setEditableTitle: (value: string) => void;
  editableDescription: string;
  setEditableDescription: (value: string) => void;
  editableHandle: string;
  setEditableHandle: (value: string) => void;
  editableSeoTitle: string;
  setEditableSeoTitle: (value: string) => void;
  editableMetaDescription: string;
  setEditableMetaDescription: (value: string) => void;
  aiSuggestions: Record<string, string>;
  hasChanges: boolean;
  getFieldBackgroundColor: (key: string) => string;
  onSave: () => void;
  onTranslateAll: () => void;
  onGenerateAI: (fieldType: string) => void;
  onTranslateField: (fieldType: string) => void;
  onAcceptSuggestion: (fieldType: string) => void;
  onAcceptAndTranslate: (fieldType: string) => void;
  onRejectSuggestion: (fieldType: string) => void;
  isLoading: boolean;
  isSaving: boolean;
  isTranslatingAll: boolean;
  fetcherFormData: FormData | null;
  showSuccessBanner: boolean;
  selectProductText: string;
  optionTranslations: Record<string, { name: string; values: string[] }>;
  onOptionNameChange: (optionId: string, value: string) => void;
  onOptionValueChange: (optionId: string, valueIndex: number, value: string) => void;
  onTranslateOption: (optionId: string) => void;
  isTranslatingOption: boolean;
  translatingOptionId?: string;
}

export function ProductEditor({
  product,
  shopLocales,
  primaryLocale,
  currentLanguage,
  onLanguageChange,
  editableTitle,
  setEditableTitle,
  editableDescription,
  setEditableDescription,
  editableHandle,
  setEditableHandle,
  editableSeoTitle,
  setEditableSeoTitle,
  editableMetaDescription,
  setEditableMetaDescription,
  aiSuggestions,
  hasChanges,
  getFieldBackgroundColor,
  onSave,
  onTranslateAll,
  onGenerateAI,
  onTranslateField,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
  isLoading,
  isSaving,
  isTranslatingAll,
  fetcherFormData,
  showSuccessBanner,
  selectProductText,
  optionTranslations,
  onOptionNameChange,
  onOptionValueChange,
  onTranslateOption,
  isTranslatingOption,
  translatingOptionId,
}: ProductEditorProps) {
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const isPrimaryLocale = currentLanguage === primaryLocale;

  const isFieldLoading = (fieldType: string, action: string) => {
    return (
      isLoading &&
      fetcherFormData?.get("fieldType") === fieldType &&
      fetcherFormData?.get("action") === action
    );
  };

  if (!product) {
    return (
      <Card padding="600">
        <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
          <Text as="p" variant="headingLg" tone="subdued">
            {selectProductText}
          </Text>
        </div>
      </Card>
    );
  }

  return (
    <>
      {showSuccessBanner && (
        <div style={{ marginBottom: "1rem" }}>
          <Banner title="Erfolg!" tone="success" onDismiss={() => {}}>
            <p>Änderungen erfolgreich gespeichert!</p>
          </Banner>
        </div>
      )}

      <Card padding="600">
        <BlockStack gap="500">
          {/* Language Selector */}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {shopLocales.map((locale: ShopLocale) => (
              <Button
                key={locale.locale}
                variant={currentLanguage === locale.locale ? "primary" : undefined}
                onClick={() => onLanguageChange(locale.locale)}
                size="slim"
              >
                {locale.name} {locale.primary && "(Hauptsprache)"}
              </Button>
            ))}
          </div>

          {/* Header with Save Button */}
          <InlineStack align="end" blockAlign="center">
            <InlineStack gap="200">
              {isPrimaryLocale && (
                <Button onClick={onTranslateAll} loading={isTranslatingAll}>
                  In alle Sprachen übersetzen
                </Button>
              )}
              <Button
                variant={hasChanges ? "primary" : undefined}
                onClick={onSave}
                disabled={!hasChanges}
                loading={isSaving}
              >
                Änderungen speichern
              </Button>
            </InlineStack>
          </InlineStack>

          {/* Image Gallery */}
          {product.images && product.images.length > 0 && (
            <BlockStack gap="300">
              {/* Main Image Display */}
              <div style={{ position: "relative", width: "100%", maxWidth: "300px" }}>
                <img
                  src={product.images[selectedImageIndex].url}
                  alt={product.images[selectedImageIndex].altText || product.title}
                  style={{
                    width: "100%",
                    borderRadius: "8px",
                    display: "block"
                  }}
                />
              </div>

              {/* Thumbnail Navigation - only show if multiple images */}
              {product.images.length > 1 && (
                <div style={{
                  display: "flex",
                  gap: "8px",
                  flexWrap: "wrap",
                  maxWidth: "300px"
                }}>
                  {product.images.map((image, index) => (
                    <button
                      key={index}
                      onClick={() => setSelectedImageIndex(index)}
                      style={{
                        width: "50px",
                        height: "50px",
                        padding: 0,
                        border: selectedImageIndex === index ? "2px solid #005bd3" : "2px solid transparent",
                        borderRadius: "6px",
                        cursor: "pointer",
                        overflow: "hidden",
                        background: "transparent",
                        transition: "border-color 0.2s ease",
                      }}
                    >
                      <img
                        src={image.url}
                        alt={image.altText || `Bild ${index + 1}`}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          borderRadius: "4px",
                        }}
                      />
                    </button>
                  ))}
                </div>
              )}
            </BlockStack>
          )}

          {/* Title Field */}
          <FieldEditor
            label={`Produkttitel (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableTitle}
            onChange={setEditableTitle}
            fieldType="title"
            suggestion={aiSuggestions.title}
            isPrimaryLocale={isPrimaryLocale}
            backgroundColor={getFieldBackgroundColor("title")}
            helpText={`${editableTitle.length} Zeichen`}
            isLoading={isFieldLoading("title", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("title")}
            onTranslate={() => onTranslateField("title")}
            onAcceptSuggestion={() => onAcceptSuggestion("title")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("title")}
            onRejectSuggestion={() => onRejectSuggestion("title")}
          />

          {/* Description Field */}
          <DescriptionEditor
            label={`Produktbeschreibung (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableDescription}
            onChange={setEditableDescription}
            mode={descriptionMode}
            onToggleMode={() =>
              setDescriptionMode(descriptionMode === "html" ? "rendered" : "html")
            }
            suggestion={aiSuggestions.description}
            isPrimaryLocale={isPrimaryLocale}
            backgroundColor={getFieldBackgroundColor("body_html")}
            isLoading={isFieldLoading("description", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("description")}
            onTranslate={() => onTranslateField("description")}
            onAcceptSuggestion={() => onAcceptSuggestion("description")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("description")}
            onRejectSuggestion={() => onRejectSuggestion("description")}
          />

          {/* Handle Field */}
          <FieldEditor
            label={`URL-Slug (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableHandle}
            onChange={setEditableHandle}
            fieldType="handle"
            suggestion={aiSuggestions.handle}
            isPrimaryLocale={isPrimaryLocale}
            backgroundColor={getFieldBackgroundColor("handle")}
            isLoading={isFieldLoading("handle", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("handle")}
            onTranslate={() => onTranslateField("handle")}
            onAcceptSuggestion={() => onAcceptSuggestion("handle")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("handle")}
            onRejectSuggestion={() => onRejectSuggestion("handle")}
          />

          {/* SEO Title Field */}
          <FieldEditor
            label={`SEO-Titel (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableSeoTitle}
            onChange={setEditableSeoTitle}
            fieldType="seoTitle"
            suggestion={aiSuggestions.seoTitle}
            isPrimaryLocale={isPrimaryLocale}
            backgroundColor={getFieldBackgroundColor("seo_title")}
            helpText={`${editableSeoTitle.length} Zeichen (empfohlen: 50-60)`}
            isLoading={isFieldLoading("seoTitle", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("seoTitle")}
            onTranslate={() => onTranslateField("seoTitle")}
            onAcceptSuggestion={() => onAcceptSuggestion("seoTitle")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("seoTitle")}
            onRejectSuggestion={() => onRejectSuggestion("seoTitle")}
          />

          {/* Meta Description Field */}
          <FieldEditor
            label={`Meta-Beschreibung (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableMetaDescription}
            onChange={setEditableMetaDescription}
            fieldType="metaDescription"
            suggestion={aiSuggestions.metaDescription}
            isPrimaryLocale={isPrimaryLocale}
            backgroundColor={getFieldBackgroundColor("seo_description")}
            helpText={`${editableMetaDescription.length} Zeichen (empfohlen: 150-160)`}
            multiline={3}
            isLoading={isFieldLoading("metaDescription", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("metaDescription")}
            onTranslate={() => onTranslateField("metaDescription")}
            onAcceptSuggestion={() => onAcceptSuggestion("metaDescription")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("metaDescription")}
            onRejectSuggestion={() => onRejectSuggestion("metaDescription")}
          />

        </BlockStack>
      </Card>

      {/* Product Options */}
      {product.options && product.options.length > 0 && (
        <ProductOptions
          options={product.options}
          isPrimaryLocale={isPrimaryLocale}
          currentLanguage={currentLanguage}
          translations={optionTranslations}
          onTranslate={onTranslateOption}
          onOptionNameChange={onOptionNameChange}
          onOptionValueChange={onOptionValueChange}
          isTranslating={isTranslatingOption}
          translatingOptionId={translatingOptionId}
        />
      )}
    </>
  );
}

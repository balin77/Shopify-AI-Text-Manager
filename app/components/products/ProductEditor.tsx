import { useState, useEffect } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Text,
  Banner,
  TextField,
  Icon,
} from "@shopify/polaris";
import { CheckIcon, XIcon } from "@shopify/polaris-icons";
import { AIEditableField } from "../AIEditableField";
import { AIEditableHTMLField } from "../AIEditableHTMLField";
import { ProductOptions } from "./ProductOptions";
import { LocaleNavigationButtons } from "../LocaleNavigationButtons";
import { useI18n } from "../../contexts/I18nContext";

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
  onGenerateAltText: (imageIndex: number) => void;
  onGenerateAllAltTexts: () => void;
  fetcherData: any;
  imageAltTexts: Record<number, string>;
  setImageAltTexts: (value: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)) => void;
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
  onGenerateAltText,
  onGenerateAllAltTexts,
  fetcherData,
  imageAltTexts,
  setImageAltTexts,
}: ProductEditorProps) {
  const { t } = useI18n();
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});

  const isPrimaryLocale = currentLanguage === primaryLocale;

  // Reset selected image when product changes
  useEffect(() => {
    setSelectedImageIndex(0);
  }, [product?.id]);

  // Helper to determine if a field is translated
  const isFieldTranslated = (fieldKey: string) => {
    if (isPrimaryLocale) return true;
    const bgColor = getFieldBackgroundColor(fieldKey);
    return bgColor === "white" || bgColor === "#ffffff";
  };

  // Handle single alt-text generation responses (show suggestion box)
  useEffect(() => {
    if (fetcherData?.success && 'altText' in fetcherData && 'imageIndex' in fetcherData) {
      const { altText, imageIndex} = fetcherData;
      setAltTextSuggestions(prev => ({
        ...prev,
        [imageIndex]: altText
      }));
    }
  }, [fetcherData]);

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
          <Banner title={t.products.successTitle} tone="success" onDismiss={() => {}}>
            <p>{t.products.changesSavedMessage}</p>
          </Banner>
        </div>
      )}

      <Card padding="600">
        <BlockStack gap="500">
          {/* Language Selector */}
          <LocaleNavigationButtons
            shopLocales={shopLocales}
            currentLanguage={currentLanguage}
            primaryLocaleSuffix={t.products.primaryLanguageSuffix}
            selectedItem={product}
            primaryLocale={primaryLocale}
            contentType="products"
            hasChanges={hasChanges}
            onLanguageChange={onLanguageChange}
          />

          {/* Header with Save Button */}
          <InlineStack align="end" blockAlign="center">
            <InlineStack gap="200">
              {isPrimaryLocale && (
                <Button onClick={onTranslateAll} loading={isTranslatingAll}>
                  {t.products.translateAll}
                </Button>
              )}
              <Button
                variant={hasChanges ? "primary" : undefined}
                onClick={onSave}
                disabled={!hasChanges}
                loading={isSaving}
              >
                {t.products.saveChanges}
              </Button>
            </InlineStack>
          </InlineStack>

          {/* Image Gallery */}
          {product.images && product.images.length > 0 && (
            <BlockStack gap="400">
              {/* Image Layout: Preview left, Grid right */}
              <div
                style={{
                  display: "flex",
                  gap: "16px",
                  width: "100%",
                }}
              >
                {/* Large Preview Image */}
                <div
                  style={{
                    flex: "0 0 400px",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      paddingBottom: "100%",
                      border: "2px solid #e1e3e5",
                      borderRadius: "8px",
                      overflow: "hidden",
                      backgroundColor: "#f6f6f7",
                    }}
                  >
                    <img
                      src={product.images[selectedImageIndex].url}
                      alt={imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex].altText || `${t.products.image} ${selectedImageIndex + 1}`}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                    {/* Alt-text status badge on preview */}
                    <div
                      style={{
                        position: "absolute",
                        top: "8px",
                        right: "8px",
                        backgroundColor: !!(imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex].altText) ? "#008060" : "#d72c0d",
                        borderRadius: "50%",
                        width: "32px",
                        height: "32px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                      }}
                    >
                      <div style={{ color: "white", fontSize: "18px" }}>
                        <Icon source={!!(imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex].altText) ? CheckIcon : XIcon} tone="base" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Image Grid */}
                <div
                  style={{
                    flex: "1",
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gridAutoRows: "minmax(0, max-content)",
                    gap: "12px",
                    maxHeight: "400px",
                    overflowY: "auto",
                    overflowX: "hidden",
                    alignContent: "start",
                  }}
                >
                  {product.images.map((image, index) => {
                    const hasAltText = !!(imageAltTexts[index] || image.altText);
                    const isSelected = index === selectedImageIndex;

                    return (
                      <button
                        key={index}
                        onClick={() => setSelectedImageIndex(index)}
                        style={{
                          position: "relative",
                          width: "100%",
                          padding: 0,
                          border: isSelected ? "3px solid #005bd3" : "2px solid #e1e3e5",
                          borderRadius: "8px",
                          cursor: "pointer",
                          overflow: "hidden",
                          background: "transparent",
                          transition: "border-color 0.2s ease",
                          aspectRatio: "1",
                        }}
                      >
                        <img
                          src={image.url}
                          alt={imageAltTexts[index] || image.altText || `${t.products.image} ${index + 1}`}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                          }}
                        />
                        {/* Alt-text status badge */}
                        <div
                          style={{
                            position: "absolute",
                            top: "4px",
                            right: "4px",
                            backgroundColor: hasAltText ? "#008060" : "#d72c0d",
                            borderRadius: "50%",
                            width: "20px",
                            height: "20px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                          }}
                        >
                          <div style={{ color: "white", fontSize: "12px" }}>
                            <Icon source={hasAltText ? CheckIcon : XIcon} tone="base" />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Auto-generate all button - below images */}
              <InlineStack align="start">
                <Button
                  size="slim"
                  onClick={onGenerateAllAltTexts}
                  loading={isFieldLoading("allAltTexts", "generateAllAltTexts")}
                >
                  ✨ {t.products.generateAllAltTexts}
                </Button>
              </InlineStack>

              {/* Alt-text input for selected image */}
              <AIEditableField
                label={`${t.products.altTextForImage} ${selectedImageIndex + 1}`}
                value={imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex]?.altText || ""}
                onChange={(value) => {
                  setImageAltTexts((prev) => ({
                    ...prev,
                    [selectedImageIndex]: value,
                  }));
                  // Clear suggestion when user manually edits
                  if (altTextSuggestions[selectedImageIndex]) {
                    setAltTextSuggestions((prev) => {
                      const newSuggestions = { ...prev };
                      delete newSuggestions[selectedImageIndex];
                      return newSuggestions;
                    });
                  }
                }}
                fieldType={`altText_${selectedImageIndex}`}
                suggestion={altTextSuggestions[selectedImageIndex]}
                isPrimaryLocale={true}
                placeholder={t.products.altTextPlaceholder}
                isLoading={isFieldLoading(`altText_${selectedImageIndex}`, "generateAltText")}
                onGenerateAI={() => onGenerateAltText(selectedImageIndex)}
                onTranslate={() => {}} // Not needed for alt texts
                onAcceptSuggestion={() => {
                  setImageAltTexts((prev) => ({
                    ...prev,
                    [selectedImageIndex]: altTextSuggestions[selectedImageIndex],
                  }));
                  setAltTextSuggestions((prev) => {
                    const newSuggestions = { ...prev };
                    delete newSuggestions[selectedImageIndex];
                    return newSuggestions;
                  });
                }}
                onRejectSuggestion={() => {
                  setAltTextSuggestions((prev) => {
                    const newSuggestions = { ...prev };
                    delete newSuggestions[selectedImageIndex];
                    return newSuggestions;
                  });
                }}
              />
            </BlockStack>
          )}

          {/* Title Field */}
          <AIEditableField
            label={`${t.products.productTitle} (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableTitle}
            onChange={setEditableTitle}
            fieldType="title"
            suggestion={aiSuggestions.title}
            isPrimaryLocale={isPrimaryLocale}
            isTranslated={isFieldTranslated("title")}
            helpText={`${editableTitle.length} ${t.products.characters}`}
            isLoading={isFieldLoading("title", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("title")}
            onTranslate={() => onTranslateField("title")}
            onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
            onAcceptSuggestion={() => onAcceptSuggestion("title")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("title")}
            onRejectSuggestion={() => onRejectSuggestion("title")}
          />

          {/* Description Field */}
          <AIEditableHTMLField
            label={`${t.products.productDescription} (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableDescription}
            onChange={setEditableDescription}
            mode={descriptionMode}
            onToggleMode={() =>
              setDescriptionMode(descriptionMode === "html" ? "rendered" : "html")
            }
            fieldType="description"
            suggestion={aiSuggestions.description}
            isPrimaryLocale={isPrimaryLocale}
            isTranslated={isFieldTranslated("body_html")}
            isLoading={isFieldLoading("description", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("description")}
            onTranslate={() => onTranslateField("description")}
            onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
            onAcceptSuggestion={() => onAcceptSuggestion("description")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("description")}
            onRejectSuggestion={() => onRejectSuggestion("description")}
          />

          {/* Handle Field */}
          <AIEditableField
            label={`${t.products.urlSlug} (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableHandle}
            onChange={setEditableHandle}
            fieldType="handle"
            suggestion={aiSuggestions.handle}
            isPrimaryLocale={isPrimaryLocale}
            isTranslated={isFieldTranslated("handle")}
            isLoading={isFieldLoading("handle", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("handle")}
            onTranslate={() => onTranslateField("handle")}
            onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
            onAcceptSuggestion={() => onAcceptSuggestion("handle")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("handle")}
            onRejectSuggestion={() => onRejectSuggestion("handle")}
          />

          {/* SEO Title Field */}
          <AIEditableField
            label={`${t.products.seoTitle} (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableSeoTitle}
            onChange={setEditableSeoTitle}
            fieldType="seoTitle"
            suggestion={aiSuggestions.seoTitle}
            isPrimaryLocale={isPrimaryLocale}
            isTranslated={isFieldTranslated("meta_title")}
            helpText={`${editableSeoTitle.length} ${t.products.characters} (${t.products.recommended}: 50-60)`}
            isLoading={isFieldLoading("seoTitle", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("seoTitle")}
            onTranslate={() => onTranslateField("seoTitle")}
            onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
            onAcceptSuggestion={() => onAcceptSuggestion("seoTitle")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("seoTitle")}
            onRejectSuggestion={() => onRejectSuggestion("seoTitle")}
          />

          {/* Meta Description Field */}
          <AIEditableField
            label={`${t.products.metaDescription} (${
              shopLocales.find((l) => l.locale === currentLanguage)?.name || currentLanguage
            })`}
            value={editableMetaDescription}
            onChange={setEditableMetaDescription}
            fieldType="metaDescription"
            suggestion={aiSuggestions.metaDescription}
            isPrimaryLocale={isPrimaryLocale}
            isTranslated={isFieldTranslated("meta_description")}
            helpText={`${editableMetaDescription.length} ${t.products.characters} (${t.products.recommended}: 150-160)`}
            multiline={3}
            isLoading={isFieldLoading("metaDescription", isPrimaryLocale ? "generateAIText" : "translateField")}
            onGenerateAI={() => onGenerateAI("metaDescription")}
            onTranslate={() => onTranslateField("metaDescription")}
            onTranslateAll={isPrimaryLocale ? onTranslateAll : undefined}
            onAcceptSuggestion={() => onAcceptSuggestion("metaDescription")}
            onAcceptAndTranslate={() => onAcceptAndTranslate("metaDescription")}
            onRejectSuggestion={() => onRejectSuggestion("metaDescription")}
          />

        </BlockStack>
      </Card>

      {/* Product Options */}
      {product.options && product.options.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
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
        </div>
      )}
    </>
  );
}

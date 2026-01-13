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
import { SaveDiscardButtons } from "../SaveDiscardButtons";
import { useI18n } from "../../contexts/I18nContext";
import { usePlan } from "../../contexts/PlanContext";

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
  onFormatAI?: (fieldType: string) => void;
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
  onTranslateAltText: (imageIndex: number) => void;
  fetcherData: any;
  imageAltTexts: Record<number, string>;
  setImageAltTexts: (value: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)) => void;
  onDiscardChanges?: () => void;
  fetcherState?: string;
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
  onFormatAI,
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
  onTranslateAltText,
  fetcherData,
  imageAltTexts,
  setImageAltTexts,
  onDiscardChanges,
  fetcherState = "idle",
}: ProductEditorProps) {
  const { t } = useI18n();
  const { plan, shouldCacheAllProductImages } = usePlan();
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});

  const isPrimaryLocale = currentLanguage === primaryLocale;
  const isFreePlan = plan === "free";
  const canShowAllImages = shouldCacheAllProductImages();

  // Reset selected image when product changes or ensure index is valid
  useEffect(() => {
    if (!product?.images || product.images.length === 0) {
      setSelectedImageIndex(0);
    } else if (selectedImageIndex >= product.images.length) {
      setSelectedImageIndex(0);
    }
  }, [product?.id, product?.images?.length]);

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
          <InlineStack align="space-between" blockAlign="center">
            <div>
              {isPrimaryLocale && (
                <Button onClick={onTranslateAll} loading={isTranslatingAll}>
                  {t.products.translateAll}
                </Button>
              )}
            </div>
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={onSave}
              onDiscard={onDiscardChanges || (() => {})}
              highlightSaveButton={false}
              saveText={t.products.saveChanges}
              discardText={t.products.discardChanges || "Verwerfen"}
              action="updateProduct"
              fetcherState={fetcherState}
              fetcherFormData={fetcherFormData}
            />
          </InlineStack>

          {/* Image Gallery */}
          {((product.images && product.images.length > 0) || product.featuredImage) && (
            <BlockStack gap="400">
              {/* Free Plan Notice */}
              {isFreePlan && (
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    {t.products.onlyFeaturedImageAvailable}
                  </Text>
                </Banner>
              )}

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
                    flex: "0 0 280px",
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
                    {/* Show featured image in free plan, or selected image in other plans */}
                    {isFreePlan && product.featuredImage ? (
                      <img
                        src={product.featuredImage.url}
                        alt={product.featuredImage.altText || t.products.featuredImage}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : product.images && product.images.length > 0 && product.images[selectedImageIndex] ? (
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
                    ) : product.featuredImage ? (
                      <img
                        src={product.featuredImage.url}
                        alt={product.featuredImage.altText || t.products.featuredImage}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : null}
                    {/* Alt-text status badge on preview */}
                    {!isFreePlan && product.images && product.images[selectedImageIndex] && (
                      <div
                        style={{
                          position: "absolute",
                          top: "8px",
                          right: "8px",
                          backgroundColor: !!(imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex].altText) ? "#008060" : "#d72c0d",
                          borderRadius: "50%",
                          width: "36px",
                          height: "36px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                        }}
                      >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        {!!(imageAltTexts[selectedImageIndex] || product.images[selectedImageIndex].altText) ? (
                          <path
                            d="M16 6L8 14L4 10"
                            stroke="white"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        ) : (
                          <>
                            <path
                              d="M5 5L15 15"
                              stroke="white"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            />
                            <path
                              d="M15 5L5 15"
                              stroke="white"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            />
                          </>
                        )}
                      </svg>
                      </div>
                    )}
                  </div>
                </div>

                {/* Image Grid - Scrollable Container */}
                {!isFreePlan && (
                  <div
                    style={{
                      flex: "1",
                      maxHeight: "280px",
                      overflowY: "auto",
                      overflowX: "hidden",
                    }}
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(4, 1fr)",
                        gap: "12px",
                      }}
                    >
                    {product.images && product.images.map((image, index) => {
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
                            width: "24px",
                            height: "24px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 20 20"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            {hasAltText ? (
                              <path
                                d="M16 6L8 14L4 10"
                                stroke="white"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            ) : (
                              <>
                                <path
                                  d="M5 5L15 15"
                                  stroke="white"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                />
                                <path
                                  d="M15 5L5 15"
                                  stroke="white"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                />
                              </>
                            )}
                          </svg>
                        </div>
                      </button>
                    );
                  })}
                    </div>
                  </div>
                )}

                {/* Free Plan: Show locked message instead of grid */}
                {isFreePlan && (
                  <div
                    style={{
                      flex: "1",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: "2px dashed #c9cccf",
                      borderRadius: "8px",
                      padding: "2rem",
                      backgroundColor: "#f6f6f7",
                    }}
                  >
                    <BlockStack gap="300" inlineAlign="center">
                      <Text as="p" variant="bodyMd" alignment="center" tone="subdued">
                        🔒 {t.products.additionalImagesLocked}
                      </Text>
                      <Text as="p" variant="bodySm" alignment="center" tone="subdued">
                        {t.products.availableInBasicPlan}
                      </Text>
                    </BlockStack>
                  </div>
                )}
              </div>

              {/* Auto-generate all button - below images */}
              {!isFreePlan && (
                <InlineStack align="start">
                  <Button
                    size="slim"
                    onClick={onGenerateAllAltTexts}
                    loading={isFieldLoading("allAltTexts", "generateAllAltTexts")}
                  >
                    ✨ {t.products.generateAllAltTexts}
                  </Button>
                </InlineStack>
              )}

              {/* Alt-text input for selected image - only in non-free plans */}
              {!isFreePlan && (
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
                isPrimaryLocale={isPrimaryLocale}
                isTranslated={true}
                placeholder={t.products.altTextPlaceholder}
                isLoading={isFieldLoading(`altText_${selectedImageIndex}`, isPrimaryLocale ? "generateAltText" : "translateAltText")}
                onGenerateAI={() => onGenerateAltText(selectedImageIndex)}
                onTranslate={() => onTranslateAltText(selectedImageIndex)}
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
              )}
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
            isLoading={
              isFieldLoading("title", "generateAIText") ||
              isFieldLoading("title", "formatAIText") ||
              isFieldLoading("title", "translateField")
            }
            onGenerateAI={() => onGenerateAI("title")}
            onFormatAI={onFormatAI ? () => onFormatAI("title") : undefined}
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
            isLoading={
              isFieldLoading("description", "generateAIText") ||
              isFieldLoading("description", "formatAIText") ||
              isFieldLoading("description", "translateField")
            }
            onGenerateAI={() => onGenerateAI("description")}
            onFormatAI={onFormatAI ? () => onFormatAI("description") : undefined}
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
            isLoading={
              isFieldLoading("handle", "generateAIText") ||
              isFieldLoading("handle", "formatAIText") ||
              isFieldLoading("handle", "translateField")
            }
            onGenerateAI={() => onGenerateAI("handle")}
            onFormatAI={onFormatAI ? () => onFormatAI("handle") : undefined}
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
            isLoading={
              isFieldLoading("seoTitle", "generateAIText") ||
              isFieldLoading("seoTitle", "formatAIText") ||
              isFieldLoading("seoTitle", "translateField")
            }
            onGenerateAI={() => onGenerateAI("seoTitle")}
            onFormatAI={onFormatAI ? () => onFormatAI("seoTitle") : undefined}
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
            isLoading={
              isFieldLoading("metaDescription", "generateAIText") ||
              isFieldLoading("metaDescription", "formatAIText") ||
              isFieldLoading("metaDescription", "translateField")
            }
            onGenerateAI={() => onGenerateAI("metaDescription")}
            onFormatAI={onFormatAI ? () => onFormatAI("metaDescription") : undefined}
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

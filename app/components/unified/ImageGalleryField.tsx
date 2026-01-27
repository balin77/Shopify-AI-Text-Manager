/**
 * ImageGalleryField - Optional image gallery field for Unified Content System
 *
 * Reusable component that can be added to any content type:
 * - Products (primary use case)
 * - Collections (featured image)
 * - Blog Articles (featured image)
 * - Pages (optional hero images)
 *
 * Features:
 * - Large preview with selected image
 * - Grid of thumbnails (4 columns, scrollable)
 * - Alt-text management with status badges
 * - AI generation for alt-texts
 * - Translation support for alt-texts
 * - Plan-based restrictions (free plan = featured image only)
 * - Bulk alt-text generation
 */

import { useState, useEffect } from "react";
import { BlockStack, InlineStack, Button, Text, Banner } from "@shopify/polaris";
import { AIEditableField } from "../AIEditableField";

export interface ImageData {
  url: string;
  altText?: string;
  id?: string;
}

interface ImageGalleryFieldProps {
  /** Array of images to display */
  images?: ImageData[];

  /** Featured/primary image (always shown, even in free plan) */
  featuredImage?: ImageData;

  /** Current locale */
  currentLanguage: string;

  /** Primary locale */
  primaryLocale: string;

  /** Whether user is on primary locale */
  isPrimaryLocale: boolean;

  /** Whether user is on free plan (shows only featured image) */
  isFreePlan?: boolean;

  /** Alt-text values (indexed by image position) */
  altTexts: Record<number, string>;

  /** Callback when alt-text changes */
  onAltTextChange: (imageIndex: number, value: string) => void;

  /** Callback to generate AI alt-text for single image */
  onGenerateAltText: (imageIndex: number) => void;

  /** Callback to generate AI alt-text for all images */
  onGenerateAllAltTexts?: () => void;

  /** Callback to translate alt-text (for non-primary locale) */
  onTranslateAltText: (imageIndex: number) => void;

  /** Callback to translate alt-text to all locales (for primary locale) */
  onTranslateAltTextToAllLocales?: (imageIndex: number) => void;

  /** AI suggestions for alt-texts (indexed by image position) */
  altTextSuggestions?: Record<number, string>;

  /** Callback when AI suggestion is accepted */
  onAcceptSuggestion: (imageIndex: number) => void;

  /** Callback when AI suggestion is accepted and should be translated to all locales */
  onAcceptAndTranslateSuggestion?: (imageIndex: number) => void;

  /** Callback when AI suggestion is rejected */
  onRejectSuggestion: (imageIndex: number) => void;

  /** Callback to clear alt-text */
  onClearAltText?: (imageIndex: number) => void;

  /** Whether a specific field is loading */
  isFieldLoading?: (imageIndex: number) => boolean;

  /** Translation strings */
  t?: {
    image?: string;
    featuredImage?: string;
    altTextForImage?: string;
    altTextPlaceholder?: string;
    generateAllAltTexts?: string;
    onlyFeaturedImageAvailable?: string;
    additionalImagesLocked?: string;
    availableInBasicPlan?: string;
  };
}

export function ImageGalleryField({
  images = [],
  featuredImage,
  currentLanguage,
  primaryLocale,
  isPrimaryLocale,
  isFreePlan = false,
  altTexts,
  onAltTextChange,
  onGenerateAltText,
  onGenerateAllAltTexts,
  onTranslateAltText,
  onTranslateAltTextToAllLocales,
  altTextSuggestions = {},
  onAcceptSuggestion,
  onAcceptAndTranslateSuggestion,
  onRejectSuggestion,
  onClearAltText,
  isFieldLoading,
  t = {},
}: ImageGalleryFieldProps) {
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // Reset selected image when images change
  useEffect(() => {
    if (!images || images.length === 0) {
      setSelectedImageIndex(0);
    } else if (selectedImageIndex >= images.length) {
      setSelectedImageIndex(0);
    }
  }, [images?.length]);

  // Determine which image to show in preview
  const getPreviewImage = (): ImageData | null => {
    if (isFreePlan && featuredImage) {
      return featuredImage;
    }
    if (images && images.length > 0 && images[selectedImageIndex]) {
      return images[selectedImageIndex];
    }
    if (featuredImage) {
      return featuredImage;
    }
    return null;
  };

  const previewImage = getPreviewImage();
  const hasImages = (images && images.length > 0) || featuredImage;

  if (!hasImages) {
    return null; // Don't render anything if no images
  }

  return (
    <BlockStack gap="400">
      {/* Free Plan Notice */}
      {isFreePlan && (
        <Banner tone="info">
          <Text as="p" variant="bodySm">
            {t.onlyFeaturedImageAvailable || "Only the featured image is available in the free plan."}
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
            {previewImage && (
              <img
                src={previewImage.url}
                alt={altTexts[selectedImageIndex] || previewImage.altText || t.featuredImage || "Image"}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            )}
            {/* Alt-text status badge on preview */}
            {!isFreePlan && images && images[selectedImageIndex] && (
              <div
                style={{
                  position: "absolute",
                  top: "8px",
                  right: "8px",
                  backgroundColor: (altTexts[selectedImageIndex] !== undefined
                    ? altTexts[selectedImageIndex] !== ""
                    : (isPrimaryLocale && !!images[selectedImageIndex]?.altText)) ? "#008060" : "#d72c0d",
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
                  {(altTexts[selectedImageIndex] !== undefined
                    ? altTexts[selectedImageIndex] !== ""
                    : (isPrimaryLocale && !!images[selectedImageIndex]?.altText)) ? (
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
        {!isFreePlan && images && images.length > 0 ? (
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
                gridTemplateColumns: "repeat(auto-fill, minmax(61px, 134px))",
                gap: "12px",
              }}
            >
              {images.map((image, index) => {
                // Check if user explicitly cleared the alt-text (empty string) vs never edited (undefined)
                // For foreign languages: only show as "has alt text" if there's a translation, not if primary has one
                const hasAltText = altTexts[index] !== undefined
                  ? altTexts[index] !== ""
                  : (isPrimaryLocale && !!image.altText);
                const isSelected = index === selectedImageIndex;

                return (
                  <button
                    key={index}
                    onClick={() => setSelectedImageIndex(index)}
                    style={{
                      position: "relative",
                      width: "100%",
                      minWidth: "61px",
                      maxWidth: "134px",
                      minHeight: "61px",
                      maxHeight: "134px",
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
                      alt={altTexts[index] || image.altText || `${t.image || "Image"} ${index + 1}`}
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
        ) : isFreePlan ? (
          /* Free Plan: Show locked message instead of grid */
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
                🔒 {t.additionalImagesLocked || "Additional images are locked"}
              </Text>
              <Text as="p" variant="bodySm" alignment="center" tone="subdued">
                {t.availableInBasicPlan || "Available in Basic plan and above"}
              </Text>
            </BlockStack>
          </div>
        ) : null}
      </div>

      {/* Auto-generate all button - below images (only in primary locale) */}
      {!isFreePlan && isPrimaryLocale && onGenerateAllAltTexts && images && images.length > 1 && (
        <InlineStack align="start">
          <Button
            size="slim"
            onClick={onGenerateAllAltTexts}
            loading={isFieldLoading ? isFieldLoading(-1) : false}
          >
            ✨ {t.generateAllAltTexts || "Generate all alt-texts"}
          </Button>
        </InlineStack>
      )}

      {/* Alt-text input for selected image - only in non-free plans */}
      {!isFreePlan && images && images.length > 0 && (
        <AIEditableField
          label={`${t.altTextForImage || "Alt-text for image"} ${selectedImageIndex + 1}`}
          value={altTexts[selectedImageIndex] !== undefined
            ? altTexts[selectedImageIndex]
            : (isPrimaryLocale ? (images[selectedImageIndex]?.altText || "") : "")}
          onChange={(value) => onAltTextChange(selectedImageIndex, value)}
          fieldType={`altText_${selectedImageIndex}`}
          fieldKey={`altText_${selectedImageIndex}`}
          helpKey="altText"
          suggestion={altTextSuggestions[selectedImageIndex]}
          isPrimaryLocale={isPrimaryLocale}
          isTranslated={true}
          placeholder={t.altTextPlaceholder}
          isLoading={isFieldLoading ? isFieldLoading(selectedImageIndex) : false}
          onGenerateAI={isPrimaryLocale ? () => onGenerateAltText(selectedImageIndex) : undefined}
          onTranslate={() => onTranslateAltText(selectedImageIndex)}
          onTranslateToAllLocales={onTranslateAltTextToAllLocales ? () => onTranslateAltTextToAllLocales(selectedImageIndex) : undefined}
          onAcceptSuggestion={() => onAcceptSuggestion(selectedImageIndex)}
          onAcceptAndTranslate={onAcceptAndTranslateSuggestion ? () => onAcceptAndTranslateSuggestion(selectedImageIndex) : undefined}
          onRejectSuggestion={() => onRejectSuggestion(selectedImageIndex)}
          onClear={onClearAltText ? () => onClearAltText(selectedImageIndex) : undefined}
        />
      )}
    </BlockStack>
  );
}

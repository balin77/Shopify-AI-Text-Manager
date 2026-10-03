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
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useSingleLocaleHint } from "../../contexts/LocaleAvailabilityContext";
import { useLocalizedMediaContext } from "../localized-images/LocalizedMediaContext";
import { ReplacedMediaBadge } from "../localized-images/ReplacedMediaBadge";
import { LocalizedMediaReplaceButtons } from "../localized-images/LocalizedMediaReplaceButton";
import { isAltTextTranslated, hasAltTextMissingTranslations } from "../../utils/field-validation.utils";
import type { ShopLocale, AltTextTranslation } from "../../types/content-editor.types";

function extractFilename(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? url;
  } catch {
    return url.split("/").pop()?.split("?")[0] ?? url;
  }
}

export interface ImageData {
  url: string;
  altText?: string;
  altTextTranslations?: AltTextTranslation[];
  id?: string;
  /** Shopify media GID (products): what a per-language replacement is keyed by. */
  mediaId?: string | null;
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

  /** All enabled shop locales — used to compute the missing-translation indicator on primary */
  shopLocales?: ShopLocale[];

  /** Alt-text values (indexed by image position) */
  altTexts: Record<number, string>;

  /**
   * Image indices whose alt text is inherited from the global value while a
   * non-global market is selected — greyed out + italic, like the main fields.
   */
  altTextFallbackIndices?: Set<number>;

  /** Callback when alt-text changes */
  onAltTextChange: (imageIndex: number, value: string) => void;

  /** Callback to generate AI alt-text for single image */
  onGenerateAltText: (imageIndex: number, userInstruction?: string) => void;

  /** Callback to generate AI alt-text for all images */
  onGenerateAllAltTexts?: () => void;

  /** Callback to translate all alt-texts to all foreign locales (primary locale) */
  onTranslateAllAltTexts?: () => void;

  /** Callback to translate all alt-texts into the current foreign locale */
  onTranslateAllAltTextsForLocale?: () => void;
  /** "Save first" reason for an image whose PRIMARY alt is an unsaved draft:
   *  its copy/translate-to-all buttons are disabled with it. */
  altSaveFirstHint?: (imageIndex: number) => string | undefined;
  /** The same for "translate all alt texts" (any primary alt unsaved). */
  translateAllAltsSaveFirstHint?: string;

  /** Callback to copy primary alt-text into current foreign locale */
  onCopyAltText?: (imageIndex: number) => void;

  /** Callback to copy primary alt-text to all foreign locales */
  onCopyAltTextToAllLocales?: (imageIndex: number) => void;

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
    translateAllAltTexts?: string;
    onlyFeaturedImageAvailable?: string;
    additionalImagesLocked?: string;
    availableInBasicPlan?: string;
    altBadge?: string;
    noAltBadge?: string;
    /** Shown on a foreign alt field whose image has no main-language alt. */
    altNeedsPrimaryHint?: string;
  };
}

export function ImageGalleryField({
  images = [],
  featuredImage,
  currentLanguage,
  primaryLocale,
  isPrimaryLocale,
  isFreePlan = false,
  shopLocales = [],
  altTexts,
  altTextFallbackIndices = new Set(),
  onAltTextChange,
  onGenerateAltText,
  onGenerateAllAltTexts,
  onTranslateAllAltTexts,
  onTranslateAllAltTextsForLocale,
  altSaveFirstHint,
  translateAllAltsSaveFirstHint,
  onCopyAltText,
  onCopyAltTextToAllLocales,
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
  // Single-language shop → nothing to translate alt-texts into.
  const singleLocaleHint = useSingleLocaleHint();
  // Per-language replacement of a product's media (foreign language only; null
  // on every other content type and below the plan).
  const localized = useLocalizedMediaContext()?.state ?? null;
  // The tile (or preview) of a medium that has a replacement shows it in place
  // of the original, with the corner symbol that flips it back.
  const tileOf = (img: ImageData | undefined) =>
    localized?.active && img?.mediaId ? localized.tileOf(img.mediaId) : null;

  // Reset selected image when images change
  useEffect(() => {
    if (!images || images.length === 0) {
      setSelectedImageIndex(0);
    } else if (selectedImageIndex >= images.length) {
      setSelectedImageIndex(0);
    }
  }, [images, selectedImageIndex]);

  /**
   * A FOREIGN alt text can only be stored where the image has one in the main
   * language: Shopify offers an image's `alt` for translation only when it has
   * a primary value, so a translation typed here would be refused on save and
   * left as a draft nothing could ever store (the save bar stuck open). The
   * field is locked with the reason instead. A value already there stays
   * visible and can still be cleared.
   */
  const needsPrimaryAlt = (img: ImageData | null | undefined): boolean =>
    !isPrimaryLocale && !!img && !(img.altText || "").trim();
  const needsPrimaryHint =
    t.altNeedsPrimaryHint ||
    "Enter and save an alt text in the main language first — then it can be translated.";

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
  const previewTile = tileOf(images?.[selectedImageIndex]);
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
        className="image-gallery-container"
        style={{
          display: "flex",
          gap: "16px",
          width: "100%",
        }}
      >
        {/* Large Preview Image */}
        <div
          className="image-preview-large"
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
                src={(!isFreePlan ? previewTile?.src : null) ?? previewImage.url}
                alt={altTexts[selectedImageIndex] || previewImage.altText || t.featuredImage || "Image"}
                title={(!isFreePlan ? previewTile?.title : null) ?? extractFilename(previewImage.url)}
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
            {!isFreePlan && previewTile && (
              <ReplacedMediaBadge
                label={previewTile.label}
                draft={previewTile.draft}
                showingOriginal={previewTile.showingOriginal}
                onToggle={previewTile.onToggle}
                size={24}
                top={8}
                left={8}
              />
            )}
            {/* Alt-text status badge on preview */}
            {!isFreePlan && images && images[selectedImageIndex] && (
              <div
                title={(() => {
                  const alt = altTexts[selectedImageIndex] !== undefined
                    ? altTexts[selectedImageIndex]
                    : (isPrimaryLocale ? images[selectedImageIndex]?.altText : undefined);
                  return alt || undefined;
                })()}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  background: (altTexts[selectedImageIndex] !== undefined
                    ? altTexts[selectedImageIndex] !== ""
                    : (isPrimaryLocale && !!images[selectedImageIndex]?.altText))
                    ? "rgba(0,128,96,0.85)"
                    : "rgba(142,31,11,0.75)",
                  color: "white",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 7px",
                  borderRadius: 3,
                  lineHeight: "15px",
                }}
              >
                {(altTexts[selectedImageIndex] !== undefined
                  ? altTexts[selectedImageIndex] !== ""
                  : (isPrimaryLocale && !!images[selectedImageIndex]?.altText))
                  ? (t.altBadge || "ALT")
                  : (t.noAltBadge || "NO ALT")}
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
                const tile = tileOf(image);

                return (
                  // The replacement symbol is a SIBLING of the tile button (a
                  // button inside a button is invalid markup), positioned over it.
                  <div key={index} style={{ position: "relative", width: "100%", minWidth: "61px", maxWidth: "134px", aspectRatio: "1" }}>
                  <button
                    onClick={() => setSelectedImageIndex(index)}
                    title={tile?.title ?? extractFilename(image.url)}
                    style={{
                      position: "relative",
                      width: "100%",
                      height: "100%",
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
                      src={tile?.src ?? image.url}
                      alt={altTexts[index] || image.altText || `${t.image || "Image"} ${index + 1}`}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                    {/* Alt-text status badge */}
                    <div
                      title={(altTexts[index] !== undefined ? altTexts[index] : (isPrimaryLocale ? image.altText : undefined)) || undefined}
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        background: hasAltText ? "rgba(0,128,96,0.85)" : "rgba(142,31,11,0.75)",
                        color: "white",
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "2px 6px",
                        borderRadius: 3,
                        lineHeight: "14px",
                      }}
                    >
                      {hasAltText ? (t.altBadge || "ALT") : (t.noAltBadge || "NO ALT")}
                    </div>
                  </button>
                  {tile && (
                    <ReplacedMediaBadge label={tile.label} draft={tile.draft} showingOriginal={tile.showingOriginal} onToggle={tile.onToggle} />
                  )}
                  </div>
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
              border: "2px dashed var(--app-surface-border-color)",
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

      {/* Bulk action buttons - below images */}
      {!isFreePlan && images && images.length > 0 && (
        <InlineStack align="start" gap="200">
          {isPrimaryLocale && onGenerateAllAltTexts && images.length > 1 && (
            <Button
              size="slim"
              onClick={onGenerateAllAltTexts}
              loading={isFieldLoading ? isFieldLoading(-1) : false}
            >
              ✨ {t.generateAllAltTexts || "Generate all alt-texts"}
            </Button>
          )}
          {isPrimaryLocale && onTranslateAllAltTexts && (
            <DisabledActionTooltip hint={singleLocaleHint ?? translateAllAltsSaveFirstHint}>
              <Button
                size="slim"
                onClick={onTranslateAllAltTexts}
                loading={isFieldLoading ? isFieldLoading(-1) : false}
                disabled={!!singleLocaleHint || !!translateAllAltsSaveFirstHint}
              >
                🌍 {t.translateAllAltTexts || "Translate all alt-texts"}
              </Button>
            </DisabledActionTooltip>
          )}
          {!isPrimaryLocale && onTranslateAllAltTextsForLocale && (
            <Button
              size="slim"
              onClick={onTranslateAllAltTextsForLocale}
              loading={isFieldLoading ? isFieldLoading(-1) : false}
            >
              🌍 {t.translateAllAltTexts || "Translate all alt-texts"}
            </Button>
          )}
        </InlineStack>
      )}

      {/* Alt-text input for selected image or featured image */}
      {!isFreePlan && (images && images.length > 0 ? (
        <AIEditableField
          label={`${t.altTextForImage || "Alt-text for image"} ${selectedImageIndex + 1}`}
          value={altTexts[selectedImageIndex] !== undefined
            ? altTexts[selectedImageIndex]
            : (isPrimaryLocale ? (images[selectedImageIndex]?.altText || "") : "")}
          onChange={(value) => onAltTextChange(selectedImageIndex, value)}
          readOnly={needsPrimaryAlt(images[selectedImageIndex])}
          helpText={needsPrimaryAlt(images[selectedImageIndex]) ? needsPrimaryHint : undefined}
          sourceTextAvailable={!needsPrimaryAlt(images[selectedImageIndex])}
          fieldType={`altText_${selectedImageIndex}`}
          fieldKey={`altText_${selectedImageIndex}`}
          helpKey="altText"
          suggestion={altTextSuggestions[selectedImageIndex]}
          isPrimaryLocale={isPrimaryLocale}
          isFallbackValue={altTextFallbackIndices.has(selectedImageIndex)}
          isTranslated={isAltTextTranslated(images[selectedImageIndex], currentLanguage, primaryLocale, altTexts[selectedImageIndex])}
          hasFieldMissingTranslations={isPrimaryLocale && hasAltTextMissingTranslations(images[selectedImageIndex], shopLocales, primaryLocale, altTexts[selectedImageIndex])}
          placeholder={t.altTextPlaceholder}
          isLoading={isFieldLoading ? isFieldLoading(selectedImageIndex) : false}
          onGenerateAI={isPrimaryLocale ? (userInstruction) => onGenerateAltText(selectedImageIndex, userInstruction) : undefined}
          onCopy={!isPrimaryLocale && onCopyAltText ? () => onCopyAltText(selectedImageIndex) : undefined}
          onCopyToAllLocales={isPrimaryLocale && onCopyAltTextToAllLocales ? () => onCopyAltTextToAllLocales(selectedImageIndex) : undefined}
          onTranslate={() => onTranslateAltText(selectedImageIndex)}
          onTranslateToAllLocales={onTranslateAltTextToAllLocales ? () => onTranslateAltTextToAllLocales(selectedImageIndex) : undefined}
          saveFirstHint={altSaveFirstHint?.(selectedImageIndex)}
          onAcceptSuggestion={() => onAcceptSuggestion(selectedImageIndex)}
          onAcceptAndTranslate={onAcceptAndTranslateSuggestion ? () => onAcceptAndTranslateSuggestion(selectedImageIndex) : undefined}
          onRejectSuggestion={() => onRejectSuggestion(selectedImageIndex)}
          onClear={onClearAltText ? () => onClearAltText(selectedImageIndex) : undefined}
        />
      ) : featuredImage ? (
        <AIEditableField
          label={t.altTextForImage || "Alt-text for image"}
          value={altTexts[0] !== undefined
            ? altTexts[0]
            : (isPrimaryLocale ? (featuredImage.altText || "") : "")}
          onChange={(value) => onAltTextChange(0, value)}
          readOnly={needsPrimaryAlt(featuredImage)}
          helpText={needsPrimaryAlt(featuredImage) ? needsPrimaryHint : undefined}
          sourceTextAvailable={!needsPrimaryAlt(featuredImage)}
          fieldType="altText_0"
          fieldKey="altText_0"
          helpKey="altText"
          suggestion={altTextSuggestions[0]}
          isPrimaryLocale={isPrimaryLocale}
          isFallbackValue={altTextFallbackIndices.has(0)}
          isTranslated={isAltTextTranslated(featuredImage, currentLanguage, primaryLocale, altTexts[0])}
          hasFieldMissingTranslations={isPrimaryLocale && hasAltTextMissingTranslations(featuredImage, shopLocales, primaryLocale, altTexts[0])}
          placeholder={t.altTextPlaceholder}
          isLoading={isFieldLoading ? isFieldLoading(0) : false}
          onGenerateAI={isPrimaryLocale ? (userInstruction) => onGenerateAltText(0, userInstruction) : undefined}
          onCopy={!isPrimaryLocale && onCopyAltText ? () => onCopyAltText(0) : undefined}
          onCopyToAllLocales={isPrimaryLocale && onCopyAltTextToAllLocales ? () => onCopyAltTextToAllLocales(0) : undefined}
          onTranslate={() => onTranslateAltText(0)}
          onTranslateToAllLocales={onTranslateAltTextToAllLocales ? () => onTranslateAltTextToAllLocales(0) : undefined}
          saveFirstHint={altSaveFirstHint?.(0)}
          onAcceptSuggestion={() => onAcceptSuggestion(0)}
          onAcceptAndTranslate={onAcceptAndTranslateSuggestion ? () => onAcceptAndTranslateSuggestion(0) : undefined}
          onRejectSuggestion={() => onRejectSuggestion(0)}
          onClear={onClearAltText ? () => onClearAltText(0) : undefined}
        />
      ) : null)}

      {/* Replacement for the selected image in this foreign language: one
          button; the primary locale shows nothing of it. */}
      {!isFreePlan && localized?.active && images && images[selectedImageIndex]?.mediaId && (
        <InlineStack align="start">
          <LocalizedMediaReplaceButtons mediaId={images[selectedImageIndex].mediaId as string} />
        </InlineStack>
      )}
    </BlockStack>
  );
}

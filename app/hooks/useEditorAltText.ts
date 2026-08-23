/**
 * useEditorAltText
 *
 * Encapsulates all alt-text state and handlers extracted from useUnifiedContentEditor.
 * Includes:
 *   - Alt-text state (imageAltTexts, altTextSuggestions, originalAltTexts, etc.)
 *   - selectedImageIndex state (whether the AI may LOOK at an image is a
 *     shop-wide setting now, resolved server-side — see
 *     [vision-policy.shared.ts](../services/ai/vision-policy.shared.ts))
 *   - ALT-TEXT HANDLERS section
 *   - SEND IMAGE TO AI HANDLERS section (including reset effects)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useLatestRef } from "./useLatestRef";
import { getItemFieldValue, buildLocaleKey } from "./useUiDataLoader";
import { markOperationActive, markOperationFailed } from "./useAIOperationsStore";
import type {
  ShopLocale,
  ContentImage,
  ContentEditorConfig,
  TranslationStrings,
} from "../types/content-editor.types";
import { debugLog } from "../utils/debug";

// ---------------------------------------------------------------------------
// Prop / return types
// ---------------------------------------------------------------------------

interface UseEditorAltTextProps {
  selectedItem: any;
  selectedItemId: string | null;
  selectedItemRef: React.MutableRefObject<any>;
  selectedItemIdRef: React.MutableRefObject<string | null>;
  currentLanguage: string;
  /** Selected market ("" = global). Alt text is resolved/saved per market. */
  selectedMarketId: string;
  primaryLocale: string;
  shopLocales: ShopLocale[];
  config: ContentEditorConfig;
  enabledLanguages: string[];
  editableValues: Record<string, string>;
  editableValuesRef: React.MutableRefObject<Record<string, string>>;
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  safeSubmit: (data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void;
  savedLocaleRef: React.MutableRefObject<string | null>;
  savedMarketIdRef: React.MutableRefObject<string>;
  isSavePendingRef: React.MutableRefObject<boolean>;
  isSaveFromTranslateRef: React.MutableRefObject<boolean>;
  revalidatorRef: React.MutableRefObject<{ state: string; revalidate: () => void }>;
  submitAIAction: (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void
  ) => void;
  showInfoBox: (message: string, tone?: import("../types/content-editor.types").InfoBoxTone, title?: string) => void;
  t: TranslationStrings;
  setAiSuggestions: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

interface UseEditorAltTextReturn {
  // State
  imageAltTexts: Record<number, string>;
  /** Image indices whose alt text is a market-inherited (global) fallback. */
  fallbackAltTextIndices: Set<number>;
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  altTextSuggestions: Record<number, string>;
  setAltTextSuggestions: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  originalAltTexts: Record<number, string>;
  setOriginalAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  imageAltTextsRef: React.MutableRefObject<Record<number, string>>;
  originalAltTextsRef: React.MutableRefObject<Record<number, string>>;
  pendingAltTextAutoSaveRef: React.MutableRefObject<Record<number, string> | null>;
  selectedImageIndex: number;
  setSelectedImageIndex: React.Dispatch<React.SetStateAction<number>>;
  // Handlers
  handleAltTextChange: (imageIndex: number, value: string) => void;
  handleGenerateAltText: (imageIndex: number, userInstruction?: string) => void;
  handleGenerateAllAltTexts: () => void;
  handleAcceptAltText: (imageIndex: number) => void;
  handleRejectAltText: (imageIndex: number) => void;
  handleCopyAltText: (imageIndex: number) => void;
  handleCopyAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAllAltTexts: () => void;
  /** Ref to pending copy index so save-response handler can clear loading state */
  pendingCopyAltTextIndexRef: React.MutableRefObject<number | null>;
  handleTranslateAllAltTextsForLocale: () => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useEditorAltText(props: UseEditorAltTextProps): UseEditorAltTextReturn {
  const {
    selectedItem,
    selectedItemId,
    selectedItemRef,
    selectedItemIdRef,
    currentLanguage,
    selectedMarketId,
    primaryLocale,
    shopLocales,
    config,
    enabledLanguages,
    editableValues,
    editableValuesRef,
    buildFieldsForSave,
    safeSubmit,
    savedLocaleRef,
    savedMarketIdRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    revalidatorRef,
    submitAIAction,
    showInfoBox,
    t,
    setAiSuggestions,
  } = props;

  // ============================================================================
  // ALT-TEXT STATE
  // ============================================================================

  // Alt-text state for images (indexed by image position)
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});
  // Track original alt-texts to detect changes (using state to trigger re-renders)
  const [originalAltTexts, setOriginalAltTexts] = useState<Record<number, string>>({});
  const imageAltTextsRef = useLatestRef(imageAltTexts);
  const originalAltTextsRef = useLatestRef(originalAltTexts);

  // Track pending auto-save for alt-texts (set by bulk generation and translation effects)
  const pendingAltTextAutoSaveRef = useRef<Record<number, string> | null>(null);
  // Track image index of an in-flight copy save so save-response handler can clear loading
  const pendingCopyAltTextIndexRef = useRef<number | null>(null);
  // Per-locale overlay for copy operations — eliminates stale window on locale switch
  // structure: { locale: { imageIndex: altText } }
  const localAltTextOverlayRef = useRef<Record<string, Record<number, string>>>({});

  // Image indices whose alt text is inherited from the global value while a
  // non-global market is selected (mirrors the main fields' fallbackFields). The
  // UI greys these out. Empty in the global context.
  const [fallbackAltTextIndices, setFallbackAltTextIndices] = useState<Set<number>>(new Set());

  // Send Image to AI feature state
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // ============================================================================
  // ALT-TEXT HANDLERS
  // ============================================================================

  const handleAltTextChange = useCallback((imageIndex: number, value: string) => {
    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: value
    }));
  }, []);

  /**
   * Get image at index, falling back to featuredImage when images array is empty.
   * This supports articles which store only a featuredImage without an images array.
   */
  const getImageAtIndex = (item: any, index: number): ContentImage | null => {
    if (item?.images && item.images[index]) return item.images[index];
    if (index === 0 && item?.featuredImage) return item.featuredImage;
    return null;
  };

  /**
   * @param userInstruction Ad-hoc instruction from the AIInstructionPrompt box
   *   on the alt-text field. Undefined/empty generates exactly as before.
   */
  const handleGenerateAltText = (imageIndex: number, userInstruction?: string) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const requestItemId = selectedItem.id;
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

    submitAIAction(
      {
        action: "generateAltText",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        imageIndex: String(imageIndex),
        imageUrl: image.url,
        productTitle,
        mainLanguage,
        ...(userInstruction?.trim() && { userInstruction: userInstruction.trim() }),
      },
      `altText_${imageIndex}`,
      (result) => {
        // Guard: discard if user switched to a different item during the request.
        if (selectedItemIdRef.current !== requestItemId) return;
        if (result.altText) {
          setAltTextSuggestions((prev) => ({
            ...prev,
            [imageIndex]: result.altText as string,
          }));
        }
      }
    );
  };

  const handleGenerateAllAltTexts = () => {
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    const requestItemId = selectedItem.id;
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = allImages.map((img: ContentImage) => ({ url: img.url }));

    submitAIAction(
      {
        action: "generateAllAltTexts",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle,
        mainLanguage,
        imagesData: JSON.stringify(imagesData),
      },
      "allAltTextsGenerate",
      (result) => {
        // Guard: discard if user switched to a different item during the request.
        if (selectedItemIdRef.current !== requestItemId) return;
        if (result.generatedAltTexts) {
          const newAltTexts = {
            ...imageAltTexts,
            ...result.generatedAltTexts
          };
          setImageAltTexts(newAltTexts);
          setOriginalAltTexts(newAltTexts);
          pendingAltTextAutoSaveRef.current = newAltTexts;
        }
      }
    );
  };

  const handleCopyAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItemId) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const sourceAltText = image.altText || "";
    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden",
        "warning",
        "Warnung"
      );
      return;
    }

    const newAltTexts = { ...imageAltTexts, [imageIndex]: sourceAltText };
    setImageAltTexts(newAltTexts);
    setOriginalAltTexts(newAltTexts);

    // Write to overlay (market-folded) so switching away and back to this
    // locale/market shows the correct value immediately.
    const copyOverlayKey = buildLocaleKey(currentLanguage, selectedMarketId);
    if (!localAltTextOverlayRef.current[copyOverlayKey]) {
      localAltTextOverlayRef.current[copyOverlayKey] = {};
    }
    localAltTextOverlayRef.current[copyOverlayKey][imageIndex] = sourceAltText;

    markOperationActive(selectedItemId, `altText_${imageIndex}`, "copy");
    pendingCopyAltTextIndexRef.current = imageIndex;

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };
    if (selectedMarketId) formDataObj.marketId = selectedMarketId;
    Object.assign(formDataObj, buildFieldsForSave(editableValuesRef.current, currentLanguage));
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
    savedMarketIdRef.current = selectedMarketId;
    isSavePendingRef.current = true;
    isSaveFromTranslateRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });

    showInfoBox(t.common?.copied ?? "Copied", "success");
  };

  const handleCopyAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem || !selectedItemId) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;

    const sourceAltText = imageAltTexts[imageIndex] || image.altText || "";
    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden",
        "warning",
        "Warnung"
      );
      return;
    }

    const capturedItemId = selectedItemId;

    // Write to overlay immediately for all target locales
    for (const locale of targetLocales) {
      if (!localAltTextOverlayRef.current[locale]) {
        localAltTextOverlayRef.current[locale] = {};
      }
      localAltTextOverlayRef.current[locale][imageIndex] = sourceAltText;
    }

    markOperationActive(capturedItemId, `altText_${imageIndex}`, "copyToAllLocales");

    const saves = targetLocales.map(locale => {
      const fd = new FormData();
      fd.set("action", "updateContent");
      fd.set("itemId", capturedItemId);
      fd.set("locale", locale);
      fd.set("primaryLocale", primaryLocale);
      fd.set("imageAltTexts", JSON.stringify({ [imageIndex]: sourceAltText }));
      return fetch(window.location.pathname, { method: "POST", body: fd });
    });

    Promise.all(saves).finally(() => {
      markOperationFailed(capturedItemId, `altText_${imageIndex}`);
      if (revalidatorRef.current.state === 'idle') {
        try { revalidatorRef.current.revalidate(); } catch {}
      }
    });

    showInfoBox(t.common?.copied ?? "Copied", "success");
  };

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    const sourceAltText = image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAltText",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        imageIndex: String(imageIndex),
        sourceAltText,
        targetLocale: currentLanguage,
        primaryLocale
      },
      `altText_${imageIndex}`,
      (result) => {
        // Handle success - directly apply the translated alt-text (no suggestion box)
        if (result.translatedAltText) {
          const translatedAltText = result.translatedAltText as string;

          // Use functional update to avoid stale closure
          setImageAltTexts(prev => {
            const newAltTexts = { ...prev, [imageIndex]: translatedAltText };

            // Skip next data load to prevent revalidation from overwriting


            // Auto-save immediately
            const itemId = selectedItemRef.current?.id;
            if (itemId) {
              const formDataObj: Record<string, string> = {
                action: "updateContent",
                itemId,
                locale: currentLanguage,
                primaryLocale,
              };
              if (selectedMarketId) formDataObj.marketId = selectedMarketId;
              Object.assign(formDataObj, buildFieldsForSave(editableValuesRef.current, currentLanguage));
              formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

              savedLocaleRef.current = currentLanguage;
              savedMarketIdRef.current = selectedMarketId;
              isSavePendingRef.current = true;
              isSaveFromTranslateRef.current = true;
              safeSubmit(formDataObj, { method: "POST" });
            }

            // Update original alt-texts so hasChanges becomes false
            setOriginalAltTexts(newAltTexts);

            return newAltTexts;
          });

          // Show success toast
          showInfoBox(
            t.common?.fieldTranslatedAndSaved
              ?.replace("{fieldType}", "Alt-Text")
              || "Alt-Text translated and saved successfully",
            "success",
            t.common?.success || "Success"
          );
        }
      }
    );
  };

  const handleTranslateAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem) return;
    const image = getImageAtIndex(selectedItem, imageIndex);
    if (!image) return;

    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const sourceAltText = imageAltTexts[imageIndex] || image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAltTextToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        imageIndex: String(imageIndex),
        sourceAltText,
        targetLocales: JSON.stringify(targetLocales),
        primaryLocale
      },
      `altText_${imageIndex}`,
      (result) => {
        // Handle success - translations have been saved to Shopify and DB
        const failedLocales = (result.failedLocales as string[]) || [];
        const translatedAltTexts = result.translatedAltTexts as Record<string, string> | undefined;
        const translatedCount = translatedAltTexts ? Object.keys(translatedAltTexts).length : targetLocales.length;
        const successCount = translatedCount - failedLocales.length;

        if (failedLocales.length > 0) {
          const failedList = failedLocales.join(", ");
          showInfoBox(
            String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved. Please try again or re-sync.")
              .replace("{imageNumber}", String(imageIndex + 1))
              .replace("{failedLocales}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(t.content?.altTextTranslatedToLanguages || "Alt-text translated to {count} language(s)")
              .replace("{count}", String(successCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        // Revalidate to fetch fresh data from the database
        if (revalidatorRef.current.state === 'idle') {
          try {
            revalidatorRef.current.revalidate();
          } catch (error) {
            debugLog.revalidate(' Error during revalidation (ignored):', error);
          }
        }
      }
    );
  };

  // Translate ALL image alt-texts to ALL foreign languages (primary locale button)
  const handleTranslateAllAltTexts = () => {
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    // Collect all source alt texts
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    allImages.forEach((img: ContentImage, index: number) => {
      const altText = imageAltTexts[index] || img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsToAllLocales",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        altTextsData: JSON.stringify(altTextsData),
        targetLocales: JSON.stringify(targetLocales),
        primaryLocale
      },
      "allAltTextsTranslate",
      (result) => {
        const translatedCount = (result.translatedCount as number) || 0;
        const imageCount = (result.imageCount as number) || 0;
        const failedImages: number[] = (result.failedImages as number[]) || [];

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(t.content?.altTextTranslateAllPartialImages || "Alt-texts saved for {successCount}/{totalCount} image(s) in {languageCount} language(s). Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
              .replace("{successCount}", String(imageCount - failedImages.length))
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount))
              .replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(t.content?.altTextTranslateAllSuccess || "Alt-texts for {totalCount} image(s) translated to {languageCount} language(s)")
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        // Update UI state with translated alt texts for current language
        if (result.translatedResults && currentLanguage !== primaryLocale) {
          const translatedForCurrentLocale: Record<number, string> = {};
          const results = result.translatedResults as Record<string, Record<string, string>>;
          for (const [imgIdxStr, localeMap] of Object.entries(results)) {
            const idx = parseInt(imgIdxStr, 10);
            if (!failedImages.includes(idx) && localeMap[currentLanguage]) {
              translatedForCurrentLocale[idx] = localeMap[currentLanguage];
            }
          }
          if (Object.keys(translatedForCurrentLocale).length > 0) {
            setImageAltTexts(prev => {
              const updated = { ...prev, ...translatedForCurrentLocale };
              setOriginalAltTexts(updated);
              return updated;
            });
          }
        }
        if (revalidatorRef.current.state === 'idle') {
          try {
            revalidatorRef.current.revalidate();
          } catch (error) {
            debugLog.revalidate(' Error during revalidation (ignored):', error);
          }
        }
      }
    );
  };

  // Translate ALL image alt-texts into ONE foreign language (foreign locale button)
  const handleTranslateAllAltTextsForLocale = () => {
    const allImages: ContentImage[] = selectedItem?.images?.length > 0
      ? selectedItem.images
      : selectedItem?.featuredImage ? [selectedItem.featuredImage] : [];
    if (!selectedItem || allImages.length === 0) return;

    // Collect all source alt texts from primary locale
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    allImages.forEach((img: ContentImage, index: number) => {
      const altText = img.altText || "";
      if (altText) {
        altTextsData[index] = altText;
        hasAnyAltText = true;
      }
    });

    if (!hasAnyAltText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    submitAIAction(
      {
        action: "translateAllAltTextsForLocale",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle: selectedItem.title || "",
        altTextsData: JSON.stringify(altTextsData),
        targetLocale: currentLanguage,
        primaryLocale
      },
      `allAltTextsTranslate_${currentLanguage}`,
      (result) => {
        const failedImages: number[] = (result.failedImages as number[]) || [];

        // Only accept translations that were successfully saved to Shopify
        if (result.translatedAltTexts) {
          const translated: Record<number, string> = {};
          Object.entries(result.translatedAltTexts as Record<string, string>).forEach(([indexStr, text]) => {
            const idx = parseInt(indexStr, 10);
            if (!failedImages.includes(idx)) {
              translated[idx] = String(text);
            }
          });

          if (Object.keys(translated).length > 0) {
            setImageAltTexts(prev => {
              const updated = { ...prev, ...translated };
              setOriginalAltTexts(updated);
              return updated;
            });
            // No auto-save needed - server already saved to Shopify and DB
          }
        }

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(t.content?.altTextTranslatePartialImages || "Alt-texts partially saved. Image(s) {failedImages} could not be saved to Shopify. Please sync the product again.")
              .replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        }
      }
    );
  };

  const handleAcceptAltTextSuggestion = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    // Create the new alt-texts with the accepted suggestion
    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion
    };

    // Update the UI state
    setImageAltTexts(newAltTexts);

    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    const item = selectedItemRef.current;
    if (currentLanguage === primaryLocale) {
      if (item?.images?.[imageIndex]) {
        item.images[imageIndex].altText = suggestion;
      } else if (imageIndex === 0 && item?.featuredImage) {
        item.featuredImage.altText = suggestion;
      }
    }

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });



    // Auto-save immediately after accepting AI suggestion
    debugLog.altText('Accepting AI suggestion for image:', imageIndex, 'auto-saving...');

    // Build form data for save
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };
    if (selectedMarketId) formDataObj.marketId = selectedMarketId;

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));

    // Add the new image alt-texts
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
    savedMarketIdRef.current = selectedMarketId;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });

    // Update original alt-texts so hasChanges becomes false after save completes
    setOriginalAltTexts(newAltTexts);
  };

  const handleAcceptAndTranslateAltText = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    const item = selectedItemRef.current;
    if (!item) return;

    // Create the new alt-texts with the accepted suggestion
    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion
    };

    // Update the UI state
    setImageAltTexts(newAltTexts);

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

    // ========================================================================
    // FOREIGN LOCALE PATH
    // The accepted alt-text is in a foreign language `L`. Mirror the text-field
    // fix: keep it EXACTLY in `L`, translate it into the primary language and
    // save that as the base image alt-text (this field only, so no deletion of
    // existing foreign alt-text translations), and translate it into the OTHER
    // foreign locales (source = `L`). Do NOT overwrite the item's base altText
    // with the foreign value.
    // ========================================================================
    if (currentLanguage !== primaryLocale) {
      const L = currentLanguage;
      const requestItemId = selectedItemId;
      setOriginalAltTexts(newAltTexts);
      const targetOthers = enabledLanguages.filter(l => l !== primaryLocale && l !== L);

      // Persist the accepted foreign alt-text EXACTLY in `L`.
      const saveForeignExact = () => {
        const foreignForm: Record<string, string> = {
          action: "updateContent",
          itemId: requestItemId,
          locale: L,
          primaryLocale,
        };
        foreignForm.imageAltTexts = JSON.stringify(newAltTexts);
        savedLocaleRef.current = L;
        savedMarketIdRef.current = "";
        isSavePendingRef.current = true;
        isSaveFromTranslateRef.current = true;
        safeSubmit(foreignForm, { method: "POST" });
      };

      // Translate the accepted foreign alt-text into the primary language.
      submitAIAction(
        {
          action: "translateAltText",
          itemId: requestItemId,
          productId: item.id,
          productTitle: item.title || "",
          imageIndex: String(imageIndex),
          sourceAltText: suggestion,
          targetLocale: primaryLocale,
          // Server uses `primaryLocale` purely as the SOURCE language.
          primaryLocale: L,
        },
        `altText_${imageIndex}`,
        (result) => {
          if (selectedItemIdRef.current !== requestItemId) return;
          const primaryTranslated = ((result.translatedAltText as string) || "").trim();

          // 1. Save the accepted foreign alt-text exactly in `L`.
          saveForeignExact();

          // 2. Save the primary base alt-text (this image only, no deletion trigger).
          if (primaryTranslated) {
            const primaryForm: Record<string, string> = {
              action: "updateContent",
              itemId: requestItemId,
              locale: primaryLocale,
              primaryLocale,
            };
            primaryForm.imageAltTexts = JSON.stringify({ [imageIndex]: primaryTranslated });
            // Products reject a primary-locale update without a non-empty title.
            if (config.contentType === "products") {
              primaryForm.title = getItemFieldValue(item, "title", primaryLocale, config);
            }
            // Do NOT set savedLocaleRef to primaryLocale. Save A (locale L) was
            // submitted immediately and this save is queued behind it; the
            // save-response effect reads the single shared savedLocaleRef, and
            // overwriting it to primary would both misprocess save A and write
            // the FOREIGN alt-text (held in imageAltTextsRef) into the primary
            // in-memory image (a leak). The server still persists this as the
            // primary base alt-text via the form `locale` field.
            isSavePendingRef.current = true;
            isSaveFromTranslateRef.current = true;
            safeSubmit(primaryForm, { method: "POST" });
          }

          // 3. Translate into the OTHER foreign locales directly from `L`.
          if (targetOthers.length > 0) {
            submitAIAction(
              {
                action: "translateAltTextToAllLocales",
                itemId: requestItemId,
                productId: item.id,
                productTitle: item.title || "",
                imageIndex: String(imageIndex),
                sourceAltText: suggestion,
                targetLocales: JSON.stringify(targetOthers),
                primaryLocale: L,
              },
              `altText_${imageIndex}`,
              () => {
                if (revalidatorRef.current.state === 'idle') {
                  try { revalidatorRef.current.revalidate(); } catch {}
                }
              }
            );
          }
        },
        () => {
          // Translating into the primary language failed — still keep the
          // accepted foreign alt-text saved.
          if (selectedItemIdRef.current !== requestItemId) return;
          saveForeignExact();
        }
      );
      return;
    }

    // ========================================================================
    // PRIMARY LOCALE PATH (unchanged)
    // ========================================================================
    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    if (item.images?.[imageIndex]) {
      item.images[imageIndex].altText = suggestion;
    }

    // Check target locales first
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesEnabled || "No target languages enabled",
        "warning",
        t.common?.warning || "Warning"
      );
      // No translations needed, just save the primary text directly

      const formDataObj: Record<string, string> = {
        action: "updateContent",
        itemId: selectedItemId,
        locale: primaryLocale,
        primaryLocale,
      };
      Object.assign(formDataObj, buildFieldsForSave(editableValues, primaryLocale));
      formDataObj.imageAltTexts = JSON.stringify(newAltTexts);
      savedLocaleRef.current = primaryLocale;
      savedMarketIdRef.current = "";
      isSavePendingRef.current = true;
      safeSubmit(formDataObj, { method: "POST" });
      setOriginalAltTexts(newAltTexts);
      return;
    }



    debugLog.altText('Saving primary alt-text first, then will translate to all locales');

    // Step 1: Save the primary alt-text first
    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: primaryLocale,
      primaryLocale,
    };
    Object.assign(formDataObj, buildFieldsForSave(editableValues, primaryLocale));
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);
    savedLocaleRef.current = primaryLocale;
    savedMarketIdRef.current = "";
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });
    setOriginalAltTexts(newAltTexts);

    // Step 2: Translate to all locales
    safeSubmit({
      action: "translateAltTextToAllLocales",
      productId: item.id,
      imageIndex: String(imageIndex),
      sourceAltText: suggestion,
      targetLocales: JSON.stringify(targetLocales)
    }, { method: "POST" });
  };

  const handleRejectAltTextSuggestion = useCallback((imageIndex: number) => {
    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });
  }, []);

  // Reset alt-text and AI suggestion state when selected item changes
  useEffect(() => {
    setImageAltTexts({});
    setAltTextSuggestions({});
    setOriginalAltTexts({});
    setAiSuggestions({});
    localAltTextOverlayRef.current = {};
  }, [selectedItemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load translated alt-texts when language changes
  useEffect(() => {
    const item = selectedItemRef.current;
    if (!item) return;

    const allImages: ContentImage[] = item.images?.length > 0
      ? item.images
      : item.featuredImage ? [item.featuredImage] : [];
    if (allImages.length === 0) return;

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale alt-texts - fallback will use images[i].altText
      setImageAltTexts({});
      setOriginalAltTexts({});
      setFallbackAltTextIndices(new Set());
    } else {
      // Load translated alt-texts. When a market is selected, prefer the
      // market-specific value (overlay then DB); if absent, fall back to the
      // global value — mirroring the storefront + the main resolve() chain. When
      // no market is selected, this reduces to the original global-only lookup.
      const translatedAltTexts: Record<number, string> = {};
      // Indices showing a market-inherited (global) value — greyed out in the UI.
      const fallbackIndices = new Set<number>();
      const marketOverlay = selectedMarketId
        ? (localAltTextOverlayRef.current[buildLocaleKey(currentLanguage, selectedMarketId)] || {})
        : {};
      const globalOverlay = localAltTextOverlayRef.current[currentLanguage] || {};
      allImages.forEach((img: ContentImage, index: number) => {
        // 1. Market layer (overlay → DB)
        if (selectedMarketId) {
          if (marketOverlay[index] !== undefined) {
            translatedAltTexts[index] = marketOverlay[index];
            return;
          }
          const marketDb = img.altTextTranslations?.find(
            (t) => t.locale === currentLanguage && (t.marketId ?? "") === selectedMarketId
          );
          if (marketDb) {
            translatedAltTexts[index] = marketDb.altText;
            return;
          }
        }
        // 2. Global layer (overlay → DB). With a market selected this value is
        //    inherited from global → flag it as a fallback so the UI greys it.
        let globalVal: string | undefined;
        if (globalOverlay[index] !== undefined) {
          globalVal = globalOverlay[index];
        } else {
          const globalDb = img.altTextTranslations?.find(
            (t) => t.locale === currentLanguage && (t.marketId ?? "") === ""
          );
          if (globalDb) globalVal = globalDb.altText;
        }
        if (globalVal !== undefined) {
          translatedAltTexts[index] = globalVal;
          if (selectedMarketId && globalVal.trim() !== "") fallbackIndices.add(index);
        }
      });
      setImageAltTexts(translatedAltTexts);
      setOriginalAltTexts({ ...translatedAltTexts });
      setFallbackAltTextIndices(fallbackIndices);
    }
  }, [currentLanguage, selectedMarketId, selectedItemId, primaryLocale]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // State
    imageAltTexts,
    setImageAltTexts,
    fallbackAltTextIndices,
    altTextSuggestions,
    setAltTextSuggestions,
    originalAltTexts,
    setOriginalAltTexts,
    imageAltTextsRef,
    originalAltTextsRef,
    pendingAltTextAutoSaveRef,
    selectedImageIndex,
    setSelectedImageIndex,
    // Handlers
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleAcceptAltText: handleAcceptAltTextSuggestion,
    handleRejectAltText: handleRejectAltTextSuggestion,
    handleCopyAltText,
    handleCopyAltTextToAllLocales,
    pendingCopyAltTextIndexRef,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
  };
}

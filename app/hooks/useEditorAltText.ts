/**
 * useEditorAltText
 *
 * Encapsulates all alt-text state and handlers extracted from useUnifiedContentEditor.
 * Includes:
 *   - Alt-text state (imageAltTexts, altTextSuggestions, originalAltTexts, etc.)
 *   - sendImageToAI / selectedImageIndex state
 *   - ALT-TEXT HANDLERS section
 *   - SEND IMAGE TO AI HANDLERS section (including reset effects)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useLatestRef } from "./useLatestRef";
import { getItemFieldValue } from "./useUiDataLoader";
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
  primaryLocale: string;
  shopLocales: ShopLocale[];
  config: ContentEditorConfig;
  enabledLanguages: string[];
  editableValues: Record<string, string>;
  editableValuesRef: React.MutableRefObject<Record<string, string>>;
  buildFieldsForSave: (values: Record<string, string>, locale: string) => Record<string, string>;
  safeSubmit: (data: Record<string, any>, options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }) => void;
  savedLocaleRef: React.MutableRefObject<string | null>;
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
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  altTextSuggestions: Record<number, string>;
  setAltTextSuggestions: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  originalAltTexts: Record<number, string>;
  setOriginalAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  imageAltTextsRef: React.MutableRefObject<Record<number, string>>;
  originalAltTextsRef: React.MutableRefObject<Record<number, string>>;
  pendingAltTextAutoSaveRef: React.MutableRefObject<Record<number, string> | null>;
  sendImageToAI: boolean;
  setSendImageToAI: React.Dispatch<React.SetStateAction<boolean>>;
  selectedImageIndex: number;
  setSelectedImageIndex: React.Dispatch<React.SetStateAction<number>>;
  // Handlers
  handleAltTextChange: (imageIndex: number, value: string) => void;
  handleGenerateAltText: (imageIndex: number) => void;
  handleGenerateAllAltTexts: () => void;
  handleAcceptAltText: (imageIndex: number) => void;
  handleRejectAltText: (imageIndex: number) => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAllAltTexts: () => void;
  handleTranslateAllAltTextsForLocale: () => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
  handleToggleSendImageToAI: () => void;
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
    primaryLocale,
    shopLocales,
    config,
    enabledLanguages,
    editableValues,
    editableValuesRef,
    buildFieldsForSave,
    safeSubmit,
    savedLocaleRef,
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

  // Send Image to AI feature state
  const [sendImageToAI, setSendImageToAI] = useState(false);
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

  const handleGenerateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const requestItemId = selectedItem.id;
    const image = selectedItem.images[imageIndex];
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
        sendImageToAI: sendImageToAI.toString(),
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
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const requestItemId = selectedItem.id;
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale, config);
    const mainLanguage = shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
    const imagesData = selectedItem.images.map((img: ContentImage) => ({ url: img.url }));

    submitAIAction(
      {
        action: "generateAllAltTexts",
        itemId: selectedItem.id,
        productId: selectedItem.id,
        productTitle,
        mainLanguage,
        imagesData: JSON.stringify(imagesData),
        sendImageToAI: sendImageToAI.toString(),
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

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const image = selectedItem.images[imageIndex];
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
              Object.assign(formDataObj, buildFieldsForSave(editableValuesRef.current, currentLanguage));
              formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

              savedLocaleRef.current = currentLanguage;
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
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

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

    const image = selectedItem.images[imageIndex];
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
            String(t.content?.altTextPartialLocales || "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved to Shopify. Please sync the product again.")
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
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

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
    selectedItem.images.forEach((img: ContentImage, index: number) => {
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
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    // Collect all source alt texts from primary locale
    const altTextsData: Record<number, string> = {};
    let hasAnyAltText = false;
    selectedItem.images.forEach((img: ContentImage, index: number) => {
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
    if (item?.images?.[imageIndex] && currentLanguage === primaryLocale) {
      item.images[imageIndex].altText = suggestion;
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

    // Add field values - for foreign locales, only send fields that actually changed
    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));

    // Add the new image alt-texts
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
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

    // Immediately update the in-memory item so the fallback display
    // (images[index]?.altText) shows the correct value even if imageAltTexts
    // state gets cleared during revalidation cycles.
    if (item.images?.[imageIndex]) {
      item.images[imageIndex].altText = suggestion;
    }

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

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

  // ============================================================================
  // SEND IMAGE TO AI HANDLERS
  // ============================================================================

  const handleToggleSendImageToAI = useCallback(() => {
    setSendImageToAI(prev => !prev);
  }, []);

  // Reset alt-text and AI suggestion state when selected item changes
  useEffect(() => {
    setImageAltTexts({});
    setAltTextSuggestions({});
    setOriginalAltTexts({});
    setAiSuggestions({});
  }, [selectedItemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load translated alt-texts when language changes
  useEffect(() => {
    const item = selectedItemRef.current;
    if (!item || !item.images) return;

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale alt-texts - fallback will use images[i].altText
      setImageAltTexts({});
      setOriginalAltTexts({});
    } else {
      // Load translated alt-texts from DB
      const translatedAltTexts: Record<number, string> = {};
      item.images.forEach((img: ContentImage, index: number) => {
        const translation = img.altTextTranslations?.find(
          (t: { locale: string }) => t.locale === currentLanguage
        );
        if (translation) {
          translatedAltTexts[index] = translation.altText;
        }
      });
      setImageAltTexts(translatedAltTexts);
      setOriginalAltTexts({ ...translatedAltTexts });
    }
  }, [currentLanguage, selectedItemId, primaryLocale]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // State
    imageAltTexts,
    setImageAltTexts,
    altTextSuggestions,
    setAltTextSuggestions,
    originalAltTexts,
    setOriginalAltTexts,
    imageAltTextsRef,
    originalAltTextsRef,
    pendingAltTextAutoSaveRef,
    sendImageToAI,
    setSendImageToAI,
    selectedImageIndex,
    setSelectedImageIndex,
    // Handlers
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleAcceptAltText: handleAcceptAltTextSuggestion,
    handleRejectAltText: handleRejectAltTextSuggestion,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
    handleToggleSendImageToAI,
  };
}

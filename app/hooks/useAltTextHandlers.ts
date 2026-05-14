/**
 * Alt-Text Handlers Hook
 *
 * Extracted from useUnifiedContentEditor.ts — all image alt-text related handlers.
 * Handles: generate, generate-all, translate, translate-to-all-locales,
 *          translate-all, translate-all-for-locale, accept, accept-and-translate, reject.
 */

import { useCallback } from "react";
import type {
  TranslatableContentItem,
  ContentImage,
  ShopLocale,
  ContentEditorConfig,
  TranslationStrings,
  InfoBoxTone,
} from "../types/content-editor.types";
import { getItemFieldValue } from "./useUiDataLoader";
import { debugLog } from "../utils/debug";

// ============================================================================
// TYPES
// ============================================================================

export interface AltTextHandlerProps {
  // Config / locale
  primaryLocale: string;
  currentLanguage: string;
  enabledLanguages: string[];
  config: ContentEditorConfig;
  shopLocales: ShopLocale[];
  t: TranslationStrings;

  // State values
  selectedItemId: string | null;
  selectedItem: TranslatableContentItem | undefined;
  imageAltTexts: Record<number, string>;
  altTextSuggestions: Record<number, string>;
  editableValues: Record<string, string>;
  sendImageToAI: boolean;

  // Refs (MutableRefObject-compatible: just { current: T })
  selectedItemRef: { current: TranslatableContentItem | undefined };
  selectedItemIdRef: { current: string | null };
  editableValuesRef: { current: Record<string, string> };
  revalidatorRef: { current: { state: string; revalidate: () => void } };
  savedLocaleRef: { current: string | null };
  isSavePendingRef: { current: boolean };
  isSaveFromTranslateRef: { current: boolean };
  pendingAltTextAutoSaveRef: { current: Record<number, string> | null };

  // Functions
  submitAIAction: (
    data: Record<string, string>,
    fieldKey: string,
    onSuccess?: (result: Record<string, unknown>) => void,
    onError?: (error: string) => void
  ) => Promise<void>;
  safeSubmit: (
    data: Record<string, any>,
    options?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }
  ) => void;
  buildFieldsForSave: (
    values: Record<string, string>,
    locale: string
  ) => Record<string, string>;
  showInfoBox: (message: string, tone: InfoBoxTone, title?: string) => void;

  // State setters
  setImageAltTexts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setAltTextSuggestions: React.Dispatch<
    React.SetStateAction<Record<number, string>>
  >;
  setOriginalAltTexts: React.Dispatch<
    React.SetStateAction<Record<number, string>>
  >;
}

export interface AltTextHandlers {
  handleAltTextChange: (imageIndex: number, value: string) => void;
  handleGenerateAltText: (imageIndex: number) => void;
  handleGenerateAllAltTexts: () => void;
  handleTranslateAltText: (imageIndex: number) => void;
  handleTranslateAltTextToAllLocales: (imageIndex: number) => void;
  handleTranslateAllAltTexts: () => void;
  handleTranslateAllAltTextsForLocale: () => void;
  handleAcceptAltTextSuggestion: (imageIndex: number) => void;
  handleAcceptAndTranslateAltText: (imageIndex: number) => void;
  handleRejectAltTextSuggestion: (imageIndex: number) => void;
}

// ============================================================================
// HOOK
// ============================================================================

export function useAltTextHandlers(props: AltTextHandlerProps): AltTextHandlers {
  const {
    primaryLocale,
    currentLanguage,
    enabledLanguages,
    config,
    shopLocales,
    t,
    selectedItemId,
    selectedItem,
    imageAltTexts,
    altTextSuggestions,
    editableValues,
    sendImageToAI,
    selectedItemRef,
    selectedItemIdRef,
    editableValuesRef,
    revalidatorRef,
    savedLocaleRef,
    isSavePendingRef,
    isSaveFromTranslateRef,
    pendingAltTextAutoSaveRef,
    submitAIAction,
    safeSubmit,
    buildFieldsForSave,
    showInfoBox,
    setImageAltTexts,
    setAltTextSuggestions,
    setOriginalAltTexts,
  } = props;

  // --------------------------------------------------------------------------

  const handleAltTextChange = useCallback((imageIndex: number, value: string) => {
    setImageAltTexts((prev) => ({
      ...prev,
      [imageIndex]: value,
    }));
  }, [setImageAltTexts]);

  // --------------------------------------------------------------------------

  const handleGenerateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const requestItemId = selectedItem.id;
    const image = selectedItem.images[imageIndex];
    const productTitle = getItemFieldValue(selectedItem, "title", primaryLocale, config);
    const mainLanguage =
      shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;

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

  // --------------------------------------------------------------------------

  const handleGenerateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const requestItemId = selectedItem.id;
    const productTitle = getItemFieldValue(selectedItem, "title", primaryLocale, config);
    const mainLanguage =
      shopLocales.find((l: ShopLocale) => l.locale === primaryLocale)?.name || primaryLocale;
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
        if (selectedItemIdRef.current !== requestItemId) return;
        if (result.generatedAltTexts) {
          const newAltTexts = {
            ...imageAltTexts,
            ...(result.generatedAltTexts as Record<number, string>),
          };
          setImageAltTexts(newAltTexts);
          setOriginalAltTexts(newAltTexts);
          pendingAltTextAutoSaveRef.current = newAltTexts;
        }
      }
    );
  };

  // --------------------------------------------------------------------------

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const image = selectedItem.images[imageIndex];
    const sourceAltText = image.altText || "";

    if (!sourceAltText) {
      showInfoBox(
        t.content?.noSourceText ||
          "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
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
        primaryLocale,
      },
      `altText_${imageIndex}`,
      (result) => {
        if (result.translatedAltText) {
          const translatedAltText = result.translatedAltText as string;

          setImageAltTexts((prev) => {
            const newAltTexts = { ...prev, [imageIndex]: translatedAltText };

            const itemId = selectedItemRef.current?.id;
            if (itemId) {
              const formDataObj: Record<string, string> = {
                action: "updateContent",
                itemId,
                locale: currentLanguage,
                primaryLocale,
              };
              Object.assign(
                formDataObj,
                buildFieldsForSave(editableValuesRef.current, currentLanguage)
              );
              formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

              savedLocaleRef.current = currentLanguage;
              isSavePendingRef.current = true;
              isSaveFromTranslateRef.current = true;
              safeSubmit(formDataObj, { method: "POST" });
            }

            setOriginalAltTexts(newAltTexts);
            return newAltTexts;
          });

          showInfoBox(
            t.common?.fieldTranslatedAndSaved?.replace("{fieldType}", "Alt-Text") ||
              "Alt-Text translated and saved successfully",
            "success",
            t.common?.success || "Success"
          );
        }
      }
    );
  };

  // --------------------------------------------------------------------------

  const handleTranslateAltTextToAllLocales = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const targetLocales = enabledLanguages.filter((l) => l !== primaryLocale);
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
        t.content?.noSourceText ||
          "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
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
        primaryLocale,
      },
      `altText_${imageIndex}`,
      (result) => {
        const failedLocales = (result.failedLocales as string[]) || [];
        const translatedAltTexts = result.translatedAltTexts as
          | Record<string, string>
          | undefined;
        const translatedCount = translatedAltTexts
          ? Object.keys(translatedAltTexts).length
          : targetLocales.length;
        const successCount = translatedCount - failedLocales.length;

        if (failedLocales.length > 0) {
          const failedList = failedLocales.join(", ");
          showInfoBox(
            String(
              t.content?.altTextPartialLocales ||
                "Alt-text for image {imageNumber} partially translated. Language(s) {failedLocales} could not be saved. Please try again or re-sync."
            )
              .replace("{imageNumber}", String(imageIndex + 1))
              .replace("{failedLocales}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(
              t.content?.altTextTranslatedToLanguages ||
                "Alt-text translated to {count} language(s)"
            ).replace("{count}", String(successCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        if (revalidatorRef.current.state === "idle") {
          try {
            revalidatorRef.current.revalidate();
          } catch (error) {
            debugLog.revalidate(" Error during revalidation (ignored):", error);
          }
        }
      }
    );
  };

  // --------------------------------------------------------------------------

  const handleTranslateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const targetLocales = enabledLanguages.filter((l) => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesSelected || "No target languages selected",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

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
        t.content?.noSourceText ||
          "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
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
        primaryLocale,
      },
      "allAltTextsTranslate",
      (result) => {
        const translatedCount = (result.translatedCount as number) || 0;
        const imageCount = (result.imageCount as number) || 0;
        const failedImages: number[] = (result.failedImages as number[]) || [];

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(
              t.content?.altTextTranslateAllPartialImages ||
                "Alt-texts saved for {successCount}/{totalCount} image(s) in {languageCount} language(s). Image(s) {failedImages} could not be saved to Shopify. Please sync the product again."
            )
              .replace("{successCount}", String(imageCount - failedImages.length))
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount))
              .replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        } else {
          showInfoBox(
            String(
              t.content?.altTextTranslateAllSuccess ||
                "Alt-texts for {totalCount} image(s) translated to {languageCount} language(s)"
            )
              .replace("{totalCount}", String(imageCount))
              .replace("{languageCount}", String(translatedCount)),
            "success",
            t.common?.success || "Success"
          );
        }

        if (result.translatedResults && currentLanguage !== primaryLocale) {
          const translatedForCurrentLocale: Record<number, string> = {};
          const results = result.translatedResults as Record<
            string,
            Record<string, string>
          >;
          for (const [imgIdxStr, localeMap] of Object.entries(results)) {
            const idx = parseInt(imgIdxStr, 10);
            if (!failedImages.includes(idx) && localeMap[currentLanguage]) {
              translatedForCurrentLocale[idx] = localeMap[currentLanguage];
            }
          }
          if (Object.keys(translatedForCurrentLocale).length > 0) {
            setImageAltTexts((prev) => {
              const updated = { ...prev, ...translatedForCurrentLocale };
              setOriginalAltTexts(updated);
              return updated;
            });
          }
        }

        if (revalidatorRef.current.state === "idle") {
          try {
            revalidatorRef.current.revalidate();
          } catch (error) {
            debugLog.revalidate(" Error during revalidation (ignored):", error);
          }
        }
      }
    );
  };

  // --------------------------------------------------------------------------

  const handleTranslateAllAltTextsForLocale = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

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
        t.content?.noSourceText ||
          "Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen",
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
        primaryLocale,
      },
      `allAltTextsTranslate_${currentLanguage}`,
      (result) => {
        const failedImages: number[] = (result.failedImages as number[]) || [];

        if (result.translatedAltTexts) {
          const translated: Record<number, string> = {};
          Object.entries(result.translatedAltTexts as Record<string, string>).forEach(
            ([indexStr, text]) => {
              const idx = parseInt(indexStr, 10);
              if (!failedImages.includes(idx)) {
                translated[idx] = String(text);
              }
            }
          );

          if (Object.keys(translated).length > 0) {
            setImageAltTexts((prev) => {
              const updated = { ...prev, ...translated };
              setOriginalAltTexts(updated);
              return updated;
            });
          }
        }

        if (failedImages.length > 0) {
          const failedList = failedImages.map((i: number) => i + 1).join(", ");
          showInfoBox(
            String(
              t.content?.altTextTranslatePartialImages ||
                "Alt-texts partially saved. Image(s) {failedImages} could not be saved to Shopify. Please sync the product again."
            ).replace("{failedImages}", failedList),
            "warning",
            t.common?.warning || "Warning"
          );
        }
      }
    );
  };

  // --------------------------------------------------------------------------

  const handleAcceptAltTextSuggestion = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion,
    };

    setImageAltTexts(newAltTexts);

    const item = selectedItemRef.current;
    if (item?.images?.[imageIndex] && currentLanguage === primaryLocale) {
      item.images[imageIndex].altText = suggestion;
    }

    setAltTextSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

    debugLog.altText("Accepting AI suggestion for image:", imageIndex, "auto-saving...");

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    Object.assign(formDataObj, buildFieldsForSave(editableValues, currentLanguage));
    formDataObj.imageAltTexts = JSON.stringify(newAltTexts);

    savedLocaleRef.current = currentLanguage;
    isSavePendingRef.current = true;
    safeSubmit(formDataObj, { method: "POST" });

    setOriginalAltTexts(newAltTexts);
  };

  // --------------------------------------------------------------------------

  const handleAcceptAndTranslateAltText = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion || !selectedItemId) return;

    const item = selectedItemRef.current;
    if (!item) return;

    const newAltTexts = {
      ...imageAltTexts,
      [imageIndex]: suggestion,
    };

    setImageAltTexts(newAltTexts);

    if (item.images?.[imageIndex]) {
      item.images[imageIndex].altText = suggestion;
    }

    setAltTextSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });

    const targetLocales = enabledLanguages.filter((l) => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox(
        t.common?.noTargetLanguagesEnabled || "No target languages enabled",
        "warning",
        t.common?.warning || "Warning"
      );
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

    debugLog.altText("Saving primary alt-text first, then will translate to all locales");

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

    safeSubmit(
      {
        action: "translateAltTextToAllLocales",
        productId: item.id,
        imageIndex: String(imageIndex),
        sourceAltText: suggestion,
        targetLocales: JSON.stringify(targetLocales),
      },
      { method: "POST" }
    );
  };

  // --------------------------------------------------------------------------

  const handleRejectAltTextSuggestion = useCallback(
    (imageIndex: number) => {
      setAltTextSuggestions((prev) => {
        const newSuggestions = { ...prev };
        delete newSuggestions[imageIndex];
        return newSuggestions;
      });
    },
    [setAltTextSuggestions]
  );

  // --------------------------------------------------------------------------

  return {
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleTranslateAltText,
    handleTranslateAltTextToAllLocales,
    handleTranslateAllAltTexts,
    handleTranslateAllAltTextsForLocale,
    handleAcceptAltTextSuggestion,
    handleAcceptAndTranslateAltText,
    handleRejectAltTextSuggestion,
  };
}

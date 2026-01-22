/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useRevalidator } from "@remix-run/react";
import { useNavigationGuard, useChangeTracking, getTranslatedValue } from "../utils/contentEditor.utils";
import type {
  UseContentEditorProps,
  UseContentEditorReturn,
  EditorState,
  EditorHandlers,
} from "../types/content-editor.types";

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t } = props;
  const revalidator = useRevalidator();

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, 'html' | 'rendered'>>({});
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(
    shopLocales.map((l: any) => l.locale)
  );
  // Track if we're in the middle of an accept-and-translate flow to prevent immediate deletion
  const [isAcceptAndTranslateFlow, setIsAcceptAndTranslateFlow] = useState(false);
  // Track if we're currently loading data to prevent false change detection
  // Initialize to true if an item is selected to prevent race condition
  const [isLoadingData, setIsLoadingData] = useState(!!selectedItemId);
  // Track if clear all confirmation modal is open
  const [isClearAllModalOpen, setIsClearAllModalOpen] = useState(false);

  // Alt-text state for images (indexed by image position)
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  const [altTextSuggestions, setAltTextSuggestions] = useState<Record<number, string>>({});

  const selectedItem = items.find((item) => item.id === selectedItemId);

  // Navigation guard
  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  // Change tracking - only track changes if we're not currently loading data
  const hasChanges = useChangeTracking(
    isLoadingData ? null : (selectedItem || null), // Pass null while loading to prevent false change detection
    currentLanguage,
    primaryLocale,
    editableValues as any, // TODO: Fix type mismatch
    config.contentType
  );

  // DEBUG: Log whenever hasChanges or isLoadingData changes
  useEffect(() => {
    console.log('[DEBUG useUnifiedContentEditor]', {
      hasChanges,
      isLoadingData,
      hasSelectedItem: !!selectedItem,
      selectedItemId,
      editableValuesKeys: Object.keys(editableValues),
      editableValues
    });
  }, [hasChanges, isLoadingData, selectedItem, selectedItemId, editableValues]);

  // ============================================================================
  // LOAD ITEM DATA (when item or language changes)
  // ============================================================================

  // Track previous selectedItemId to detect actual item changes vs revalidation
  const prevSelectedItemIdRef = useRef<string | null>(null);
  const prevCurrentLanguageRef = useRef<string>(currentLanguage);

  useEffect(() => {
    if (!selectedItem) {
      setIsLoadingData(false);
      return;
    }

    // Check if we should skip this data load (after save/clear operations)
    if (skipNextDataLoadRef.current) {
      console.log('[DATA-LOAD] Skipping - skipNextDataLoadRef is true');
      skipNextDataLoadRef.current = false;
      setIsLoadingData(false);
      return;
    }

    // Only reload data if:
    // 1. The item ID actually changed (user selected a different item)
    // 2. The language changed (user switched languages)
    // Do NOT reload if only selectedItem object reference changed (from revalidation)
    const itemIdChanged = prevSelectedItemIdRef.current !== selectedItemId;
    const languageChanged = prevCurrentLanguageRef.current !== currentLanguage;

    if (!itemIdChanged && !languageChanged) {
      console.log('[DATA-LOAD] Skipping - neither itemId nor language changed (revalidation only)');
      setIsLoadingData(false);
      return;
    }

    // Update refs
    prevSelectedItemIdRef.current = selectedItemId;
    prevCurrentLanguageRef.current = currentLanguage;

    console.log('[DATA-LOAD] Loading data for item:', selectedItemId, 'language:', currentLanguage);

    // Mark as loading immediately
    setIsLoadingData(true);

    // Reset accept-and-translate flag when changing items or languages
    setIsAcceptAndTranslateFlow(false);

    const newValues: Record<string, string> = {};

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      config.fieldDefinitions.forEach((field) => {
        newValues[field.key] = getItemFieldValue(selectedItem, field.key, primaryLocale);
      });
    } else {
      // Load translated values
      config.fieldDefinitions.forEach((field) => {
        const translatedValue = getTranslatedValue(
          selectedItem,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );
        newValues[field.key] = translatedValue;
      });
    }

    setEditableValues(newValues);
  }, [selectedItemId, currentLanguage, selectedItem, config.fieldDefinitions, primaryLocale]);

  // Mark loading as complete after editableValues have been updated
  // This is in a separate useEffect to ensure the state update has completed
  useEffect(() => {
    if (selectedItem && isLoadingData) {
      // Use setTimeout to ensure this runs after the render cycle
      const timer = setTimeout(() => {
        setIsLoadingData(false);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [editableValues, selectedItem, isLoadingData]);

  // ============================================================================
  // AUTO-SAVE FUNCTION (defined early for use in response handlers)
  // ============================================================================

  // Helper function to get which fields have changed compared to the original item
  const getChangedFields = useCallback((valuesToCheck: Record<string, string>): string[] => {
    if (!selectedItem) return [];

    const changedFields: string[] = [];
    config.fieldDefinitions.forEach((field) => {
      const currentValue = valuesToCheck[field.key] || "";
      const originalValue = getItemFieldValue(selectedItem, field.key, primaryLocale);

      if (currentValue !== originalValue) {
        changedFields.push(field.key);
      }
    });

    return changedFields;
  }, [selectedItem, config.fieldDefinitions, primaryLocale]);

  // Internal save function that saves with specific values (for auto-save after AI acceptance/translation)
  const performAutoSave = useCallback((valuesToSave: Record<string, string>, locale: string) => {
    if (!selectedItemId) return;

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: locale,
      primaryLocale,
    };

    // Add all field values from the provided values
    config.fieldDefinitions.forEach((field) => {
      formDataObj[field.key] = valuesToSave[field.key] || "";
    });

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
    }

    // If saving primary locale, include changed fields for translation deletion
    if (locale === primaryLocale && selectedItem) {
      const changedFields = getChangedFields(valuesToSave);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
        console.log('[AUTO-SAVE] Changed fields (translations will be deleted):', changedFields);

        // Also clear translations locally for immediate UI update
        changedFields.forEach((fieldKey) => {
          const field = config.fieldDefinitions.find(f => f.key === fieldKey);
          if (field?.translationKey && selectedItem.translations) {
            selectedItem.translations = selectedItem.translations.filter(
              (t: any) => t.key !== field.translationKey
            );
          }
        });
      }
    }

    console.log('[AUTO-SAVE] Saving with values:', valuesToSave, 'locale:', locale);
    savedLocaleRef.current = locale; // Track which locale we're saving
    fetcher.submit(formDataObj, { method: "POST" });
    clearPendingNavigation();
  }, [selectedItemId, primaryLocale, config.fieldDefinitions, imageAltTexts, fetcher, clearPendingNavigation, getChangedFields, selectedItem]);

  // ============================================================================
  // FETCHER RESPONSE HANDLERS (based on products implementation)
  // ============================================================================

  // Handle AI generation response
  useEffect(() => {
    if (fetcher.data?.success && 'generatedContent' in fetcher.data) {
      const fieldType = (fetcher.data as any).fieldType;
      setAiSuggestions((prev) => ({
        ...prev,
        [fieldType]: (fetcher.data as any).generatedContent,
      }));
    }
  }, [fetcher.data]);

  // Ref to track pending translation AFTER save completes (for Accept & Translate flow)
  // This ensures: 1. Save primary text first, 2. Then translate
  const pendingTranslationAfterSaveRef = useRef<{
    fieldKey: string;
    sourceText: string;
    targetLocales: string[];
    contextTitle: string;
    itemId: string;
  } | null>(null);

  // Ref to track which fetcher responses have been processed (prevents duplicate processing)
  const processedResponseRef = useRef<string | null>(null);

  // Ref to track the last fetcher.data object (to detect actual data changes vs dependency re-runs)
  const lastFetcherDataRef = useRef<any>(null);

  // Ref to track the locale that was active when the save was initiated
  const savedLocaleRef = useRef<string | null>(null);

  // Ref to skip the next data load (prevents overwriting after save/clear operations)
  const skipNextDataLoadRef = useRef(false);

  // Ref to store current editableValues for use in effects without causing loops
  const editableValuesRef = useRef(editableValues);
  useEffect(() => {
    editableValuesRef.current = editableValues;
  }, [editableValues]);

  // Handle translated field response (single field translation)
  // Auto-save immediately after receiving translation
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data) {
      const { fieldType, translatedValue, targetLocale } = fetcher.data as any;

      // Build new values with the translation (using ref to avoid dependency)
      const newValues: Record<string, string> = {
        ...editableValuesRef.current,
        [fieldType]: translatedValue,
      };

      // Update UI
      setEditableValues(newValues);

      // Auto-save the translation immediately
      console.log('[AUTO-SAVE] Saving translation for locale:', targetLocale);

      // Build form data directly here to avoid dependency issues
      if (selectedItemId) {
        const formDataObj: Record<string, string> = {
          action: "updateContent",
          itemId: selectedItemId,
          locale: targetLocale,
          primaryLocale,
        };
        config.fieldDefinitions.forEach((field) => {
          formDataObj[field.key] = newValues[field.key] || "";
        });
        fetcher.submit(formDataObj, { method: "POST" });
      }
    }
  }, [fetcher.data, selectedItemId, primaryLocale, config.fieldDefinitions, fetcher]);

  // Handle single alt-text generation (show as suggestion)
  useEffect(() => {
    if (fetcher.data?.success && 'altText' in fetcher.data && 'imageIndex' in fetcher.data) {
      const { altText, imageIndex } = fetcher.data as any;
      setAltTextSuggestions(prev => ({
        ...prev,
        [imageIndex]: altText
      }));
    }
  }, [fetcher.data]);

  // Handle bulk alt-text generation (auto-accept all)
  useEffect(() => {
    if (fetcher.data?.success && 'generatedAltTexts' in fetcher.data) {
      const { generatedAltTexts } = fetcher.data as any;
      console.log('[ALT-TEXT] Auto-accepting bulk generated alt-texts:', generatedAltTexts);
      setImageAltTexts(prev => ({
        ...prev,
        ...generatedAltTexts
      }));
    }
  }, [fetcher.data]);

  // Handle translated alt-text response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedAltText' in fetcher.data) {
      const { translatedAltText, imageIndex } = fetcher.data as any;
      console.log('[ALT-TEXT] Setting translated alt-text for image', imageIndex, ':', translatedAltText);
      setImageAltTexts(prev => ({
        ...prev,
        [imageIndex]: translatedAltText
      }));
    }
  }, [fetcher.data]);

  // Handle "translateFieldToAllLocales" response (from Accept & Translate)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      'fieldType' in fetcher.data &&
      !('locale' in fetcher.data)
    ) {
      const { translations, fieldType } = fetcher.data as any;

      // Create a unique key for this response to prevent duplicate processing
      const responseKey = `translateFieldToAllLocales-${fieldType}-${Object.keys(translations).join(',')}`;
      if (processedResponseRef.current === responseKey) {
        return; // Already processed this response
      }
      processedResponseRef.current = responseKey;

      // translations is Record<string, string> where key is locale and value is translated text
      const field = config.fieldDefinitions.find(f => f.key === fieldType);
      if (!field) return;

      const shopifyKey = field.translationKey;

      if (selectedItem && shopifyKey) {
        // Update item translations for all locales
        for (const [locale, translatedValue] of Object.entries(translations as Record<string, string>)) {
          // Remove existing translation for this key and locale
          selectedItem.translations = selectedItem.translations.filter(
            (t: any) => !(t.locale === locale && t.key === shopifyKey)
          );

          // Add new translation
          selectedItem.translations.push({
            key: shopifyKey,
            value: translatedValue,
            locale
          });

          console.log(`[ACCEPT-AND-TRANSLATE] Updated ${fieldType} for ${locale}: ${String(translatedValue || '').substring(0, 50)}...`);
        }

        showInfoBox(
          t.common?.fieldTranslatedToLanguages
            ?.replace("{fieldType}", fieldType)
            .replace("{count}", String(Object.keys(translations).length))
            || `${fieldType} translated to ${Object.keys(translations).length} language(s)`,
          "success",
          t.common?.success || "Success"
        );

        // Reset the accept-and-translate flow flag after translations are complete
        setIsAcceptAndTranslateFlow(false);

        // Mark as loading to reset change detection
        // DON'T revalidate here - it would overwrite our local changes to selectedItem.translations
        // The translations are already saved server-side by the action
        setIsLoadingData(true);
      }
    }
  }, [fetcher.data, selectedItem, config.fieldDefinitions, showInfoBox, t]); // Removed currentLanguage - not used

  // Handle "translateAll" response (translates to ALL enabled locales)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      !('locale' in fetcher.data) &&
      !('fieldType' in fetcher.data) &&
      !('targetLocale' in fetcher.data)
    ) {
      const translations = (fetcher.data as any).translations;
      if (selectedItem) {
        for (const [locale, fields] of Object.entries(translations as any)) {
          const newTranslations: any[] = [];

          // Map fields to translations
          config.fieldDefinitions.forEach((fieldDef) => {
            const value = (fields as any)[fieldDef.key];
            if (value) {
              newTranslations.push({
                key: fieldDef.translationKey,
                value,
                locale,
              });
            }
          });

          // Store directly in item translations
          selectedItem.translations = [
            ...selectedItem.translations.filter((t: any) => t.locale !== locale),
            ...newTranslations,
          ];

          // If we're currently viewing this locale, update the editable fields
          if (currentLanguage === locale) {
            const updatedValues = { ...editableValues };
            config.fieldDefinitions.forEach((fieldDef) => {
              const value = (fields as any)[fieldDef.key];
              if (value) {
                updatedValues[fieldDef.key] = value;
              }
            });
            setEditableValues(updatedValues);
          }
        }
      }
    }
  }, [fetcher.data, currentLanguage, selectedItem, config.fieldDefinitions]);

  // Handle "translateAllForLocale" response (translates to ONE specific locale)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      'targetLocale' in fetcher.data &&
      !('fieldType' in fetcher.data)
    ) {
      const { translations, targetLocale } = fetcher.data as any;
      if (selectedItem) {
        const newTranslations: any[] = [];

        // Map fields to translations for the specific locale
        config.fieldDefinitions.forEach((fieldDef) => {
          const value = translations[fieldDef.key];
          if (value) {
            newTranslations.push({
              key: fieldDef.translationKey,
              value,
              locale: targetLocale,
            });
          }
        });

        // Store directly in item translations (replace existing for this locale)
        selectedItem.translations = [
          ...selectedItem.translations.filter((t: any) => t.locale !== targetLocale),
          ...newTranslations,
        ];

        // If we're currently viewing this locale, update the editable fields
        if (currentLanguage === targetLocale) {
          const updatedValues = { ...editableValues };
          config.fieldDefinitions.forEach((fieldDef) => {
            const value = translations[fieldDef.key];
            if (value) {
              updatedValues[fieldDef.key] = value;
            }
          });
          setEditableValues(updatedValues);
        }

        showInfoBox(
          t.common?.translatedSuccessfully || `Successfully translated to ${targetLocale}`,
          "success",
          t.common?.success || "Success"
        );
      }
    }
  }, [fetcher.data, currentLanguage, selectedItem, config.fieldDefinitions, showInfoBox, t]);

  // Update item object after saving (both primary locale and translations)
  // IMPORTANT: We track which fetcher.data we've processed to prevent re-running on language change
  useEffect(() => {
    if (
      fetcher.data?.success &&
      !('translations' in fetcher.data) &&
      !('generatedContent' in fetcher.data) &&
      !('translatedValue' in fetcher.data) &&
      selectedItem
    ) {
      // Only process if fetcher.data has actually changed (not just a dependency re-run)
      if (fetcher.data === lastFetcherDataRef.current) {
        console.log('[SAVE-RESPONSE] Skipping - fetcher.data unchanged, only dependencies changed');
        return;
      }
      lastFetcherDataRef.current = fetcher.data;

      // Use the locale that was saved (tracked by savedLocaleRef), not the current language
      const savedLocale = savedLocaleRef.current;
      if (!savedLocale) {
        console.log('[SAVE-RESPONSE] No savedLocale tracked, skipping update');
        return;
      }

      console.log('[SAVE-RESPONSE] Processing save response for locale:', savedLocale);

      if (savedLocale === primaryLocale) {
        // This was a successful update action for primary locale
        // Update the item object directly with new values
        console.log('[SAVE-RESPONSE] Updating primary locale item values');
        config.fieldDefinitions.forEach((fieldDef) => {
          const value = editableValues[fieldDef.key];

          // Update based on field mapping
          if (fieldDef.key === 'title') {
            selectedItem.title = value || '';
          } else if (fieldDef.key === 'description') {
            selectedItem.descriptionHtml = value || '';
          } else if (fieldDef.key === 'body') {
            selectedItem.body = value || '';
          } else if (fieldDef.key === 'handle') {
            selectedItem.handle = value || '';
          } else if (fieldDef.key === 'seoTitle') {
            if (!selectedItem.seo) selectedItem.seo = {};
            selectedItem.seo.title = value || '';
          } else if (fieldDef.key === 'metaDescription') {
            if (!selectedItem.seo) selectedItem.seo = {};
            selectedItem.seo.description = value || '';
          }
        });
      } else {
        // This was a successful update action for a translation
        // Use the saved locale, not the current viewing language
        console.log('[SAVE-RESPONSE] Updating translation for saved locale:', savedLocale);
        const existingTranslations = selectedItem.translations.filter(
          (t: any) => t.locale !== savedLocale
        );

        // Add new translations for the saved locale
        config.fieldDefinitions.forEach((fieldDef) => {
          const value = editableValues[fieldDef.key];
          if (value) {
            existingTranslations.push({
              key: fieldDef.translationKey,
              value,
              locale: savedLocale,
            });
          }
        });

        selectedItem.translations = existingTranslations;
      }

      // Clear the saved locale ref after processing
      savedLocaleRef.current = null;

      // Reset change detection after successful save
      // This ensures hasChanges becomes false after we've updated selectedItem
      setIsLoadingData(true);
    }
  }, [fetcher.data, selectedItem, primaryLocale, editableValues, config.fieldDefinitions]); // Removed currentLanguage from dependencies

  // Show global InfoBox for success/error messages and revalidate after save
  useEffect(() => {
    if (
      fetcher.data?.success &&
      !(fetcher.data as any).generatedContent &&
      !(fetcher.data as any).translatedValue &&
      !(fetcher.data as any).translations // Skip revalidate for bulk operations, they handle it differently
    ) {
      // Check if there's a pending translation to start after this save
      if (pendingTranslationAfterSaveRef.current) {
        const { fieldKey, sourceText, targetLocales, contextTitle, itemId } = pendingTranslationAfterSaveRef.current;
        pendingTranslationAfterSaveRef.current = null;

        console.log('[ACCEPT-AND-TRANSLATE] Save completed, now starting translation');

        // Start the translation (don't show "saved" message yet - will show after translation)
        fetcher.submit({
          action: "translateFieldToAllLocales",
          itemId: itemId,
          fieldType: fieldKey,
          sourceText: sourceText,
          targetLocales: JSON.stringify(targetLocales),
          contextTitle: contextTitle
        }, { method: "POST" });

        // Don't revalidate yet - wait for translation to complete
        return;
      }

      showInfoBox(
        t.common?.changesSaved || "Changes saved successfully!",
        "success",
        t.common?.success || "Success"
      );

      // Revalidate to fetch fresh data from the database after successful save
      // This ensures translations and all changes are reflected in the UI
      revalidator.revalidate();
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.common?.error || "Error");
    }
  }, [fetcher.data, showInfoBox, t, revalidator, fetcher]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // Wrapper for performAutoSave with default locale
  const performSaveWithValues = (valuesToSave: Record<string, string>, locale: string = currentLanguage) => {
    performAutoSave(valuesToSave, locale);
  };

  const handleSave = () => {
    if (!selectedItemId || !hasChanges) return;

    // If we're saving in the primary locale, clear all translations for changed fields
    if (currentLanguage === primaryLocale && selectedItem) {
      config.fieldDefinitions.forEach((field) => {
        const currentValue = editableValues[field.key] || "";
        const originalValue = getItemFieldValue(selectedItem, field.key, primaryLocale);

        // Only clear translations if the value actually changed
        if (currentValue !== originalValue && field.translationKey) {
          const translationKey = field.translationKey;

          // Remove all translations for this field across all locales
          if (selectedItem.translations) {
            const beforeCount = selectedItem.translations.length;
            selectedItem.translations = selectedItem.translations.filter(
              (t: any) => t.key !== translationKey
            );
            const afterCount = selectedItem.translations.length;

            if (beforeCount !== afterCount) {
              console.log(`[TRANSLATION-CLEAR] Cleared translations for field "${field.key}" (key: ${translationKey})`);
            }
          }
        }
      });
    }

    const formDataObj: Record<string, string> = {
      action: "updateContent",
      itemId: selectedItemId,
      locale: currentLanguage,
      primaryLocale,
    };

    // Add all field values
    config.fieldDefinitions.forEach((field) => {
      formDataObj[field.key] = editableValues[field.key] || "";
    });

    // Add image alt-texts if there are any changes
    if (Object.keys(imageAltTexts).length > 0) {
      formDataObj.imageAltTexts = JSON.stringify(imageAltTexts);
    }

    // If saving primary locale, include changed fields for server-side translation deletion
    if (currentLanguage === primaryLocale) {
      const changedFields = getChangedFields(editableValues);
      if (changedFields.length > 0) {
        formDataObj.changedFields = JSON.stringify(changedFields);
        console.log('[SAVE] Changed fields (translations will be deleted on server):', changedFields);
      }
    }

    savedLocaleRef.current = currentLanguage; // Track which locale we're saving
    fetcher.submit(formDataObj, { method: "POST" });
    clearPendingNavigation();
  };

  const handleDiscard = () => {
    if (!selectedItem) return;

    const newValues: Record<string, string> = {};

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale values
      config.fieldDefinitions.forEach((field) => {
        newValues[field.key] = getItemFieldValue(selectedItem, field.key, primaryLocale);
      });
    } else {
      // Reset to translated values
      config.fieldDefinitions.forEach((field) => {
        const translatedValue = getTranslatedValue(
          selectedItem,
          field.translationKey,
          currentLanguage,
          "",
          primaryLocale
        );
        newValues[field.key] = translatedValue;
      });
    }

    setEditableValues(newValues);
    clearPendingNavigation();
  };

  const handleGenerateAI = (fieldKey: string) => {
    if (!selectedItemId) return;

    const currentValue = editableValues[fieldKey] || "";
    const contextTitle = editableValues.title || "";
    const contextDescription = editableValues.description || editableValues.body || "";

    fetcher.submit(
      {
        action: "generateAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
      },
      { method: "POST" }
    );
  };

  const handleFormatAI = (fieldKey: string) => {
    if (!selectedItemId) return;

    const currentValue = editableValues[fieldKey] || "";
    if (!currentValue) {
      showInfoBox(
        t.common?.noContentToFormat || "No content available to format",
        "warning",
        t.common?.warning || "Warning"
      );
      return;
    }

    const contextTitle = editableValues.title || "";
    const contextDescription = editableValues.description || editableValues.body || "";

    fetcher.submit(
      {
        action: "formatAIText",
        itemId: selectedItemId,
        fieldType: fieldKey,
        currentValue,
        contextTitle,
        contextDescription,
      },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldKey: string) => {
    if (!selectedItemId || !selectedItem) return;

    const field = config.fieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return;

    const sourceText = getItemFieldValue(selectedItem, fieldKey, primaryLocale);
    if (!sourceText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    fetcher.submit(
      {
        action: "translateField",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocale: currentLanguage,
      },
      { method: "POST" }
    );
  };

  const handleTranslateFieldToAllLocales = (fieldKey: string) => {
    if (!selectedItemId || !selectedItem) return;

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

    const field = config.fieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return;

    const sourceText = getItemFieldValue(selectedItem, fieldKey, primaryLocale);
    if (!sourceText) {
      showInfoBox(
        t.content?.noSourceText || "Kein Text in der Hauptsprache vorhanden zum Übersetzen",
        "warning",
        "Warnung"
      );
      return;
    }

    const contextTitle = getItemFieldValue(selectedItem, 'title', primaryLocale) || selectedItem.id || "";

    fetcher.submit(
      {
        action: "translateFieldToAllLocales",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
        targetLocales: JSON.stringify(targetLocales),
        contextTitle,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedItemId || !selectedItem) return;

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

    const formDataObj: Record<string, string> = {
      action: "translateAll",
      itemId: selectedItemId,
      targetLocales: JSON.stringify(targetLocales),
    };

    // Add all field values from primary locale
    config.fieldDefinitions.forEach((field) => {
      const value = getItemFieldValue(selectedItem, field.key, primaryLocale);
      if (value) {
        formDataObj[field.key] = value;
      }
    });

    fetcher.submit(formDataObj, { method: "POST" });
  };

  const handleAcceptSuggestion = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (!suggestion) return;

    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Create the new values with the accepted suggestion
    const newValues = {
      ...editableValues,
      [fieldKey]: suggestion,
    };

    // Update the UI state
    setEditableValues(newValues);

    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });

    // Auto-save immediately after accepting AI suggestion
    performSaveWithValues(newValues);
  };

  const handleAcceptAndTranslate = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (!suggestion || !selectedItemId) return;

    // Reset processed response ref for new operation
    processedResponseRef.current = null;

    // Set flag to prevent translation deletion during this flow
    setIsAcceptAndTranslateFlow(true);

    // Create the new values with the accepted suggestion
    const newValues = {
      ...editableValues,
      [fieldKey]: suggestion,
    };

    // Accept the suggestion in the primary locale
    setEditableValues(newValues);

    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
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
      setIsAcceptAndTranslateFlow(false);
      // No translations needed, just save the primary text directly
      performSaveWithValues(newValues, primaryLocale);
      return;
    }

    // Get context title for translation
    const contextTitle = getItemFieldValue(selectedItem!, 'title', primaryLocale) || selectedItem!.id || "";

    // Step 1: Set up pending translation (will be triggered AFTER save completes)
    pendingTranslationAfterSaveRef.current = {
      fieldKey,
      sourceText: suggestion,
      targetLocales,
      contextTitle,
      itemId: selectedItemId
    };

    // Step 2: Save the primary text first
    // After save completes, the useEffect will trigger the translation
    console.log('[ACCEPT-AND-TRANSLATE] Saving primary text first, then will translate');
    performSaveWithValues(newValues, primaryLocale);
  };

  const handleRejectSuggestion = (fieldKey: string) => {
    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });
  };

  const handleLanguageChange = (locale: string) => {
    handleNavigationAttempt(() => setCurrentLanguage(locale), hasChanges);
  };

  const handleToggleLanguage = (locale: string) => {
    // Don't allow disabling the primary locale
    if (locale === primaryLocale) return;

    setEnabledLanguages((prev) => {
      if (prev.includes(locale)) {
        // Disable this language
        return prev.filter((l) => l !== locale);
      } else {
        // Enable this language
        return [...prev, locale];
      }
    });
  };

  const handleItemSelect = (itemId: string) => {
    handleNavigationAttempt(() => setSelectedItemId(itemId), hasChanges);
  };

  const handleValueChange = (fieldKey: string, value: string) => {
    // Force isLoadingData to false to ensure change detection works for manual changes
    setIsLoadingData(false);

    // Update the state immediately without any side effects
    // This ensures the input field responds instantly to user typing
    setEditableValues((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
  };

  const handleToggleHtmlMode = (fieldKey: string) => {
    setHtmlModes((prev) => ({
      ...prev,
      [fieldKey]: prev[fieldKey] === "html" ? "rendered" : "html",
    }));
  };

  const handleClearField = (fieldKey: string) => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear the field value
    setEditableValues((prev) => ({
      ...prev,
      [fieldKey]: "",
    }));
  };

  const handleClearAllClick = () => {
    setIsClearAllModalOpen(true);
  };

  const handleClearAllConfirm = () => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear all field values except title (title should never be empty in primary locale)
    const clearedValues: Record<string, string> = {};
    config.fieldDefinitions.forEach((field) => {
      if (field.key === "title") {
        // Keep the current title value
        clearedValues[field.key] = editableValues[field.key] || "";
      } else {
        // Clear all other fields
        clearedValues[field.key] = "";
      }
    });
    setEditableValues(clearedValues);

    // Close modal
    setIsClearAllModalOpen(false);
  };

  const handleClearAllCancel = () => {
    setIsClearAllModalOpen(false);
  };

  const handleClearAllForLocaleClick = () => {
    setIsClearAllModalOpen(true);
  };

  const handleClearAllForLocaleConfirm = () => {
    // Force isLoadingData to false to ensure change detection works
    setIsLoadingData(false);

    // Clear all field values for the current foreign language
    const clearedValues: Record<string, string> = {};
    config.fieldDefinitions.forEach((field) => {
      clearedValues[field.key] = "";
    });
    setEditableValues(clearedValues);

    // Close modal
    setIsClearAllModalOpen(false);
  };

  const handleTranslateAllForLocale = () => {
    if (!selectedItemId || !selectedItem || currentLanguage === primaryLocale) return;

    const formDataObj: Record<string, string> = {
      action: "translateAllForLocale",
      itemId: selectedItemId,
      targetLocale: currentLanguage,
    };

    // Add all field values from primary locale
    config.fieldDefinitions.forEach((field) => {
      const value = getItemFieldValue(selectedItem, field.key, primaryLocale);
      if (value) {
        formDataObj[field.key] = value;
      }
    });

    fetcher.submit(formDataObj, { method: "POST" });
  };

  // ============================================================================
  // ALT-TEXT HANDLERS
  // ============================================================================

  const handleAltTextChange = (imageIndex: number, value: string) => {
    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: value
    }));
  };

  const handleGenerateAltText = (imageIndex: number) => {
    if (!selectedItem || !selectedItem.images || !selectedItem.images[imageIndex]) return;

    const image = selectedItem.images[imageIndex];
    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale);

    fetcher.submit({
      action: "generateAltText",
      productId: selectedItem.id,
      imageIndex: String(imageIndex),
      imageUrl: image.url,
      productTitle
    }, { method: "POST" });
  };

  const handleGenerateAllAltTexts = () => {
    if (!selectedItem || !selectedItem.images || selectedItem.images.length === 0) return;

    const productTitle = getItemFieldValue(selectedItem, 'title', primaryLocale);
    const imagesData = selectedItem.images.map((img: any) => ({ url: img.url }));

    fetcher.submit({
      action: "generateAllAltTexts",
      productId: selectedItem.id,
      productTitle,
      imagesData: JSON.stringify(imagesData)
    }, { method: "POST" });
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

    fetcher.submit({
      action: "translateAltText",
      productId: selectedItem.id,
      imageIndex: String(imageIndex),
      sourceAltText,
      targetLocale: currentLanguage
    }, { method: "POST" });
  };

  const handleAcceptAltTextSuggestion = (imageIndex: number) => {
    const suggestion = altTextSuggestions[imageIndex];
    if (!suggestion) return;

    setImageAltTexts(prev => ({
      ...prev,
      [imageIndex]: suggestion
    }));

    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });
  };

  const handleRejectAltTextSuggestion = (imageIndex: number) => {
    setAltTextSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[imageIndex];
      return newSuggestions;
    });
  };

  // Reset alt-text state when product changes
  useEffect(() => {
    setImageAltTexts({});
    setAltTextSuggestions({});
  }, [selectedItemId]);

  // Load translated alt-texts when language changes
  useEffect(() => {
    if (!selectedItem || !selectedItem.images) return;

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale alt-texts
      setImageAltTexts({});
    } else {
      // Load translated alt-texts from DB
      const translatedAltTexts: Record<number, string> = {};
      selectedItem.images.forEach((img: any, index: number) => {
        const translation = img.altTextTranslations?.find(
          (t: any) => t.locale === currentLanguage
        );
        if (translation) {
          translatedAltTexts[index] = translation.altText;
        }
      });
      setImageAltTexts(translatedAltTexts);
    }
  }, [currentLanguage, selectedItemId, primaryLocale, selectedItem]);

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  const getFieldBackgroundColor = (fieldKey: string): string => {
    const hasTranslation = selectedItem?.translations?.some(
      (t: any) => t.key === config.fieldDefinitions.find(f => f.key === fieldKey)?.translationKey && t.locale === currentLanguage
    );

    if (currentLanguage === primaryLocale) {
      return "transparent";
    }

    return hasTranslation ? "#f0f9ff" : "transparent";
  };

  const isFieldTranslated = (fieldKey: string): boolean => {
    if (!selectedItem) return false;
    const field = config.fieldDefinitions.find((f) => f.key === fieldKey);
    if (!field) return false;

    return selectedItem.translations?.some(
      (t: any) => t.key === field.translationKey && t.locale === currentLanguage
    );
  };

  const getEditableValue = (fieldKey: string): string => {
    return editableValues[fieldKey] || "";
  };

  const setEditableValue = (fieldKey: string, value: string) => {
    handleValueChange(fieldKey, value);
  };

  // ============================================================================
  // RETURN
  // ============================================================================

  const state: EditorState = {
    selectedItemId,
    currentLanguage,
    editableValues,
    aiSuggestions,
    htmlModes,
    hasChanges,
    enabledLanguages,
    imageAltTexts,
    altTextSuggestions,
    isClearAllModalOpen,
  };

  const handlers: EditorHandlers = {
    handleSave,
    handleDiscard,
    handleGenerateAI,
    handleFormatAI,
    handleTranslateField,
    handleTranslateFieldToAllLocales,
    handleTranslateAll,
    handleAcceptSuggestion,
    handleAcceptAndTranslate,
    handleRejectSuggestion,
    handleLanguageChange,
    handleToggleLanguage,
    handleItemSelect,
    handleValueChange,
    handleToggleHtmlMode,
    handleClearField,
    handleClearAllClick,
    handleClearAllConfirm,
    handleClearAllCancel,
    handleClearAllForLocaleClick,
    handleClearAllForLocaleConfirm,
    handleTranslateAllForLocale,
    handleAltTextChange,
    handleGenerateAltText,
    handleGenerateAllAltTexts,
    handleTranslateAltText,
    handleAcceptAltTextSuggestion,
    handleRejectAltTextSuggestion,
  };

  return {
    state,
    handlers,
    selectedItem: selectedItem || null,
    navigationGuard: {
      pendingNavigation,
      highlightSaveButton,
      saveButtonRef,
      handleNavigationAttempt,
      clearPendingNavigation,
    },
    helpers: {
      getFieldBackgroundColor,
      isFieldTranslated,
      getEditableValue,
      setEditableValue,
    },
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get field value from item based on field key and primary locale
 */
function getItemFieldValue(item: any, fieldKey: string, primaryLocale: string): string {
  // Common field mappings
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
  };

  return fieldMappings[fieldKey] || "";
}

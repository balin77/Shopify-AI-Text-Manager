/**
 * Unified Content Editor Hook
 *
 * Based on the products page implementation with all bug fixes.
 * Provides a complete state management and handler system for content editing.
 */

import { useState, useEffect } from "react";
import { useNavigationGuard, useChangeTracking, getTranslatedValue } from "../utils/contentEditor.utils";
import type {
  UseContentEditorProps,
  UseContentEditorReturn,
  EditorState,
  EditorHandlers,
} from "../types/content-editor.types";

export function useUnifiedContentEditor(props: UseContentEditorProps): UseContentEditorReturn {
  const { config, items, shopLocales, primaryLocale, fetcher, showInfoBox, t } = props;

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, 'html' | 'rendered'>>({});

  const selectedItem = items.find((item) => item.id === selectedItemId);

  // Navigation guard
  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  // Change tracking
  const hasChanges = useChangeTracking(
    selectedItem,
    currentLanguage,
    primaryLocale,
    editableValues as any, // TODO: Fix type mismatch
    config.contentType
  );

  // ============================================================================
  // LOAD ITEM DATA (when item or language changes)
  // ============================================================================

  useEffect(() => {
    if (!selectedItem) return;

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

  // Handle translated field response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data) {
      const { fieldType, translatedValue } = fetcher.data as any;
      setEditableValues((prev) => ({
        ...prev,
        [fieldType]: translatedValue,
      }));
    }
  }, [fetcher.data]);

  // Handle "translateAll" response
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      !('locale' in fetcher.data) &&
      !('fieldType' in fetcher.data)
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

  // Update item object after saving (both primary locale and translations)
  useEffect(() => {
    if (
      fetcher.data?.success &&
      !('translations' in fetcher.data) &&
      !('generatedContent' in fetcher.data) &&
      !('translatedValue' in fetcher.data) &&
      selectedItem
    ) {
      if (currentLanguage === primaryLocale) {
        // This was a successful update action for primary locale
        // Update the item object directly with new values
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
        const existingTranslations = selectedItem.translations.filter(
          (t: any) => t.locale !== currentLanguage
        );

        // Add new translations
        config.fieldDefinitions.forEach((fieldDef) => {
          const value = editableValues[fieldDef.key];
          if (value) {
            existingTranslations.push({
              key: fieldDef.translationKey,
              value,
              locale: currentLanguage,
            });
          }
        });

        selectedItem.translations = existingTranslations;
      }
    }
  }, [fetcher.data, selectedItem, currentLanguage, primaryLocale, editableValues, config.fieldDefinitions]);

  // Show global InfoBox for success/error messages
  useEffect(() => {
    if (
      fetcher.data?.success &&
      !(fetcher.data as any).generatedContent &&
      !(fetcher.data as any).translatedValue
    ) {
      showInfoBox(
        t.common?.changesSaved || "Changes saved successfully!",
        "success",
        t.common?.success || "Success"
      );
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.common?.error || "Error");
    }
  }, [fetcher.data, showInfoBox, t]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  const handleSave = () => {
    if (!selectedItemId || !hasChanges) return;

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
      showInfoBox("Kein Inhalt zum Formatieren vorhanden", "warning", "Warnung");
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
        action: "translateFieldToAllLocales",
        itemId: selectedItemId,
        fieldType: fieldKey,
        sourceText,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedItemId || !selectedItem) return;

    const formDataObj: Record<string, string> = {
      action: "translateAll",
      itemId: selectedItemId,
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

    setEditableValues((prev) => ({
      ...prev,
      [fieldKey]: suggestion,
    }));

    setAiSuggestions((prev) => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });
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

  const handleItemSelect = (itemId: string) => {
    handleNavigationAttempt(() => setSelectedItemId(itemId), hasChanges);
  };

  const handleValueChange = (fieldKey: string, value: string) => {
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
    handleRejectSuggestion,
    handleLanguageChange,
    handleItemSelect,
    handleValueChange,
    handleToggleHtmlMode,
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

import { useState, useEffect, useRef, useCallback } from "react";
import type { TranslatableItem, ContentType } from "~/types/content-editor.types";
import {
  SHOPIFY_TRANSLATION_KEYS,
  CONTENT_TYPE_DESCRIPTION_KEY,
} from "~/constants/shopifyFields";
import { getTranslatedValue } from "../utils/contentEditor.utils";

/**
 * Track changes in editable fields
 * IMPORTANT: Uses refs to cache original values and prevent infinite re-renders
 * when selectedItem reference changes (e.g., from Shopify admin revalidations)
 */
export function useChangeTracking(
  selectedItem: TranslatableItem | null,
  currentLanguage: string,
  primaryLocale: string,
  editableFields: {
    title?: string;
    description?: string;
    body?: string;
    handle?: string;
    seoTitle?: string;
    metaDescription?: string;
    productType?: string;
    summary?: string;
  },
  contentType: ContentType,
  fallbackFields?: Set<string>
) {
  const [hasChanges, setHasChanges] = useState(false);

  // Use ref for fallbackFields to avoid triggering useEffect on Set reference changes
  const fallbackFieldsRef = useRef(fallbackFields);
  fallbackFieldsRef.current = fallbackFields;

  // Cache original values to prevent recalculation on every selectedItem reference change
  const originalValuesRef = useRef<{
    itemId: string | null;
    language: string;
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
    productType: string;
    summary: string;
  } | null>(null);

  // Track previous item ID and language to detect actual changes
  const prevItemIdRef = useRef<string | null>(null);
  const prevLanguageRef = useRef<string>(currentLanguage);

  // Track if selectedItem was null (used to detect post-save state)
  const wasNullRef = useRef<boolean>(selectedItem === null);

  // Helper function to get current item values
  const getCurrentItemValues = useCallback((item: TranslatableItem) => {
    const descKey = CONTENT_TYPE_DESCRIPTION_KEY[contentType];
    const descFallback = (contentType === 'collections' || contentType === 'products')
      ? (item.descriptionHtml || "")
      : (item.body || "");

    const getOriginalValue = (key: string, fallback: string) => {
      if (currentLanguage === primaryLocale) {
        return fallback;
      }
      return getTranslatedValue(item, key, currentLanguage, "", primaryLocale);
    };

    return {
      title: contentType !== 'policies'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.TITLE, item.title || "")
        : "",
      description: getOriginalValue(descKey, descFallback || ""),
      handle: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.HANDLE, item.handle || ""),
      seoTitle: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_TITLE, item.seo?.title || ""),
      metaDescription: getOriginalValue(SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION, item.seo?.description || ""),
      productType: contentType === 'products'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.PRODUCT_TYPE, item.productType || "")
        : "",
      summary: contentType === 'pages'
        ? getOriginalValue(SHOPIFY_TRANSLATION_KEYS.SUMMARY, item.summary || "")
        : "",
    };
  }, [contentType, currentLanguage, primaryLocale]);

  const selectedItemId = selectedItem?.id || null;

  // Update cached original values when:
  // 1. Item ID or language changes
  // 2. Item was null and is now non-null (post-save/load state - update to current editable values)
  if (selectedItem) {
    const itemIdChanged = prevItemIdRef.current !== selectedItemId;
    const languageChanged = prevLanguageRef.current !== currentLanguage;
    const wasNull = wasNullRef.current;

    if (itemIdChanged || languageChanged) {
      // Item or language changed - cache the item's current values as original
      prevItemIdRef.current = selectedItemId;
      prevLanguageRef.current = currentLanguage;

      const itemValues = getCurrentItemValues(selectedItem);
      originalValuesRef.current = {
        itemId: selectedItemId,
        language: currentLanguage,
        ...itemValues,
      };
    } else if (wasNull && originalValuesRef.current) {
      // Coming back from null state (after save/load) - update original values to match editable fields
      // This ensures hasChanges becomes false after save
      originalValuesRef.current = {
        itemId: selectedItemId,
        language: currentLanguage,
        title: editableFields.title || "",
        description: editableFields.body || editableFields.description || "",
        handle: editableFields.handle || "",
        seoTitle: editableFields.seoTitle || "",
        metaDescription: editableFields.metaDescription || "",
        productType: editableFields.productType || "",
        summary: editableFields.summary || "",
      };
    }
  }

  // Update wasNull tracking
  wasNullRef.current = selectedItem === null;

  // Calculate hasChanges based on cached original values
  // This effect only depends on editableFields, not on selectedItem reference
  useEffect(() => {
    if (!selectedItem || !originalValuesRef.current) {
      if (hasChanges) setHasChanges(false);
      return;
    }

    const originals = originalValuesRef.current;
    const currentDescValue = editableFields.body || editableFields.description || "";

    const titleChanged = contentType !== 'policies'
      ? (editableFields.title || "") !== originals.title
      : false;
    const descChanged = currentDescValue !== originals.description;
    // Skip fallback fields - they show primary locale values and shouldn't count as changes
    const handleChanged = !fallbackFieldsRef.current?.has('handle') && (editableFields.handle || "") !== originals.handle;
    const seoTitleChanged = !fallbackFieldsRef.current?.has('seoTitle') && (editableFields.seoTitle || "") !== originals.seoTitle;
    const metaDescChanged = (editableFields.metaDescription || "") !== originals.metaDescription;
    const productTypeChanged = contentType === 'products'
      ? (editableFields.productType || "") !== originals.productType
      : false;
    const summaryChanged = contentType === 'pages'
      ? (editableFields.summary || "") !== originals.summary
      : false;

    const newHasChanges = titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged || productTypeChanged || summaryChanged;

    // Only update state if value actually changed to prevent unnecessary re-renders
    if (newHasChanges !== hasChanges) {
      setHasChanges(newHasChanges);
    }
  }, [
    editableFields.title,
    editableFields.description,
    editableFields.body,
    editableFields.handle,
    editableFields.seoTitle,
    editableFields.metaDescription,
    editableFields.productType,
    editableFields.summary,
    // Use selectedItem?.id instead of selectedItem to prevent re-runs on reference changes
    selectedItem?.id,
    currentLanguage,
    contentType,
    hasChanges
  ]);

  return hasChanges;
}

import { useEffect } from "react";
import type { TranslatableItem, ContentType } from "~/types/content-editor.types";
import {
  SHOPIFY_TRANSLATION_KEYS,
  CONTENT_TYPE_DESCRIPTION_KEY,
} from "~/constants/shopifyFields";
import { getTranslatedValue } from "../utils/contentEditor.utils";

/**
 * Load item data when item or language changes
 */
export function useItemDataLoader(
  selectedItem: TranslatableItem | null,
  currentLanguage: string,
  primaryLocale: string,
  contentType: ContentType,
  setEditableFields: (fields: {
    title: string;
    description: string;
    handle: string;
    seoTitle: string;
    metaDescription: string;
  }) => void,
  selectedItemId: string | null
) {
  useEffect(() => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      // Load primary locale data
      const title = selectedItem.title || "";
      let description = "";
      let handle = selectedItem.handle || "";
      let seoTitle = "";
      let metaDescription = "";

      if (contentType === 'blogs') {
        description = selectedItem.body || "";
      } else if (contentType === 'collections') {
        description = selectedItem.descriptionHtml || "";
        seoTitle = selectedItem.seo?.title || "";
        metaDescription = selectedItem.seo?.description || "";
      } else if (contentType === 'pages') {
        description = selectedItem.body || "";
      } else if (contentType === 'policies') {
        description = selectedItem.body || "";
        handle = "";
      }

      setEditableFields({
        title,
        description,
        handle,
        seoTitle,
        metaDescription
      });
    } else {
      // Load translation data (translations are already loaded in item.translations)
      const descKey = CONTENT_TYPE_DESCRIPTION_KEY[contentType];

      const title = contentType !== 'policies'
        ? getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.TITLE, currentLanguage, "", primaryLocale)
        : "";
      const description = getTranslatedValue(selectedItem, descKey, currentLanguage, "", primaryLocale);
      const handle = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.HANDLE, currentLanguage, "", primaryLocale);
      const seoTitle = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.META_TITLE, currentLanguage, "", primaryLocale);
      const metaDescription = getTranslatedValue(selectedItem, SHOPIFY_TRANSLATION_KEYS.META_DESCRIPTION, currentLanguage, "", primaryLocale);

      setEditableFields({
        title,
        description,
        handle,
        seoTitle,
        metaDescription
      });
    }
  }, [selectedItemId, currentLanguage, selectedItem, contentType, primaryLocale]);
}

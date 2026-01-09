import { useState, useEffect } from "react";

interface Product {
  id: string;
  title: string;
  descriptionHtml: string;
  handle: string;
  seo?: {
    title: string;
    description: string;
  };
  translations: Array<{
    key: string;
    value: string;
    locale: string;
  }>;
}

interface UseProductFieldsProps {
  selectedProduct: Product | null;
  currentLanguage: string;
  primaryLocale: string;
  loadedTranslations?: Record<string, any[]>;
}

export function useProductFields({
  selectedProduct,
  currentLanguage,
  primaryLocale,
  loadedTranslations = {},
}: UseProductFieldsProps) {
  const [editableTitle, setEditableTitle] = useState("");
  const [editableDescription, setEditableDescription] = useState("");
  const [editableHandle, setEditableHandle] = useState("");
  const [editableSeoTitle, setEditableSeoTitle] = useState("");
  const [editableMetaDescription, setEditableMetaDescription] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  // Helper function to get translated value
  const getTranslatedValue = (key: string, locale: string, fallback: string) => {
    if (!selectedProduct || locale === primaryLocale) {
      return fallback;
    }

    // First check loaded translations state
    const itemKey = `${selectedProduct.id}_${locale}`;
    const translations = loadedTranslations[itemKey] || selectedProduct.translations || [];

    const translation = translations.find(
      (t: any) => t.key === key && t.locale === locale
    );

    return translation?.value || "";
  };

  // Load product data when product or language changes
  useEffect(() => {
    if (selectedProduct) {
      if (currentLanguage === primaryLocale) {
        setEditableTitle(selectedProduct.title);
        setEditableDescription(selectedProduct.descriptionHtml || "");
        setEditableHandle(selectedProduct.handle);
        setEditableSeoTitle(selectedProduct.seo?.title || "");
        setEditableMetaDescription(selectedProduct.seo?.description || "");
      } else {
        setEditableTitle(getTranslatedValue("title", currentLanguage, ""));
        setEditableDescription(getTranslatedValue("body_html", currentLanguage, ""));
        setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
        setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
        setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
      }
      setHasChanges(false);
    }
  }, [selectedProduct?.id, currentLanguage, loadedTranslations]);

  // Track changes
  useEffect(() => {
    if (selectedProduct) {
      const getOriginalValue = (key: string, fallback: string) => {
        if (currentLanguage === primaryLocale) {
          return fallback;
        }
        return getTranslatedValue(key, currentLanguage, "");
      };

      const titleChanged = editableTitle !== getOriginalValue("title", selectedProduct.title);
      const descChanged = editableDescription !== getOriginalValue("body_html", selectedProduct.descriptionHtml || "");
      const handleChanged = editableHandle !== getOriginalValue("handle", selectedProduct.handle);
      const seoTitleChanged = editableSeoTitle !== getOriginalValue("seo_title", selectedProduct.seo?.title || "");
      const metaDescChanged = editableMetaDescription !== getOriginalValue("seo_description", selectedProduct.seo?.description || "");

      setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
    }
  }, [editableTitle, editableDescription, editableHandle, editableSeoTitle, editableMetaDescription, selectedProduct, currentLanguage]);

  // Check if field is translated
  const isFieldTranslated = (key: string) => {
    if (currentLanguage === primaryLocale) return true;
    if (!selectedProduct) return false;

    // Check loaded translations state
    const itemKey = `${selectedProduct.id}_${currentLanguage}`;
    const translations = loadedTranslations[itemKey] || selectedProduct.translations || [];

    const translation = translations.find(
      (t: any) => t.key === key && t.locale === currentLanguage
    );

    return !!translation && !!translation.value;
  };

  const getFieldBackgroundColor = (key: string) => {
    if (currentLanguage === primaryLocale) return "white";
    return isFieldTranslated(key) ? "white" : "#fff4e5";
  };

  return {
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
    hasChanges,
    getTranslatedValue,
    isFieldTranslated,
    getFieldBackgroundColor,
  };
}

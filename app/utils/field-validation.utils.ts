import { isThemeContentType } from "~/utils/content-type-groups";
import { useMemo } from "react";
import type { TranslatableItem, Translation, ContentType, ShopLocale, ContentImage } from "~/types/content-editor.types";
import {
  FIELD_CONFIGS,
  UI_FIELD_TO_TRANSLATION_KEY,
  FIELD_TO_LABEL_KEY,
  isMetaobjectLabelField,
} from "~/constants/shopifyFields";
import { TIMING } from "~/constants/timing";
import { PULSE_SYNC_EPOCH } from "~/utils/contentEditor.utils";
import { extractReadableName } from "~/utils/templates-field-factory";

// ============================================================================
// Overlay Types
// ============================================================================

/**
 * Snapshot of the ref overlays from useUiDataLoader.
 * Pass into validation functions so markers stay in sync with the editor
 * without waiting for Shopify revalidation.
 *
 * All fields are optional — omitting them falls back to item data only.
 */
export interface ValidationOverlays {
  /** savedPrimaryValuesRef.current[item.id] — UI fieldKey → value for this item */
  savedPrimaryValues?: Record<string, string>;
  /** localTranslationsRef.current — translationKey → locale → value */
  localTranslations?: Record<string, Record<string, string>>;
  /** deletedTranslationKeysRef.current */
  deletedKeys?: Set<string>;
}

/** Maps Shopify translation keys to editor UI field keys stored in savedPrimaryValuesRef */
const TRANSLATION_KEY_TO_FIELD_KEY: Record<string, string> = {
  title: 'title',
  body_html: 'description',
  body: 'description',
  handle: 'handle',
  meta_title: 'seoTitle',
  meta_description: 'metaDescription',
  product_type: 'productType',
  summary_html: 'summary',
};

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Get field value from item, supporting nested paths (e.g., 'seo.title')
 */
function getFieldValue(item: TranslatableItem | null, fieldPath: string): string {
  if (!item) return '';

  const parts = fieldPath.split('.');
  let value: unknown = item;

  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return '';
    }
    value = (value as Record<string, unknown>)[part];
  }

  if (value === undefined || value === null) {
    return '';
  }

  return typeof value === 'string' ? value : '';
}

/**
 * Check if a field value is empty (null, undefined, or whitespace only)
 */
function isFieldEmpty(value: string): boolean {
  return !value || (typeof value === 'string' && value.trim() === '');
}

/**
 * Check if item has any missing required fields
 */
function hasAnyFieldMissing(
  item: TranslatableItem | null,
  fields: readonly string[]
): boolean {
  if (!item) return false;

  return fields.some(field => {
    const value = getFieldValue(item, field);
    return isFieldEmpty(value);
  });
}

/**
 * Check if primary locale has content for a specific field.
 * Checks savedPrimaryValues overlay first, then falls back to item data.
 */
function primaryHasFieldContent(
  item: TranslatableItem | null,
  field: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  if (!item) return false;

  // Check saved primary overlay (uses UI field key, not translation key)
  if (overlays?.savedPrimaryValues !== undefined) {
    const uiFieldKey = TRANSLATION_KEY_TO_FIELD_KEY[field] ?? field;
    const overlayValue = overlays.savedPrimaryValues[uiFieldKey];
    if (overlayValue !== undefined) {
      return !isFieldEmpty(overlayValue);
    }
  }

  // Map translation key to actual field path on item
  const fieldPathMap: Record<string, string> = {
    title: 'title',
    body_html: contentType === 'collections' || contentType === 'products' ? 'descriptionHtml' : 'body',
    body: 'body',
    handle: 'handle',
    meta_title: 'seo.title',
    meta_description: 'seo.description',
    product_type: 'productType',
    summary_html: 'summary',
  };

  const fieldPath = fieldPathMap[field] || field;
  const value = getFieldValue(item, fieldPath);
  return !isFieldEmpty(value);
}

/**
 * Check if a specific locale has a translation for a field.
 * Checks deletedKeys and localTranslations overlays before falling back to item data.
 */
function hasTranslationForField(
  item: TranslatableItem | null,
  field: string,
  locale: string,
  overlays?: ValidationOverlays
): boolean {
  if (!item) return false;

  // 1. Deleted keys — user explicitly cleared this field
  if (overlays?.deletedKeys?.has(field)) return false;

  // 2. Local translation overlay (from AI translate or saved foreign locale)
  const localValue = overlays?.localTranslations?.[field]?.[locale];
  if (localValue !== undefined) return !isFieldEmpty(localValue);

  // 3. Server data
  const translations = item.translations?.filter(t => t.locale === locale) || [];
  const translation = translations.find(t => t.key === field);
  return !!translation && !isFieldEmpty(translation.value);
}

/**
 * Get required translation fields for content type
 * Note: For templates, returns empty array as templates have dynamic fields
 * handled separately in hasPrimaryContentMissing and hasLocaleMissingTranslations
 */
function getRequiredFieldsForContentType(contentType: ContentType, item?: TranslatableItem | null): string[] {
  if (isThemeContentType(contentType) || contentType === 'metaobjects') {
    // Templates and metaobjects have dynamic fields in translatableContent/fields
    // The validation is handled separately in the calling functions
    return [];
  } else if (contentType === 'collections') {
    return ["title", "body_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'products') {
    return ["title", "body_html", "handle", "product_type", "meta_title", "meta_description"];
  } else if (contentType === 'blogs') {
    // Blog containers (categories) only have title, handle, and SEO — no body or summary
    if (item?.isBlogContainer) {
      return ["title", "handle", "meta_title", "meta_description"];
    }
    // Articles have body_html, summary_html, and SEO fields
    return ["title", "body_html", "summary_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'policies') {
    return ["body"];
  } else if (contentType === 'pages') {
    // meta_title and meta_description are optional (only present if set in Shopify),
    // but included here so translations are flagged when the primary locale has them.
    // The primaryHasFieldContent guard in the caller skips them when empty.
    return ["title", "body_html", "handle", "meta_title", "meta_description"];
  } else {
    return ["title", "body_html", "handle"];
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Check if field is translated
 */
export function isFieldTranslated(
  selectedItem: TranslatableItem | null,
  key: string,
  currentLanguage: string,
  primaryLocale: string
): boolean {
  if (currentLanguage === primaryLocale) return true;
  if (!selectedItem) return false;

  const translations = selectedItem.translations || [];
  const translation = translations.find(
    (t) => t.key === key && t.locale === currentLanguage
  );

  return !!translation && !!translation.value;
}

/**
 * Check if primary locale has any missing content.
 * For templates: checks if any translatableContent entry has empty value.
 * Pass overlays to account for savedPrimaryValues that haven't revalidated yet.
 */
export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  if (!selectedItem) return false;

  // Direct translations: the single source string always exists once the item
  // does, so primary content is never "missing".
  if (contentType === 'directTranslations') return false;

  // Templates have dynamic fields in translatableContent
  if (isThemeContentType(contentType)) {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false;
    }
    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) => {
      // Check overlay first (savedPrimaryValues uses the same key for templates)
      if (overlays?.savedPrimaryValues?.[item.key] !== undefined) {
        return isFieldEmpty(overlays.savedPrimaryValues[item.key]);
      }
      return isFieldEmpty(item.value);
    });
  }

  // Metaobjects have dynamic fields in metaobjects array
  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return false;
    }
    return metaobjects.some((metaobj: any) => {
      const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
      if (!labelField) return true;
      // Check overlay first
      if (overlays?.savedPrimaryValues?.[labelField.key] !== undefined) {
        return isFieldEmpty(overlays.savedPrimaryValues[labelField.key]);
      }
      return isFieldEmpty(labelField.value);
    });
  }

  // For blogs, blog containers don't have body/summary — only check title/handle
  if (contentType === 'blogs') {
    if (selectedItem.isBlogContainer) {
      return hasAnyFieldMissing(selectedItem, ['title', 'handle']);
    }
    return hasAnyFieldMissing(selectedItem, ['title', 'body', 'summary', 'handle', 'seo.title', 'seo.description']);
  }

  // For standard content types, check overlay per field
  // Maps item field paths (from FIELD_CONFIGS) → UI editor field keys (in savedPrimaryValues)
  const FIELD_PATH_TO_UI_KEY: Record<string, string> = {
    title: 'title',
    descriptionHtml: 'description',
    body: 'description',
    handle: 'handle',
    productType: 'productType',
    'seo.title': 'seoTitle',
    'seo.description': 'metaDescription',
    summary: 'summary',
  };

  const requiredFields = FIELD_CONFIGS[contentType];
  return requiredFields.some(fieldPath => {
    if (overlays?.savedPrimaryValues !== undefined) {
      const uiKey = FIELD_PATH_TO_UI_KEY[fieldPath];
      if (uiKey !== undefined) {
        const overlayValue = overlays.savedPrimaryValues[uiKey];
        if (overlayValue !== undefined) return isFieldEmpty(overlayValue);
      }
    }
    return isFieldEmpty(getFieldValue(selectedItem, fieldPath));
  });
}

/**
 * Check if a specific locale has missing translations.
 * Only marks a field as missing if the primary locale has content for that field.
 * Pass overlays to account for local translations that haven't revalidated yet.
 */
export function hasLocaleMissingTranslations(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  if (!selectedItem) return false;

  // Direct translations: a locale is "missing" when the item has no non-empty
  // translation for it. The model is a single source string + one translation
  // per locale (mapped onto Translation[] with a synthetic key). Primary IS a
  // legitimate target here (the source can be in any language and we still
  // need a primary-locale row to serve to primary-locale visitors), so this
  // branch runs BEFORE the `locale === primaryLocale` short-circuit below.
  if (contentType === 'directTranslations') {
    const trs = selectedItem.translations || [];
    return !trs.some((t) => t.locale === locale && !isFieldEmpty(t.value));
  }

  if (locale === primaryLocale) return false;

  // Templates have dynamic fields in translatableContent
  if (isThemeContentType(contentType)) {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false;
    }

    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) => {
      // Primary content: check overlay first
      const primaryValue = overlays?.savedPrimaryValues?.[item.key] ?? item.value;
      if (isFieldEmpty(primaryValue)) return false;
      return !hasTranslationForField(selectedItem, item.key, locale, overlays);
    });
  }

  // Metaobjects have dynamic fields in metaobjects array
  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return false;
    }

    return metaobjects.some((metaobj: any) => {
      const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
      if (!labelField) return false;
      const primaryValue = overlays?.savedPrimaryValues?.[labelField.key] ?? labelField.value;
      if (isFieldEmpty(primaryValue)) return false;
      return !hasTranslationForField(selectedItem, metaobj.id, locale, overlays);
    });
  }

  const requiredFields = getRequiredFieldsForContentType(contentType, selectedItem);

  const hasMissingMainFields = requiredFields.some(field => {
    if (!primaryHasFieldContent(selectedItem, field, contentType, overlays)) return false;
    return !hasTranslationForField(selectedItem, field, locale, overlays);
  });

  // For products, also check product options translations
  if (contentType === 'products' && selectedItem.options && selectedItem.options.length > 0) {
    const subResourceTranslations = selectedItem.subResourceTranslations || {};

    const hasMissingOptionTranslations = selectedItem.options.some(option => {
      // Check if option name translation is missing
      const optionTranslations = subResourceTranslations[option.id] || [];
      const nameTranslation = optionTranslations.find(t => t.key === 'name' && t.locale === locale);

      // If option name exists in primary but translation is missing
      if (option.name && (!nameTranslation || isFieldEmpty(nameTranslation.value))) {
        return true;
      }

      // For non-linked options, also check value translations
      if (!option.isLinked && option.values && option.values.length > 0) {
        return option.values.some((value) => {
          // ProductOptionValue translations are stored under value.id with key="name"
          // (not under option.id with key="value:0", "value:1", etc.)
          if (!value.id) return false; // Skip values without IDs

          const valueTranslations = subResourceTranslations[value.id] || [];
          const valueTranslation = valueTranslations.find(
            t => t.key === 'name' && t.locale === locale
          );

          // If value exists in primary but translation is missing
          return value.name && (!valueTranslation || isFieldEmpty(valueTranslation.value));
        });
      }

      return false;
    });

    if (hasMissingOptionTranslations) {
      return true;
    }
  }

  return hasMissingMainFields;
}

/**
 * Get the list of missing primary content fields (returns field keys, not just boolean).
 * Pass overlays to account for savedPrimaryValues that haven't revalidated yet.
 */
export function getMissingPrimaryFields(
  selectedItem: TranslatableItem | null,
  contentType: ContentType,
  overlays?: ValidationOverlays
): string[] {
  if (!selectedItem) return [];

  // Direct translations: the source string is always present.
  if (contentType === 'directTranslations') return [];

  if (isThemeContentType(contentType)) {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return [];
    }
    return translatableContent
      .filter((item): item is { key: string; value: string } => item != null)
      .filter((item: { key: string; value: string }) => {
        const value = overlays?.savedPrimaryValues?.[item.key] ?? item.value;
        return isFieldEmpty(value);
      })
      .map((item: { key: string; value: string }) => item.key);
  }

  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return [];
    }
    return metaobjects
      .filter((metaobj: any) => {
        const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
        if (!labelField) return true;
        const value = overlays?.savedPrimaryValues?.[labelField.key] ?? labelField.value;
        return isFieldEmpty(value);
      })
      .map((metaobj: any) => metaobj.id);
  }

  // Standard content types
  const FIELD_PATH_TO_UI_KEY: Record<string, string> = {
    title: 'title', descriptionHtml: 'description', body: 'description',
    handle: 'handle', productType: 'productType',
    'seo.title': 'seoTitle', 'seo.description': 'metaDescription', summary: 'summary',
  };
  // Blog containers (categories) only have title/handle — no body or summary
  const requiredFields = (contentType === 'blogs' && selectedItem.isBlogContainer)
    ? (['title', 'handle'] as readonly string[])
    : FIELD_CONFIGS[contentType];
  return requiredFields.filter(fieldPath => {
    if (overlays?.savedPrimaryValues !== undefined) {
      const uiKey = FIELD_PATH_TO_UI_KEY[fieldPath];
      if (uiKey !== undefined) {
        const overlayValue = overlays.savedPrimaryValues[uiKey];
        if (overlayValue !== undefined) return isFieldEmpty(overlayValue);
      }
    }
    return isFieldEmpty(getFieldValue(selectedItem, fieldPath));
  });
}

/**
 * Get the list of missing translation fields for a specific locale (returns field keys, not just boolean).
 * Pass overlays to account for local translations that haven't revalidated yet.
 */
export function getMissingLocaleTranslationFields(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): string[] {
  if (!selectedItem) return [];

  // Direct translations: one synthetic "field" (the source string). Same as
  // hasLocaleMissingTranslations — primary is a legitimate target, run this
  // branch BEFORE the locale===primary short-circuit.
  if (contentType === 'directTranslations') {
    const trs = selectedItem.translations || [];
    const has = trs.some((t) => t.locale === locale && !isFieldEmpty(t.value));
    return has ? [] : [(selectedItem as { sourceText?: string }).sourceText || 'translation'];
  }

  if (locale === primaryLocale) return [];

  if (isThemeContentType(contentType)) {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return [];
    }
    return translatableContent
      .filter((item): item is { key: string; value: string } => item != null)
      .filter((item: { key: string; value: string }) => {
        const primaryValue = overlays?.savedPrimaryValues?.[item.key] ?? item.value;
        if (isFieldEmpty(primaryValue)) return false;
        return !hasTranslationForField(selectedItem, item.key, locale, overlays);
      })
      .map((item: { key: string; value: string }) => item.key);
  }

  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return [];
    }
    return metaobjects
      .filter((metaobj: any) => {
        const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
        if (!labelField) return false;
        const primaryValue = overlays?.savedPrimaryValues?.[labelField.key] ?? labelField.value;
        if (isFieldEmpty(primaryValue)) return false;
        return !hasTranslationForField(selectedItem, metaobj.id, locale, overlays);
      })
      .map((metaobj: any) => metaobj.id);
  }

  const requiredFields = getRequiredFieldsForContentType(contentType, selectedItem);
  const missingFields = requiredFields.filter(field => {
    if (!primaryHasFieldContent(selectedItem, field, contentType, overlays)) return false;
    return !hasTranslationForField(selectedItem, field, locale, overlays);
  });

  // For products, also check product options translations
  if (contentType === 'products' && selectedItem.options && selectedItem.options.length > 0) {
    const subResourceTranslations = selectedItem.subResourceTranslations || {};

    selectedItem.options.forEach((option, optionIndex) => {
      // Check if option name translation is missing
      const optionTranslations = subResourceTranslations[option.id] || [];
      const nameTranslation = optionTranslations.find(t => t.key === 'name' && t.locale === locale);

      // If option name exists in primary but translation is missing
      if (option.name && (!nameTranslation || isFieldEmpty(nameTranslation.value))) {
        missingFields.push(`option_${optionIndex + 1}_name`);
      }

      // For non-linked options, also check value translations
      if (!option.isLinked && option.values && option.values.length > 0) {
        const missingValueIndices: number[] = [];
        option.values.forEach((value, valueIndex) => {
          // ProductOptionValue translations are stored under value.id with key="name"
          // (not under option.id with key="value:0", "value:1", etc.)
          if (!value.id) return; // Skip values without IDs (shouldn't happen but safety check)

          const valueTranslations = subResourceTranslations[value.id] || [];
          const valueTranslation = valueTranslations.find(
            t => t.key === 'name' && t.locale === locale
          );

          // If value exists in primary but translation is missing
          if (value.name && (!valueTranslation || isFieldEmpty(valueTranslation.value))) {
            missingValueIndices.push(valueIndex + 1);
          }
        });

        // Add a summary entry for missing values
        if (missingValueIndices.length > 0) {
          missingFields.push(`option_${optionIndex + 1}_values`);
        }
      }
    });
  }

  return missingFields;
}

/**
 * Get tooltip text for a locale button listing missing fields.
 * Returns null if nothing is missing (no tooltip needed).
 *
 * @param i18n - Translation strings from common.fieldLabels / common.missingContent / common.missingTranslations
 */
export function getLocaleButtonTooltip(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType,
  isLoadingData: boolean = false,
  i18n?: {
    missingContent: string;
    missingTranslations: string;
    fieldLabels: Record<string, string>;
  },
  overlays?: ValidationOverlays
): string | null {
  if (isLoadingData || !selectedItem) return null;

  let missingFields: string[];
  let prefix: string;

  if (locale.primary) {
    missingFields = getMissingPrimaryFields(selectedItem, contentType, overlays);
    prefix = i18n?.missingContent ?? 'Missing content:';
  } else {
    missingFields = getMissingLocaleTranslationFields(
      selectedItem, locale.locale, primaryLocale, contentType, overlays
    );
    prefix = i18n?.missingTranslations ?? 'Missing translations:';
  }

  if (missingFields.length === 0) return null;

  const fieldLabels = i18n?.fieldLabels ?? {};
  const labels = missingFields.map(key => {
    if (isThemeContentType(contentType)) {
      return extractReadableName(key);
    }

    // Metaobjects: resolve metaobject ID to its display name
    if (contentType === 'metaobjects') {
      const metaobjects = (selectedItem as any).metaobjects;
      if (metaobjects && Array.isArray(metaobjects)) {
        const metaobj = metaobjects.find((m: any) => m.id === key);
        if (metaobj) {
          return metaobj.displayName || metaobj.handle || key.split('/').pop() || key;
        }
      }
      return key.split('/').pop() || key;
    }

    // Handle product option fields (e.g., "option_1_name", "option_2_values")
    if (key.startsWith('option_')) {
      const match = key.match(/^option_(\d+)_(name|values)$/);
      if (match) {
        const optionNumber = match[1];
        const fieldType = match[2];
        const templateKey = fieldType === 'name' ? 'optionName' : 'optionValues';
        const template = fieldLabels[templateKey] || (fieldType === 'name' ? 'Option {number} name' : 'Option {number} values');
        return template.replace('{number}', optionNumber);
      }
    }

    const labelKey = FIELD_TO_LABEL_KEY[key];
    return (labelKey && fieldLabels[labelKey]) || labelKey || key;
  });
  // Deduplicate (e.g. 'body' and 'body_html' both map to 'description')
  const unique = [...new Set(labels)];
  return `${prefix} ${unique.join(', ')}`;
}

/**
 * Whether the image has an alt-text translation for the given locale.
 * `liveValue` is the working value from `state.imageAltTexts[index]` for the
 * active locale — pass it so unsaved edits are reflected immediately.
 */
export function isAltTextTranslated(
  image: ContentImage | null | undefined,
  locale: string,
  primaryLocale: string,
  liveValue?: string
): boolean {
  if (locale === primaryLocale) return true;
  if (!image) return false;
  if (liveValue !== undefined) return !isFieldEmpty(liveValue);
  const t = image.altTextTranslations?.find(t => t.locale === locale);
  return !!t && !isFieldEmpty(t.altText);
}

/**
 * Whether the primary alt-text exists but at least one foreign enabled locale
 * is missing its translation. Only meaningful while viewing the primary locale.
 */
export function hasAltTextMissingTranslations(
  image: ContentImage | null | undefined,
  shopLocales: ShopLocale[],
  primaryLocale: string,
  primaryLiveValue?: string
): boolean {
  if (!image) return false;
  const primaryValue = primaryLiveValue !== undefined ? primaryLiveValue : (image.altText ?? '');
  if (isFieldEmpty(primaryValue)) return false;
  return shopLocales
    .filter(l => !l.primary && l.locale !== primaryLocale)
    .some(l => !isAltTextTranslated(image, l.locale, primaryLocale));
}

/**
 * Check if any foreign locale has missing translations
 */
export function hasMissingTranslations(
  selectedItem: TranslatableItem | null,
  shopLocales: ShopLocale[],
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  const primaryLocale = shopLocales.find(l => l.primary)?.locale || "en";
  const foreignLocales = shopLocales.filter(l => !l.primary);

  return foreignLocales.some(locale =>
    hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType)
  );
}

/**
 * Check if a specific field has missing translations in any foreign locale
 * Only returns true if:
 * 1. The primary locale has content for this field
 * 2. At least one foreign locale is missing translation for this field
 */
export function hasFieldMissingTranslations(
  selectedItem: TranslatableItem | null,
  fieldKey: string,
  shopLocales: ShopLocale[],
  primaryLocale: string,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  if (!selectedItem) return false;

  const translationKey = UI_FIELD_TO_TRANSLATION_KEY[fieldKey] || fieldKey;
  const foreignLocales = shopLocales.filter(l => !l.primary);

  // Templates store primary content in translatableContent, not top-level properties
  if (isThemeContentType(contentType)) {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent)) return false;
    const tcEntry = translatableContent.find(
      (tc: { key: string; value: string }) => tc?.key === translationKey
    );
    const primaryValue = overlays?.savedPrimaryValues?.[translationKey] ?? tcEntry?.value;
    if (!primaryValue || isFieldEmpty(primaryValue)) return false;
    return foreignLocales.some(locale =>
      !hasTranslationForField(selectedItem, translationKey, locale.locale, overlays)
    );
  }

  if (!primaryHasFieldContent(selectedItem, translationKey, contentType, overlays)) {
    return false;
  }

  return foreignLocales.some(locale =>
    !hasTranslationForField(selectedItem, translationKey, locale.locale, overlays)
  );
}

/**
 * Get button style for locale navigation
 * Shows pulsing border animation when translations are missing
 * @deprecated Use useLocaleButtonStyle hook instead for better performance
 */
export function getLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType
): React.CSSProperties {
  const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
  const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

  if (primaryContentMissing || foreignTranslationMissing) {
    const pulseDuration = TIMING.HIGHLIGHT_DURATION_MS;
    const syncOffset = (Date.now() - PULSE_SYNC_EPOCH) % pulseDuration;
    const isOrange = primaryContentMissing;
    const fadeIn = isOrange ? 'pulseFadeIn' : 'pulseBlueFadeIn';
    const pulse = isOrange ? 'pulse' : 'pulseBlue';

    return {
      animation: `${fadeIn} 500ms ease-out forwards, ${pulse} ${pulseDuration}ms ease-in-out infinite`,
      animationDelay: `0s, -${syncOffset}ms`,
      borderRadius: "8px",
    };
  }

  return {};
}

/**
 * Hook: Get button style for locale navigation with memoization.
 * Shows pulsing border animation when translations are missing.
 * Pass overlays + overlaysVersion to stay in sync with the editor's overlay state.
 */
export function useLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType,
  isLoadingData: boolean = false,
  overlays?: ValidationOverlays,
  overlaysVersion?: number
): React.CSSProperties {
  // Track translations length separately so the memo recalculates when
  // item.translations changes length (e.g. after Accept & Translate before revalidation).
  const translationsLength = selectedItem?.translations?.length ?? 0;

  return useMemo(() => {
    if (isLoadingData) return {};

    const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType, overlays);
    const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType, overlays);

    if (primaryContentMissing || foreignTranslationMissing) {
      const pulseDuration = TIMING.HIGHLIGHT_DURATION_MS;
      const syncOffset = (Date.now() - PULSE_SYNC_EPOCH) % pulseDuration;
      const isOrange = primaryContentMissing;
      const fadeIn = isOrange ? 'pulseFadeIn' : 'pulseBlueFadeIn';
      const pulse = isOrange ? 'pulse' : 'pulseBlue';

      return {
        animation: `${fadeIn} 500ms ease-out forwards, ${pulse} ${pulseDuration}ms ease-in-out infinite`,
        animationDelay: `0s, -${syncOffset}ms`,
        borderRadius: "8px",
      };
    }

    return {};
    // overlaysVersion is intentionally included so the memo re-runs when overlays change,
    // even though overlays object reference is stable (it's a ref snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, selectedItem, primaryLocale, contentType, isLoadingData, translationsLength, overlays, overlaysVersion]);
}

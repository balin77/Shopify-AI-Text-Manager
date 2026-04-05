import { useMemo } from "react";
import type { TranslatableItem, Translation, ContentType, ShopLocale } from "~/types/content-editor.types";
import {
  FIELD_CONFIGS,
  UI_FIELD_TO_TRANSLATION_KEY,
  FIELD_TO_LABEL_KEY,
  isMetaobjectLabelField,
} from "~/constants/shopifyFields";
import { TIMING } from "~/constants/timing";
import { extractReadableName } from "~/utils/templates-field-factory";

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
 * Check if primary locale has content for a specific field
 */
function primaryHasFieldContent(
  item: TranslatableItem | null,
  field: string,
  contentType: ContentType
): boolean {
  if (!item) return false;

  // Map translation key to actual field path
  const fieldPathMap: Record<string, string> = {
    title: 'title',
    body_html: contentType === 'collections' || contentType === 'products' ? 'descriptionHtml' : 'body',
    body: 'body',
    handle: 'handle',
    meta_title: 'seo.title',
    meta_description: 'seo.description',
    product_type: 'productType',
    summary_html: 'summary', // Article excerpt/summary
  };

  const fieldPath = fieldPathMap[field] || field;
  const value = getFieldValue(item, fieldPath);
  return !isFieldEmpty(value);
}

/**
 * Check if a specific locale has a translation for a field
 */
function hasTranslationForField(
  item: TranslatableItem | null,
  field: string,
  locale: string
): boolean {
  if (!item) return false;

  const translations = item.translations?.filter(t => t.locale === locale) || [];
  const translation = translations.find(t => t.key === field);
  return !!translation && !isFieldEmpty(translation.value);
}

/**
 * Get required translation fields for content type
 * Note: For templates, returns empty array as templates have dynamic fields
 * handled separately in hasPrimaryContentMissing and hasLocaleMissingTranslations
 */
function getRequiredFieldsForContentType(contentType: ContentType): string[] {
  if (contentType === 'templates' || contentType === 'metaobjects') {
    // Templates and metaobjects have dynamic fields in translatableContent/fields
    // The validation is handled separately in the calling functions
    return [];
  } else if (contentType === 'collections') {
    return ["title", "body_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'products') {
    return ["title", "body_html", "handle", "product_type", "meta_title", "meta_description"];
  } else if (contentType === 'blogs') {
    // Articles have body_html, summary_html, and SEO fields
    return ["title", "body_html", "summary_html", "handle", "meta_title", "meta_description"];
  } else if (contentType === 'policies') {
    return ["body"];
  } else {
    // pages and other content types
    return ["title", "body_html", "handle"];
  }
}

// ============================================================================
// Module-level reference point for synchronizing all pulse animations across
// buttons. A negative animation-delay calculated from this epoch ensures every
// button starts at the correct phase of the shared pulse cycle, even when
// animations restart at different times.
// ============================================================================
const PULSE_SYNC_EPOCH = Date.now();

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
 * Check if primary locale has any missing content
 * For templates: checks if any translatableContent entry has empty value
 */
export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null,
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  // Templates have dynamic fields in translatableContent
  if (contentType === 'templates') {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false; // No content to check
    }
    // Check if any translatableContent entry has empty value
    // Filter out null/undefined items to prevent "Cannot read properties of null" errors
    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) =>
      isFieldEmpty(item.value)
    );
  }

  // Metaobjects have dynamic fields in metaobjects array
  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return false;
    }
    // Check if any metaobject entry has an empty label field (display_name/name/label)
    return metaobjects.some((metaobj: any) => {
      const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
      return !labelField || isFieldEmpty(labelField.value);
    });
  }

  const requiredFields = FIELD_CONFIGS[contentType];
  return hasAnyFieldMissing(selectedItem, requiredFields);
}

/**
 * Check if a specific locale has missing translations
 * Only marks a field as missing if the primary locale has content for that field
 * For templates: checks translations for dynamic translatableContent fields
 * For products: also checks product options translations
 */
export function hasLocaleMissingTranslations(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType
): boolean {
  if (!selectedItem || locale === primaryLocale) return false;

  // Templates have dynamic fields in translatableContent
  if (contentType === 'templates') {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return false; // No content to check
    }

    const translations = selectedItem.translations || [];

    // Check if any translatableContent entry with a value is missing a translation
    // Filter out null/undefined items to prevent "Cannot read properties of null" errors
    return translatableContent.filter((item) => item != null).some((item: { key: string; value: string }) => {
      // Only check if primary has content for this field
      if (isFieldEmpty(item.value)) {
        return false;
      }
      // Check if translation exists for this locale
      const translation = translations.find(
        (t: Translation) => t.key === item.key && t.locale === locale
      );
      return !translation || isFieldEmpty(translation.value);
    });
  }

  // Metaobjects have dynamic fields in metaobjects array
  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return false;
    }

    const translations = selectedItem.translations || [];

    // Check if any metaobject entry with primary content is missing a translation
    return metaobjects.some((metaobj: any) => {
      const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
      // Only check if primary has content for this entry
      if (!labelField || isFieldEmpty(labelField.value)) {
        return false;
      }
      // Check if translation exists for this locale (key = metaobject ID)
      const translation = translations.find(
        (t: Translation) => t.key === metaobj.id && t.locale === locale
      );
      return !translation || isFieldEmpty(translation.value);
    });
  }

  const requiredFields = getRequiredFieldsForContentType(contentType);

  const hasMissingMainFields = requiredFields.some(field => {
    // Skip handle field - Shopify often doesn't return translations for handles
    // that are identical to the primary locale, so we ignore it in validation
    if (field === 'handle') {
      return false;
    }

    // Only check if primary has content
    if (!primaryHasFieldContent(selectedItem, field, contentType)) {
      return false;
    }

    // Check if translation exists
    return !hasTranslationForField(selectedItem, field, locale);
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
 * Get the list of missing primary content fields (returns field keys, not just boolean)
 */
export function getMissingPrimaryFields(
  selectedItem: TranslatableItem | null,
  contentType: ContentType
): string[] {
  if (!selectedItem) return [];

  if (contentType === 'templates') {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return [];
    }
    return translatableContent
      .filter((item): item is { key: string; value: string } => item != null)
      .filter((item: { key: string; value: string }) => isFieldEmpty(item.value))
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
        return !labelField || isFieldEmpty(labelField.value);
      })
      .map((metaobj: any) => metaobj.id);
  }

  const requiredFields = FIELD_CONFIGS[contentType];
  return requiredFields.filter(field => {
    const value = getFieldValue(selectedItem, field);
    return isFieldEmpty(value);
  });
}

/**
 * Get the list of missing translation fields for a specific locale (returns field keys, not just boolean)
 */
export function getMissingLocaleTranslationFields(
  selectedItem: TranslatableItem | null,
  locale: string,
  primaryLocale: string,
  contentType: ContentType
): string[] {
  if (!selectedItem || locale === primaryLocale) return [];

  if (contentType === 'templates') {
    const translatableContent = selectedItem.translatableContent;
    if (!translatableContent || !Array.isArray(translatableContent) || translatableContent.length === 0) {
      return [];
    }
    const translations = selectedItem.translations || [];
    return translatableContent
      .filter((item): item is { key: string; value: string } => item != null)
      .filter((item: { key: string; value: string }) => {
        if (isFieldEmpty(item.value)) return false;
        const translation = translations.find(
          (t: Translation) => t.key === item.key && t.locale === locale
        );
        return !translation || isFieldEmpty(translation.value);
      })
      .map((item: { key: string; value: string }) => item.key);
  }

  if (contentType === 'metaobjects') {
    const metaobjects = (selectedItem as any).metaobjects;
    if (!metaobjects || !Array.isArray(metaobjects) || metaobjects.length === 0) {
      return [];
    }
    const translations = selectedItem.translations || [];
    return metaobjects
      .filter((metaobj: any) => {
        const labelField = metaobj.fields?.find((f: any) => isMetaobjectLabelField(f.key));
        // Only check if primary has content
        if (!labelField || isFieldEmpty(labelField.value)) return false;
        // Check if translation exists for this locale
        const translation = translations.find(
          (t: Translation) => t.key === metaobj.id && t.locale === locale
        );
        return !translation || isFieldEmpty(translation.value);
      })
      .map((metaobj: any) => metaobj.id);
  }

  const requiredFields = getRequiredFieldsForContentType(contentType);
  const missingFields = requiredFields.filter(field => {
    if (field === 'handle') return false;
    if (!primaryHasFieldContent(selectedItem, field, contentType)) return false;
    return !hasTranslationForField(selectedItem, field, locale);
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
  }
): string | null {
  if (isLoadingData || !selectedItem) return null;

  let missingFields: string[];
  let prefix: string;

  if (locale.primary) {
    missingFields = getMissingPrimaryFields(selectedItem, contentType);
    prefix = i18n?.missingContent ?? 'Missing content:';
  } else {
    missingFields = getMissingLocaleTranslationFields(
      selectedItem, locale.locale, primaryLocale, contentType
    );
    prefix = i18n?.missingTranslations ?? 'Missing translations:';
  }

  if (missingFields.length === 0) return null;

  const fieldLabels = i18n?.fieldLabels ?? {};
  const labels = missingFields.map(key => {
    if (contentType === 'templates') {
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
  contentType: ContentType
): boolean {
  if (!selectedItem) return false;

  // Skip handle field - Shopify often doesn't return translations for handles
  // that are identical to the primary locale, so we ignore it in validation
  if (fieldKey === 'handle') {
    return false;
  }

  // Map UI field names to translation keys
  const translationKey = UI_FIELD_TO_TRANSLATION_KEY[fieldKey] || fieldKey;

  // Check if primary locale has content for this field
  if (!primaryHasFieldContent(selectedItem, translationKey, contentType)) {
    return false;
  }

  // Check if any foreign locale is missing this specific translation
  const foreignLocales = shopLocales.filter(l => !l.primary);

  return foreignLocales.some(locale => {
    return !hasTranslationForField(selectedItem, translationKey, locale.locale);
  });
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
 * Hook: Get button style for locale navigation with memoization
 * Shows pulsing border animation when translations are missing
 * This hook provides better performance than getLocaleButtonStyle by memoizing the result
 */
export function useLocaleButtonStyle(
  locale: ShopLocale,
  selectedItem: TranslatableItem | null,
  primaryLocale: string,
  contentType: ContentType,
  isLoadingData: boolean = false
): React.CSSProperties {
  // Track translations length separately so the memo recalculates when
  // item.translations is mutated in-place (e.g. after Accept & Translate).
  // Without this, useMemo sees the same selectedItem reference and returns
  // a stale pulsing state even though translations were added.
  const translationsLength = selectedItem?.translations?.length ?? 0;

  return useMemo(() => {
    // Don't show blinking animations while data is still loading
    if (isLoadingData) {
      return {};
    }

    const primaryContentMissing = locale.primary && hasPrimaryContentMissing(selectedItem, contentType);
    const foreignTranslationMissing = !locale.primary && hasLocaleMissingTranslations(selectedItem, locale.locale, primaryLocale, contentType);

    if (primaryContentMissing || foreignTranslationMissing) {
      // Synchronize all pulse animations to a shared reference point (PULSE_SYNC_EPOCH).
      // A negative delay starts the animation mid-cycle at the correct phase,
      // so all buttons pulse in lockstep even when animations restart at different times.
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
  }, [locale, selectedItem, primaryLocale, contentType, isLoadingData, translationsLength]);
}

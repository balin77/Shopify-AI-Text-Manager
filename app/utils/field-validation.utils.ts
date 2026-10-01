import { isThemeContentType } from "~/utils/content-type-groups";
import { useMemo } from "react";
import type { TranslatableItem, Translation, ContentType, ShopLocale, ContentImage } from "~/types/content-editor.types";
import {
  FIELD_CONFIGS,
  UI_FIELD_TO_TRANSLATION_KEY,
  FIELD_TO_LABEL_KEY,
  isMetaobjectLabelField,
} from "~/constants/shopifyFields";
import {
  metaobjectFieldKey,
  metaobjectTranslatableFields,
  type MetaobjectDefinitionFieldLike,
  type MetaobjectEntryLike,
} from "~/services/metaobject-fields.shared";
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
/**
 * Does this metaobject TYPE translate at all?
 *
 * Three-valued, and only a KNOWN false answers no. A definition whose
 * Translations capability is switched off has no per-locale form for any of
 * its fields, so counting them as missing would keep the language buttons
 * pulsing on a shop where nothing CAN be translated — and the write path would
 * refuse the register for want of a digest, so the merchant could not clear it
 * either. `null`/`undefined` is UNKNOWN and keeps counting: hiding a real
 * missing translation behind a guess is the worse of the two errors.
 */
function metaobjectTypeTranslates(selectedItem: TranslatableItem | null): boolean {
  const capability = (selectedItem as unknown as { translatableCapability?: boolean | null } | null)
    ?.translatableCapability;
  return capability !== false;
}

export function hasPrimaryContentMissing(
  selectedItem: TranslatableItem | null,
  contentType: ContentType,
  overlays?: ValidationOverlays
): boolean {
  if (!selectedItem) return false;

  // Direct translations: the single source string always exists once the item
  // does, so primary content is never "missing".
  if (contentType === 'directTranslations') return false;

  // Menus: the primary labels are Shopify's own menu item titles, and Shopify
  // will not store a nameless menu item — so a menu can never be MISSING
  // primary content, and the primary locale button must not pulse orange at a
  // merchant who has nothing to fix here. (The page can rename those titles
  // now; that changes who writes them, not whether one can be absent.)
  if (contentType === 'menus') return false;

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
      // NO label field is not missing CONTENT. The label keys are a naming
      // CONVENTION (`display_name` / `name` / `label`), and a definition that
      // names its display field differently is not an empty entry — reporting
      // it as one made the orange pulse permanent for the whole type.
      if (!labelField) return false;
      // The overlay is keyed by the COMPOUND key, like every other editor
      // value; a bare `"label"` lookup never hit and silently fell through to
      // server data, so an entry the merchant had just filled in still counted
      // as empty until the page reloaded.
      const overlayValue = overlays?.savedPrimaryValues?.[metaobjectFieldKey(metaobj.id, labelField.key)];
      if (overlayValue !== undefined) return isFieldEmpty(overlayValue);
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

  // Menus: the caller (app.menus.tsx) collapses a whole menu into ONE synthetic
  // translation per locale, present only when EVERY item of that menu has a
  // translation in it. A menu is a list of independent Link resources with no
  // field config to enumerate, so the completeness verdict is the page's to
  // compute and this helper's only job is to read it. Same shape as the
  // directTranslations branch above, minus the primary locale — which the
  // short-circuit right above has already excluded, because a menu's primary
  // labels come from Shopify and are never a translation target.
  if (contentType === 'menus') {
    const trs = selectedItem.translations || [];
    return !trs.some((t) => t.locale === locale && !isFieldEmpty(t.value));
  }

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

    // Addressed by COMPOUND key. This asked for a translation stored under the
    // bare GID, which nothing has written since the editor learned to edit more
    // than one field per entry — so every entry read as untranslated in every
    // locale and the language buttons pulsed forever on a fully translated shop.
    if (!metaobjectTypeTranslates(selectedItem)) return false;
    return metaobjectTranslatableFields(
      metaobjects,
      (selectedItem as any).fieldDefinitions,
    ).some((field) => {
      const primaryValue = overlays?.savedPrimaryValues?.[field.compoundKey] ?? field.primaryValue;
      if (isFieldEmpty(primaryValue)) return false;
      return !hasTranslationForField(selectedItem, field.compoundKey, locale, overlays);
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
        // Same two rules as the flag above: a definition with no label field
        // is not an empty entry, and the overlay is keyed by the compound key.
        if (!labelField) return false;
        const value =
          overlays?.savedPrimaryValues?.[metaobjectFieldKey(metaobj.id, labelField.key)] ??
          labelField.value;
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
    // Same compound-key rule as above, and the tooltip is where the old bug was
    // VISIBLE: it listed every entry of the type as "missing translations".
    if (!metaobjectTypeTranslates(selectedItem)) return [];
    return metaobjectTranslatableFields(metaobjects, (selectedItem as any).fieldDefinitions)
      .filter((field) => {
        const primaryValue = overlays?.savedPrimaryValues?.[field.compoundKey] ?? field.primaryValue;
        if (isFieldEmpty(primaryValue)) return false;
        return !hasTranslationForField(selectedItem, field.compoundKey, locale, overlays);
      })
      // The COMPOUND key, not a display label: `getLocaleButtonTooltip` splits
      // `<gid>#<fieldKey>` itself to render "Rot / colour". Handing it a label
      // collapsed every missing field of one entry into a single line (so one
      // and five missing fields read alike) and mangled any name containing a
      // slash, which "Rot / Blau" is.
      .map((field) => field.compoundKey);
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
 * Whether one image counts as "has alt text" FOR THE GIVEN LOCALE.
 *
 * Alt-text coverage is per locale, exactly like every other field the SEO score
 * judges: in a foreign language an image is only covered when it has an alt
 * TRANSLATION. Accepting the primary alt as coverage (what the editor sidebar
 * used to do) makes every foreign locale score its image block identically to
 * the primary one — a product whose alt texts were never translated still
 * reports "all images have alt text", while the store-wide audit, which reads
 * ProductImageAltTranslation for the same locale, reports them as missing.
 *
 * `liveValue` is the editor's working value for this image in the ACTIVE locale
 * (`state.imageAltTexts[index]`, already market-resolved by useEditorAltText).
 * When present it wins over the persisted rows, so an unsaved edit counts
 * immediately — and a cleared value counts as missing rather than silently
 * falling back to the stored one.
 */
export function hasAltTextForLocale(
  image: ContentImage | null | undefined,
  locale: string,
  primaryLocale: string,
  liveValue?: string
): boolean {
  if (locale !== primaryLocale) {
    return isAltTextTranslated(image, locale, primaryLocale, liveValue);
  }
  return !isFieldEmpty(liveValue !== undefined ? liveValue : (image?.altText ?? ''));
}

/**
 * How many of `images` have an alt text for `locale` — the `imagesWithAlt`
 * input of computeSeoScore. `liveAltTexts` is `state.imageAltTexts`, keyed by
 * the image's index in this very list (the editor indexes alt-text state by
 * gallery position, falling back to the single featured image at index 0).
 */
export function countImagesWithAltForLocale(
  images: ReadonlyArray<ContentImage | null | undefined>,
  locale: string,
  primaryLocale: string,
  liveAltTexts?: Record<number, string>
): number {
  return images.filter((image, index) =>
    hasAltTextForLocale(image, locale, primaryLocale, liveAltTexts?.[index])
  ).length;
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

  // Metaobjects: the primary value lives in the matching entry's `fields`
  // blob, and both it and its translation are addressed by the COMPOUND key
  // `<gid>#<fieldKey>`. `primaryHasFieldContent`/`getFieldValue` cannot resolve
  // that shape (there is no top-level item property), so it is handled here —
  // mirroring the theme branch above.
  //
  // This had the mirror image of the locale bug: it matched the compound key
  // against an entry ID, so `entry` was always undefined and the per-field
  // marker never appeared at all — even on a field that genuinely had no
  // translation. One key shape, one lookup, both directions right.
  if (contentType === 'metaobjects') {
    if (!metaobjectTypeTranslates(selectedItem)) return false;
    const item = selectedItem as unknown as {
      metaobjects?: MetaobjectEntryLike[];
      fieldDefinitions?: MetaobjectDefinitionFieldLike[];
    };
    const field = metaobjectTranslatableFields(item.metaobjects, item.fieldDefinitions).find(
      (f) => f.compoundKey === translationKey,
    );
    if (!field) return false;
    const primaryValue = overlays?.savedPrimaryValues?.[translationKey] ?? field.primaryValue;
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



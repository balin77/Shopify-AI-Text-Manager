/**
 * UiDataLoader — Centralized data resolution for the content editor
 *
 * Owns all data cache refs and provides a single resolve() function that
 * determines what value should appear in any field, and why.
 *
 * Priority chain:
 *   Primary locale: savedPrimaryCache → itemField → fallback
 *   Foreign locale: deleted → localOverride → itemTranslation → fallback → empty
 */

import { useRef, useState, useCallback } from "react";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import { debugLog } from "../utils/debug";
import type {
  TranslatableContentItem,
  ContentEditorConfig,
  FieldDefinition,
} from "../types/content-editor.types";

// ============================================================================
// TYPES
// ============================================================================

/** Describes where a resolved value came from */
export type ValueSource =
  | "deleted" // deletedTranslationKeysRef had this key → empty
  | "localOverride" // localTranslationsRef had a value
  | "savedPrimaryCache" // savedPrimaryValuesRef had a cached value
  | "itemTranslation" // item.translations had a value
  | "itemField" // Direct item property (primary locale)
  | "fallback" // Fallback value (handle→primary, seoTitle→title)
  | "empty"; // No value found

export interface ResolvedField {
  value: string;
  source: ValueSource;
  isFallback: boolean;
}

export interface DataCacheState {
  localOverrides: Record<string, Record<string, string>>;
  deletedKeys: string[];
  savedPrimaryCache: Record<string, Record<string, string>>;
  originalLoaded: Record<string, string>;
  originalTemplate: Record<string, string>;
}

export interface UseUiDataLoaderProps {
  config: ContentEditorConfig;
  primaryLocale: string;
}

/** Result of a transition — tells the caller what UI updates to make */
export interface TransitionResult {
  /** Updated field values to merge into editableValues (only for fields that changed) */
  updatedValues: Record<string, string> | null;
  /** Field keys that should be removed from the fallback set */
  clearedFallbackKeys: string[];
  /** Whether to set isLoadingData=true (for change detection reset) */
  shouldMarkLoading: boolean;
}

export interface UseUiDataLoaderReturn {
  /** Resolve a single field's display value and source */
  resolve: (
    item: TranslatableContentItem,
    fieldKey: string,
    translationKey: string,
    locale: string
  ) => ResolvedField;

  /** Resolve all fields at once → { values, fallbackFields } */
  resolveAll: (
    item: TranslatableContentItem,
    locale: string,
    fieldDefinitions: FieldDefinition[]
  ) => { values: Record<string, string>; fallbackFields: Set<string> };

  // ── Transition methods (Phase 2) ──────────────────────────────────────────

  /** After a single-field translation (translateField) response */
  onTranslateFieldComplete: (
    fieldKey: string,
    translationKey: string,
    translatedValue: string,
    targetLocale: string,
    currentEditableValues: Record<string, string>
  ) => TransitionResult;

  /** After translateAll response (all fields → all locales) */
  onTranslateAllComplete: (
    translations: Record<string, Record<string, string>>,
    fieldDefinitions: FieldDefinition[],
    currentLocale: string,
    currentEditableValues: Record<string, string>
  ) => TransitionResult;

  /** After translateAllForLocale response (all fields → one locale) */
  onTranslateAllForLocaleComplete: (
    translations: Record<string, string>,
    fieldDefinitions: FieldDefinition[],
    targetLocale: string,
    currentLocale: string,
    currentEditableValues: Record<string, string>
  ) => TransitionResult;

  /** After updateContent response (save completed) */
  onSaveComplete: (
    savedLocale: string,
    editableValues: Record<string, string>,
    fieldDefinitions: FieldDefinition[]
  ) => TransitionResult;

  /** After translateFieldToAllLocales callback (Accept & Translate) */
  onTranslateFieldToAllLocalesComplete: (
    translationKey: string,
    translations: Record<string, string>,
    currentLocale: string
  ) => TransitionResult;

  /** When switching to a different item */
  onItemSwitch: () => void;

  /** When user clicks ReloadButton */
  onRefresh: (itemId: string | null) => void;

  /** Direct ref accessors for mutation by existing code (backward compat) */
  refs: {
    localTranslationsRef: React.MutableRefObject<
      Record<string, Record<string, string>>
    >;
    deletedTranslationKeysRef: React.MutableRefObject<Set<string>>;
    savedPrimaryValuesRef: React.MutableRefObject<
      Record<string, Record<string, string>>
    >;
    originalLoadedValuesRef: React.MutableRefObject<Record<string, string>>;
    originalTemplateValuesRef: React.MutableRefObject<Record<string, string>>;
  };

  /** Template change-detection version counter */
  templateValuesVersion: number;
  setTemplateValuesVersion: React.Dispatch<React.SetStateAction<number>>;

  /** Read-only snapshot for debugging */
  getDebugState: () => DataCacheState;
}

// ============================================================================
// HELPER — Get a field's value from an item's primary content
// ============================================================================

/**
 * Gets the primary-locale value for a field from the item object.
 * Supports standard content types (title, description, etc.) and
 * template/dynamic fields via config.getFieldValue or translatableContent.
 */
export function getItemFieldValue(
  item: TranslatableContentItem,
  fieldKey: string,
  primaryLocale: string,
  config?: ContentEditorConfig
): string {
  // Templates: Use custom getter if available
  if (config?.getFieldValue) {
    return config.getFieldValue(item, fieldKey);
  }

  // Templates: Check translatableContent array
  if (item?.translatableContent && Array.isArray(item.translatableContent)) {
    const content = item.translatableContent.find(
      (c: { key: string; value: string }) => c != null && c.key === fieldKey
    );
    return content?.value || "";
  }

  // Standard content types: Common field mappings
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || item.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
    summary: item.summary || "",
    productType: item.productType || "",
  };

  return fieldMappings[fieldKey] || "";
}

// ============================================================================
// HOOK
// ============================================================================

export function useUiDataLoader(
  props: UseUiDataLoaderProps
): UseUiDataLoaderReturn {
  const { config, primaryLocale } = props;

  // ---------------------------------------------------------------------------
  // DATA CACHE REFS (moved from useUnifiedContentEditor)
  // ---------------------------------------------------------------------------

  /** Track deleted translation keys — show empty even if revalidation brings them back */
  const deletedTranslationKeysRef = useRef<Set<string>>(new Set());

  /** Local translation overrides from Accept & Translate / translateFieldToAllLocales.
   *  Survives revalidation (items array replacement). Format: Record<translationKey, Record<locale, value>> */
  const localTranslationsRef = useRef<
    Record<string, Record<string, string>>
  >({});

  /** Saved primary-locale values per item ID. Survives revalidation after primary locale save.
   *  Cleared when server data catches up or on manual reload. */
  const savedPrimaryValuesRef = useRef<
    Record<string, Record<string, string>>
  >({});

  /** Baseline of loaded values for foreign-locale change detection.
   *  Prevents re-sending unchanged fields like handle on every save. */
  const originalLoadedValuesRef = useRef<Record<string, string>>({});

  /** Original template values for template-specific change detection. */
  const originalTemplateValuesRef = useRef<Record<string, string>>({});

  /** State counter to force templateHasFieldChanges useMemo recalculation when ref updates */
  const [templateValuesVersion, setTemplateValuesVersion] = useState(0);

  // ---------------------------------------------------------------------------
  // RESOLVE — Single field
  // ---------------------------------------------------------------------------

  const resolve = useCallback(
    (
      item: TranslatableContentItem,
      fieldKey: string,
      translationKey: string,
      locale: string
    ): ResolvedField => {
      // ---- PRIMARY LOCALE ----
      if (locale === primaryLocale) {
        // 1. Check savedPrimaryCache
        const savedOverride = savedPrimaryValuesRef.current[item.id];
        if (savedOverride && savedOverride[fieldKey] !== undefined) {
          return {
            value: savedOverride[fieldKey],
            source: "savedPrimaryCache",
            isFallback: false,
          };
        }

        // 2. Item field value
        const value = getItemFieldValue(item, fieldKey, primaryLocale, config);

        // 3. Detect seoTitle fallback
        if (fieldKey === "seoTitle") {
          const actualSeoTitle = item.seo?.title;
          if (!actualSeoTitle && item.title) {
            return { value, source: "fallback", isFallback: true };
          }
        }

        return { value, source: "itemField", isFallback: false };
      }

      // ---- FOREIGN LOCALE ----

      // 1. Deleted keys → empty
      if (deletedTranslationKeysRef.current.has(translationKey)) {
        return { value: "", source: "deleted", isFallback: false };
      }

      // 2. Local overrides (Accept & Translate, translateFieldToAllLocales)
      const localValue =
        localTranslationsRef.current[translationKey]?.[locale];
      if (localValue) {
        return { value: localValue, source: "localOverride", isFallback: false };
      }

      // 3. item.translations
      const translatedValue = getTranslatedValue(
        item,
        translationKey,
        locale,
        "",
        primaryLocale
      );
      if (translatedValue) {
        return {
          value: translatedValue,
          source: "itemTranslation",
          isFallback: false,
        };
      }

      // 4. Fallbacks
      if (fieldKey === "handle" && item.handle) {
        return { value: item.handle, source: "fallback", isFallback: true };
      }
      if (fieldKey === "seoTitle") {
        const translatedTitle = getTranslatedValue(
          item,
          "title",
          locale,
          "",
          primaryLocale
        );
        const fallbackTitle = translatedTitle || item.title || "";
        return { value: fallbackTitle, source: "fallback", isFallback: true };
      }

      // 5. Empty
      return { value: "", source: "empty", isFallback: false };
    },
    [primaryLocale, config]
  );

  // ---------------------------------------------------------------------------
  // RESOLVE ALL — All fields at once
  // ---------------------------------------------------------------------------

  const resolveAll = useCallback(
    (
      item: TranslatableContentItem,
      locale: string,
      fieldDefinitions: FieldDefinition[]
    ): { values: Record<string, string>; fallbackFields: Set<string> } => {
      const values: Record<string, string> = {};
      const fallbackFields = new Set<string>();

      // For primary locale with savedPrimaryValuesRef: check if server caught up
      if (locale === primaryLocale) {
        const savedOverride = savedPrimaryValuesRef.current[item.id];
        if (savedOverride) {
          const serverCaughtUp = fieldDefinitions.every((field) => {
            const serverValue = getItemFieldValue(
              item,
              field.key,
              primaryLocale,
              config
            );
            const savedValue = savedOverride[field.key] ?? "";
            if (
              field.key === "seoTitle" &&
              savedValue === "" &&
              serverValue === (item.title || "")
            ) {
              return true;
            }
            return serverValue === savedValue;
          });
          if (serverCaughtUp) {
            debugLog.dataLoad(
              "Server data caught up, clearing saved values override"
            );
            delete savedPrimaryValuesRef.current[item.id];
          }
        }
      }

      for (const field of fieldDefinitions) {
        const resolved = resolve(
          item,
          field.key,
          field.translationKey,
          locale
        );
        values[field.key] = resolved.value;
        if (resolved.isFallback) {
          fallbackFields.add(field.key);
        }
      }

      return { values, fallbackFields };
    },
    [resolve, primaryLocale, config]
  );

  // ---------------------------------------------------------------------------
  // TRANSITIONS — Named state changes with logging
  // ---------------------------------------------------------------------------

  /** After a single-field translation response */
  const onTranslateFieldComplete = useCallback(
    (
      fieldKey: string,
      translationKey: string,
      translatedValue: string,
      targetLocale: string,
      currentEditableValues: Record<string, string>
    ): TransitionResult => {
      debugLog.transition(
        `onTranslateFieldComplete: field=${fieldKey} locale=${targetLocale} value="${translatedValue.substring(0, 40)}..."`
      );

      // 1. Clear deleted key
      if (deletedTranslationKeysRef.current.has(translationKey)) {
        deletedTranslationKeysRef.current.delete(translationKey);
        debugLog.transition(`  cleared deletedKey: ${translationKey}`);
      }

      // 2. Store in localTranslationsRef (overlay — replaces item mutation)
      if (!localTranslationsRef.current[translationKey]) {
        localTranslationsRef.current[translationKey] = {};
      }
      localTranslationsRef.current[translationKey][targetLocale] =
        translatedValue;

      // 3. Compute updated values
      const updatedValues = {
        ...currentEditableValues,
        [fieldKey]: translatedValue,
      };

      // 4. Update originalLoaded baseline
      originalLoadedValuesRef.current = { ...updatedValues };

      // 5. Template change detection
      if (config.contentType === "templates") {
        originalTemplateValuesRef.current = {
          ...originalTemplateValuesRef.current,
          [fieldKey]: translatedValue,
        };
        setTemplateValuesVersion((v) => v + 1);
      }

      return {
        updatedValues,
        clearedFallbackKeys: [fieldKey],
        shouldMarkLoading: true,
      };
    },
    [config.contentType, setTemplateValuesVersion]
  );

  /** After translateAll response (all fields → all locales) */
  const onTranslateAllComplete = useCallback(
    (
      translations: Record<string, Record<string, string>>,
      fieldDefinitions: FieldDefinition[],
      currentLocale: string,
      currentEditableValues: Record<string, string>
    ): TransitionResult => {
      const localeCount = Object.keys(translations).length;
      debugLog.transition(
        `onTranslateAllComplete: ${localeCount} locales, viewing=${currentLocale}`
      );

      // 1. Clear all deleted keys
      if (deletedTranslationKeysRef.current.size > 0) {
        debugLog.transition(
          `  cleared ${deletedTranslationKeysRef.current.size} deletedKeys`
        );
        deletedTranslationKeysRef.current.clear();
      }

      // 2. Store translations in localTranslationsRef (overlay — replaces item mutation)
      for (const [locale, fieldMap] of Object.entries(translations)) {
        for (const fieldDef of fieldDefinitions) {
          const value = fieldMap[fieldDef.key];
          if (value) {
            if (!localTranslationsRef.current[fieldDef.translationKey]) {
              localTranslationsRef.current[fieldDef.translationKey] = {};
            }
            localTranslationsRef.current[fieldDef.translationKey][locale] =
              value;
          }
        }
      }

      // 3. If viewing a translated locale, compute updatedValues
      let updatedValues: Record<string, string> | null = null;
      const clearedFallbackKeys: string[] = [];

      const currentLocaleTranslations = translations[currentLocale];
      if (currentLocaleTranslations) {
        updatedValues = { ...currentEditableValues };
        for (const fieldDef of fieldDefinitions) {
          const value = currentLocaleTranslations[fieldDef.key];
          if (value) {
            updatedValues[fieldDef.key] = String(value);
            clearedFallbackKeys.push(fieldDef.key);
          }
        }
        // Update baseline
        originalLoadedValuesRef.current = { ...updatedValues };
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale ${currentLocale}`
        );
      }

      // 4. Template change detection
      if (config.contentType === "templates" && updatedValues) {
        originalTemplateValuesRef.current = { ...updatedValues };
        setTemplateValuesVersion((v) => v + 1);
      }

      return {
        updatedValues,
        clearedFallbackKeys,
        shouldMarkLoading: true,
      };
    },
    [config.contentType, setTemplateValuesVersion]
  );

  /** After translateAllForLocale response (all fields → one locale) */
  const onTranslateAllForLocaleComplete = useCallback(
    (
      translations: Record<string, string>,
      fieldDefinitions: FieldDefinition[],
      targetLocale: string,
      currentLocale: string,
      currentEditableValues: Record<string, string>
    ): TransitionResult => {
      debugLog.transition(
        `onTranslateAllForLocaleComplete: target=${targetLocale}, viewing=${currentLocale}`
      );

      // 1. Clear all deleted keys
      if (deletedTranslationKeysRef.current.size > 0) {
        debugLog.transition(
          `  cleared ${deletedTranslationKeysRef.current.size} deletedKeys`
        );
        deletedTranslationKeysRef.current.clear();
      }

      // 2. Store translations in localTranslationsRef (overlay — replaces item mutation)
      for (const fieldDef of fieldDefinitions) {
        const value = translations[fieldDef.key];
        if (value) {
          if (!localTranslationsRef.current[fieldDef.translationKey]) {
            localTranslationsRef.current[fieldDef.translationKey] = {};
          }
          localTranslationsRef.current[fieldDef.translationKey][targetLocale] =
            value;
        }
      }

      // 3. If viewing this locale, compute updatedValues
      let updatedValues: Record<string, string> | null = null;
      const clearedFallbackKeys: string[] = [];

      if (currentLocale === targetLocale) {
        updatedValues = { ...currentEditableValues };
        for (const fieldDef of fieldDefinitions) {
          const value = translations[fieldDef.key];
          if (value) {
            updatedValues[fieldDef.key] = value;
            clearedFallbackKeys.push(fieldDef.key);
          }
        }
        originalLoadedValuesRef.current = { ...updatedValues };
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale`
        );
      }

      // 4. Template change detection
      if (config.contentType === "templates" && updatedValues) {
        originalTemplateValuesRef.current = { ...updatedValues };
        setTemplateValuesVersion((v) => v + 1);
      }

      return {
        updatedValues,
        clearedFallbackKeys,
        shouldMarkLoading: true,
      };
    },
    [config.contentType, setTemplateValuesVersion]
  );

  /** After updateContent response (save completed) */
  const onSaveComplete = useCallback(
    (
      savedLocale: string,
      editableValues: Record<string, string>,
      fieldDefinitions: FieldDefinition[]
    ): TransitionResult => {
      debugLog.transition(`onSaveComplete: locale=${savedLocale}`);

      if (savedLocale === primaryLocale) {
        // ── PRIMARY LOCALE ──
        // Item properties are NOT mutated — savedPrimaryValuesRef (set by
        // handleSave before submit) provides the overlay for resolve().
        debugLog.transition(
          "  primary locale: ref overlays active (no item mutation)"
        );

        // Clear localTranslations for changed fields (deletedTranslationKeysRef
        // was populated BEFORE submit in handleSave/performAutoSave)
        let clearedCount = 0;
        for (const deletedKey of deletedTranslationKeysRef.current) {
          if (localTranslationsRef.current[deletedKey]) {
            delete localTranslationsRef.current[deletedKey];
            clearedCount++;
          }
        }
        deletedTranslationKeysRef.current.clear();
        if (clearedCount > 0) {
          debugLog.transition(
            `  cleared ${clearedCount} localTranslation entries for changed primary fields`
          );
        }
      } else {
        // ── FOREIGN LOCALE ──
        debugLog.transition(
          `  foreign locale: storing overlays for ${savedLocale}`
        );

        let upserted = 0;
        let deleted = 0;

        for (const fieldDef of fieldDefinitions) {
          if (fieldDef.type === "image-gallery") continue;
          const value = editableValues[fieldDef.key];

          if (value) {
            // Store in localTranslationsRef to persist after revalidation
            if (!localTranslationsRef.current[fieldDef.translationKey]) {
              localTranslationsRef.current[fieldDef.translationKey] = {};
            }
            localTranslationsRef.current[fieldDef.translationKey][savedLocale] =
              value;
            upserted++;
          } else if (value === "") {
            // User cleared this field
            if (
              localTranslationsRef.current[fieldDef.translationKey]?.[
                savedLocale
              ]
            ) {
              delete localTranslationsRef.current[fieldDef.translationKey][
                savedLocale
              ];
            }
            deletedTranslationKeysRef.current.add(fieldDef.translationKey);
            deleted++;
          }
        }

        debugLog.transition(
          `  upserted=${upserted}, deleted=${deleted} translations`
        );
      }

      return {
        updatedValues: null,
        clearedFallbackKeys: [],
        shouldMarkLoading: true,
      };
    },
    [primaryLocale]
  );

  /** After translateFieldToAllLocales callback (Accept & Translate flow) */
  const onTranslateFieldToAllLocalesComplete = useCallback(
    (
      translationKey: string,
      translations: Record<string, string>,
      currentLocale: string
    ): TransitionResult => {
      const localeCount = Object.keys(translations).length;
      debugLog.transition(
        `onTranslateFieldToAllLocalesComplete: key=${translationKey} ${localeCount} locales`
      );

      // 1. Clear deleted key
      if (deletedTranslationKeysRef.current.has(translationKey)) {
        deletedTranslationKeysRef.current.delete(translationKey);
      }

      // 2. Store in localTranslationsRef (overlay — replaces item mutation)
      if (!localTranslationsRef.current[translationKey]) {
        localTranslationsRef.current[translationKey] = {};
      }
      for (const [locale, translatedValue] of Object.entries(translations)) {
        localTranslationsRef.current[translationKey][locale] = translatedValue;
      }
      debugLog.transition(
        `  stored local translations for ${translationKey}: ${Object.keys(translations).join(", ")}`
      );

      return {
        updatedValues: null, // Caller handles editableValues update
        clearedFallbackKeys: [],
        shouldMarkLoading: true,
      };
    },
    []
  );

  /** When switching to a different item */
  const onItemSwitch = useCallback(() => {
    debugLog.transition("onItemSwitch: clearing all caches");
    deletedTranslationKeysRef.current.clear();
    localTranslationsRef.current = {};
  }, []);

  /** When user clicks ReloadButton */
  const onRefresh = useCallback((itemId: string | null) => {
    debugLog.transition(`onRefresh: itemId=${itemId}`);
    if (itemId && savedPrimaryValuesRef.current[itemId]) {
      delete savedPrimaryValuesRef.current[itemId];
    }
    localTranslationsRef.current = {};
    deletedTranslationKeysRef.current.clear();
  }, []);

  // ---------------------------------------------------------------------------
  // DEBUG
  // ---------------------------------------------------------------------------

  const getDebugState = useCallback((): DataCacheState => {
    return {
      localOverrides: { ...localTranslationsRef.current },
      deletedKeys: [...deletedTranslationKeysRef.current],
      savedPrimaryCache: { ...savedPrimaryValuesRef.current },
      originalLoaded: { ...originalLoadedValuesRef.current },
      originalTemplate: { ...originalTemplateValuesRef.current },
    };
  }, []);

  // ---------------------------------------------------------------------------
  // RETURN
  // ---------------------------------------------------------------------------

  return {
    resolve,
    resolveAll,
    onTranslateFieldComplete,
    onTranslateAllComplete,
    onTranslateAllForLocaleComplete,
    onSaveComplete,
    onTranslateFieldToAllLocalesComplete,
    onItemSwitch,
    onRefresh,
    refs: {
      localTranslationsRef,
      deletedTranslationKeysRef,
      savedPrimaryValuesRef,
      originalLoadedValuesRef,
      originalTemplateValuesRef,
    },
    templateValuesVersion,
    setTemplateValuesVersion,
    getDebugState,
  };
}

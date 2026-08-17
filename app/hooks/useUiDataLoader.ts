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

import { isThemeContentType } from "~/utils/content-type-groups";
import { useRef, useState, useCallback } from "react";
import { getTranslatedValue } from "../utils/contentEditor.utils";
import type { MetaobjectEntry } from "../utils/contentEditor.utils";
import { debugLog } from "../utils/debug";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
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
  | "marketOverride" // a market-specific translation (marketTranslations) supplied the value
  | "savedPrimaryCache" // savedPrimaryValuesRef had a cached value
  | "itemTranslation" // item.translations had a value
  | "itemField" // Direct item property (primary locale)
  | "fallback" // Fallback value (handle→primary, seoTitle→title, or global→market inheritance)
  | "empty"; // No value found

/**
 * Composite key that folds the market dimension into the per-locale overlay maps
 * (localTranslationsRef). Global (marketId "") keeps the plain locale key so the
 * existing global behaviour is byte-for-byte unchanged; a market appends
 * "@@<marketId>" so market overlays never collide with the global ones.
 */
export function buildLocaleKey(locale: string, marketId: string): string {
  return marketId ? `${locale}@@${marketId}` : locale;
}

/** Same folding for deletedTranslationKeysRef entries (keyed by translationKey). */
export function buildDeletedKey(translationKey: string, marketId: string): string {
  return marketId ? `${translationKey}@@${marketId}` : translationKey;
}

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
  baseline: Record<string, string>;
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

  /** After a single-field translation (translateField) response.
   *  Pass marketIdArg to force the overlay's market scope to match the save
   *  (e.g. "" for globally-saved Accept & Translate); omit to use the current market. */
  onTranslateFieldComplete: (
    fieldKey: string,
    translationKey: string,
    translatedValue: string,
    targetLocale: string,
    currentEditableValues: Record<string, string>,
    marketIdArg?: string
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
    fieldDefinitions: FieldDefinition[],
    /** Fields still inherited from global (current fallbackFields) — skipped when
     *  storing market overlays so a single-field market save doesn't drop the
     *  inherited styling on the rest. Ignored in the global context. */
    inheritedFieldKeys?: Set<string>
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

  /** After resolveAll() completes — sets unified baseline and keeps legacy refs in sync */
  onDataLoaded: (values: Record<string, string>) => void;

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
    /** Unified change-detection baseline — single source of truth for all content types */
    baselineValuesRef: React.MutableRefObject<Record<string, string>>;
    /** Currently-selected market ("" = global); owner keeps it in sync */
    selectedMarketIdRef: React.MutableRefObject<string>;
  };

  /** Template change-detection version counter */
  templateValuesVersion: number;
  setTemplateValuesVersion: React.Dispatch<React.SetStateAction<number>>;

  /** Unified change-detection version counter — incremented whenever baselineValuesRef updates */
  baselineVersion: number;
  setBaselineVersion: React.Dispatch<React.SetStateAction<number>>;

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
  // Templates & Metaobjects: Use custom getter if available
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

  // Metaobjects: Check metaobjects array
  // fieldKey is the metaobject ID, find the metaobject and get its label field
  const itemWithMetaobjects = item as { metaobjects?: MetaobjectEntry[] };
  if (itemWithMetaobjects.metaobjects && Array.isArray(itemWithMetaobjects.metaobjects)) {
    const metaobject = itemWithMetaobjects.metaobjects.find((m) => m.id === fieldKey);
    if (metaobject) {
      // Find the label field (display_name, name, or label)
      const labelField = metaobject.fields?.find((f) => isMetaobjectLabelField(f.key));
      return labelField?.value || metaobject.displayName || "";
    }
  }

  // Standard content types: Common field mappings
  const row = item as unknown as Record<string, unknown>;
  const fieldMappings: Record<string, string> = {
    title: item.title || "",
    description: item.descriptionHtml || item.body || "",
    handle: item.handle || "",
    seoTitle: item.seo?.title || item.title || "",
    metaDescription: item.seo?.description || "",
    body: item.body || "",
    summary: item.summary || "",
    productType: item.productType || "",
    // ── PLAN §Phase 3 merchandising attributes ──────────────────────────────
    // Every editor value is a STRING — `getChangedFields` compares strings —
    // so the two non-string columns are flattened here, at the one place that
    // turns an item into editable values, rather than in each control.
    status: String(row.status ?? ""),
    vendor: String(row.vendor ?? ""),
    author: String(row.author ?? ""),
    sortOrder: String(row.sortOrder ?? ""),
    templateSuffix: String(row.templateSuffix ?? ""),
    // Comma-joined, matching AttributeField's parse/serialize pair.
    tags: Array.isArray(row.tags) ? (row.tags as string[]).join(", ") : "",
    // `isPublished` defaults to TRUE in the schema, so a missing value must
    // read as published — the same rule as the column's own default.
    isPublished: row.isPublished === false ? "false" : "true",
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

  /** Track deleted translation keys — show empty even if revalidation brings them back.
   *  Entries are market-folded via buildDeletedKey() so a market-specific clear
   *  does not blank the global value (and vice-versa). */
  const deletedTranslationKeysRef = useRef<Set<string>>(new Set());

  /** Currently-selected market ("" = global). Held in a ref so resolve()/the
   *  transition methods can read it without bloating their useCallback deps. The
   *  owning hook keeps it in sync via refs.selectedMarketIdRef on every change. */
  const selectedMarketIdRef = useRef<string>("");

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

  /** Unified baseline for change detection — single source of truth for all content types.
   *  Updated only via onDataLoaded() after revalidation and in translation callbacks. */
  const baselineValuesRef = useRef<Record<string, string>>({});

  /** Version counter to force hasFieldChanges useMemo recalculation when baselineValuesRef updates */
  const [baselineVersion, setBaselineVersion] = useState(0);

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
      // ---- NOT TRANSLATABLE AT ALL (PLAN §Phase 3 attributes) ----
      // An empty `translationKey` means Shopify stores ONE value for this
      // field, not one per locale — status, vendor, tags, author, sort order.
      // Sent down the foreign chain below it would match no market row, no
      // override and no translation, and come back "" — so a foreign locale
      // would show an ACTIVE product as DRAFT (a Polaris Select with value ""
      // renders its first option) and a hidden page as visible. The control is
      // read-only there and correctly says the value exists once per item; the
      // one thing it must not do is show a value the item does not have.
      if (!translationKey) {
        const savedOverride = savedPrimaryValuesRef.current[item.id];
        if (savedOverride && savedOverride[fieldKey] !== undefined) {
          return { value: savedOverride[fieldKey], source: "savedPrimaryCache", isFallback: false };
        }
        return {
          value: getItemFieldValue(item, fieldKey, primaryLocale, config),
          source: "itemField",
          isFallback: false,
        };
      }

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
      //
      // Market dimension (Shopify "Translate & Adapt"): when a market is
      // selected we first look for a market-specific value (market overlay or
      // market DB row); if none exists we fall back to the GLOBAL layer exactly
      // as before, flagging the value as inherited. When no market is selected
      // (marketId ""), this reduces to the original global-only chain.
      const marketId = selectedMarketIdRef.current;
      const isMarket = marketId !== "";

      // 1a. Market-specific deletion → skip the market layer (fall through to
      //     global). Global deletion → empty (as before).
      const marketDeleted =
        isMarket &&
        deletedTranslationKeysRef.current.has(buildDeletedKey(translationKey, marketId));
      const globalDeleted = deletedTranslationKeysRef.current.has(translationKey);

      // 1b. Market layer (only when a market is selected and not market-deleted)
      if (isMarket && !marketDeleted) {
        // Market local override (staged edits/translations for this market)
        const marketLocal =
          localTranslationsRef.current[translationKey]?.[buildLocaleKey(locale, marketId)];
        if (marketLocal) {
          return { value: marketLocal, source: "marketOverride", isFallback: false };
        }
        // Market-specific DB row
        const marketDbValue =
          item.marketTranslations?.[marketId]?.[translationKey]?.[locale];
        if (marketDbValue) {
          return { value: marketDbValue, source: "marketOverride", isFallback: false };
        }
      }

      // 2. GLOBAL layer. In a market context this is the inherited fallback, so
      //    isFallback is true; in the global context it is the direct value.
      if (globalDeleted) {
        // Global value was cleared. In a market context with no market value we
        // still try the field-level fallbacks below; in the global context it is
        // simply empty.
        if (!isMarket) {
          return { value: "", source: "deleted", isFallback: false };
        }
      } else {
        // Global local override
        const globalLocal = localTranslationsRef.current[translationKey]?.[locale];
        if (globalLocal) {
          return { value: globalLocal, source: "localOverride", isFallback: isMarket };
        }
        // item.translations (global DB rows)
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
            isFallback: isMarket,
          };
        }
      }

      // 3. Field-level fallbacks (handle→primary, seoTitle→title)
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

      // 4. Empty
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

  /** Called by the data-loading effect after resolveAll() completes.
   *  Updates the unified change-detection baseline and keeps legacy refs in sync. */
  const onDataLoaded = useCallback(
    (values: Record<string, string>) => {
      baselineValuesRef.current = { ...values };
      setBaselineVersion((v) => v + 1);
      // Keep legacy refs updated for error recovery and buildFieldsForSave
      originalLoadedValuesRef.current = { ...values };
      if (isThemeContentType(config.contentType)) {
        originalTemplateValuesRef.current = { ...values };
        setTemplateValuesVersion((v) => v + 1);
      }
    },
    [config.contentType, setTemplateValuesVersion]
  );

  /** After a single-field translation response */
  const onTranslateFieldComplete = useCallback(
    (
      fieldKey: string,
      translationKey: string,
      translatedValue: string,
      targetLocale: string,
      currentEditableValues: Record<string, string>,
      // Market the eventual save persists under. MUST match the save's marketId:
      // pass "" for globally-saved flows (e.g. Accept & Translate → all locales)
      // and the selected market for market-scoped saves. Defaults to the current
      // market so market-aware callers can omit it.
      marketIdArg?: string
    ): TransitionResult => {
      debugLog.transition(
        `onTranslateFieldComplete: field=${fieldKey} locale=${targetLocale} value="${translatedValue.substring(0, 40)}..."`
      );

      // Market-fold the overlay keys so a translation staged in a market context
      // does not overwrite the global overlay (and a globally-saved translation is
      // not stranded under a market key). The overlay key must mirror where the
      // accompanying save writes.
      const marketId = marketIdArg ?? selectedMarketIdRef.current;
      const localeKey = buildLocaleKey(targetLocale, marketId);
      const delKey = buildDeletedKey(translationKey, marketId);

      // 1. Clear deleted key
      if (deletedTranslationKeysRef.current.has(delKey)) {
        deletedTranslationKeysRef.current.delete(delKey);
        debugLog.transition(`  cleared deletedKey: ${delKey}`);
      }

      // 2. Store in localTranslationsRef (overlay — replaces item mutation)
      if (!localTranslationsRef.current[translationKey]) {
        localTranslationsRef.current[translationKey] = {};
      }
      localTranslationsRef.current[translationKey][localeKey] =
        translatedValue;

      // 3. Compute updated values
      const updatedValues = {
        ...currentEditableValues,
        [fieldKey]: translatedValue,
      };

      // 4. Update baselines (unified + legacy)
      originalLoadedValuesRef.current = { ...updatedValues };
      baselineValuesRef.current = { ...updatedValues };
      setBaselineVersion((v) => v + 1);

      // 5. Template change detection
      if (isThemeContentType(config.contentType)) {
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
        // Update baselines (unified + legacy)
        originalLoadedValuesRef.current = { ...updatedValues };
        baselineValuesRef.current = { ...updatedValues };
        setBaselineVersion((v) => v + 1);
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale ${currentLocale}`
        );
      }

      // 4. Template change detection
      if (isThemeContentType(config.contentType) && updatedValues) {
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
        // Update baselines (unified + legacy)
        originalLoadedValuesRef.current = { ...updatedValues };
        baselineValuesRef.current = { ...updatedValues };
        setBaselineVersion((v) => v + 1);
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale`
        );
      }

      // 4. Template change detection
      if (isThemeContentType(config.contentType) && updatedValues) {
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
      fieldDefinitions: FieldDefinition[],
      inheritedFieldKeys?: Set<string>
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

        // Market-fold the overlay locale key so the saved overlay is scoped to the
        // market it was saved under (matching the market-aware DB write).
        const marketId = selectedMarketIdRef.current;
        const localeKey = buildLocaleKey(savedLocale, marketId);

        for (const fieldDef of fieldDefinitions) {
          if (fieldDef.type === "image-gallery") continue;
          const value = editableValues[fieldDef.key];

          // In a market context, only fields the save actually wrote as market
          // overrides get an overlay. Fields still inherited from the global value
          // (inheritedFieldKeys, i.e. the current fallbackFields — the same set
          // buildFieldsForSave skips) must NOT get a market overlay, else
          // resolve() would find one for every field and the greyed "inherited"
          // styling would vanish across the whole item after saving one field.
          if (marketId && inheritedFieldKeys?.has(fieldDef.key)) {
            if (localTranslationsRef.current[fieldDef.translationKey]?.[localeKey]) {
              delete localTranslationsRef.current[fieldDef.translationKey][localeKey];
              deleted++;
            }
            continue;
          }

          if (value) {
            // Store in localTranslationsRef to persist after revalidation
            if (!localTranslationsRef.current[fieldDef.translationKey]) {
              localTranslationsRef.current[fieldDef.translationKey] = {};
            }
            localTranslationsRef.current[fieldDef.translationKey][localeKey] =
              value;
            upserted++;
          } else if (value === "") {
            // User cleared this field — remove the (market-scoped) overlay
            if (
              localTranslationsRef.current[fieldDef.translationKey]?.[localeKey]
            ) {
              delete localTranslationsRef.current[fieldDef.translationKey][
                localeKey
              ];
            }
            deleted++;
          }
        }

        // Clear deletedTranslationKeysRef now that the save is complete.
        // These keys were added by handleClearField before save to prevent
        // revalidation from restoring stale data. Now that the save succeeded,
        // revalidation will fetch fresh data and the protection is no longer
        // needed. Keeping them would incorrectly show empty fields in OTHER
        // locales because deletedTranslationKeysRef is not locale-specific.
        deletedTranslationKeysRef.current.clear();

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
      baseline: { ...baselineValuesRef.current },
    };
  }, []);

  // ---------------------------------------------------------------------------
  // RETURN
  // ---------------------------------------------------------------------------

  return {
    resolve,
    resolveAll,
    onTranslateFieldComplete,
    onDataLoaded,
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
      baselineValuesRef,
      selectedMarketIdRef,
    },
    templateValuesVersion,
    setTemplateValuesVersion,
    baselineVersion,
    setBaselineVersion,
    getDebugState,
  };
}

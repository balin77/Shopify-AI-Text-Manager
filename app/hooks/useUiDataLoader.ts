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
import {
  metaobjectFieldValueFor,
  type MetaobjectDefinitionFieldLike,
  type MetaobjectEntryLike,
} from "../services/metaobject-fields.shared";
import { debugLog } from "../utils/debug";
import { buildLocaleDeletedKey, dropMarksAfterSave, isMarkedDeleted } from "../services/editor/deleted-translation-marks.shared";
import { isMetaobjectLabelField } from "../constants/shopifyFields";
import { RULES_UNREADABLE } from "../config/collection-rules.shared";
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
  return marketId ? `${locale}${LOCALE_MARKET_SEP}${marketId}` : locale;
}

/**
 * The separator, as a constant rather than three string literals. A caller that
 * has to RECOGNISE a market key — "is this overlay entry global?" — had no way
 * to ask, wrote its own guess, and silently wiped the market overrides it meant
 * to spare.
 */
export const LOCALE_MARKET_SEP = "@@";

/** Same folding for deletedTranslationKeysRef entries (keyed by translationKey).
 *  This is the LAYER mark (every locale); one locale's cleared value carries a
 *  LOCALE mark (`buildLocaleDeletedKey`, deleted-translation-marks.shared.ts). */
export function buildDeletedKey(translationKey: string, marketId: string): string {
  return marketId ? `${translationKey}${LOCALE_MARKET_SEP}${marketId}` : translationKey;
}

/** A save that carried only SOME fields, in one locale (a single-field
 *  translate, Accept & Translate). The response handling treats only these
 *  values as saved: not the rest of the view, and not the view at all when the
 *  merchant has switched to another locale meanwhile. */
export interface PartialSave {
  locale: string;
  /** The market the save was scoped to ("" = global). */
  marketId: string;
  values: Record<string, string>;
  /** The image indices whose alt text this save carried. Absent = none: a
   *  partial save never stands for the alt texts it did not send, so their
   *  baseline (and the merchant's unsaved alt drafts) stay untouched. */
  altIndices?: number[];
  /** The alt texts this save SENT, keyed like `altIndices`. The response
   *  handling takes the baseline and the in-memory mirror of the carried
   *  indices from here, never from the live field: a merchant who kept typing
   *  while the save was in flight holds text that was not sent, and marking it
   *  saved would keep the next Save from sending it. */
  altValues?: Record<number, string>;
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
    marketIdArg?: string,
    viewing?: boolean
  ) => TransitionResult;

  /** After translateAll response (all fields → all locales) */
  onTranslateAllComplete: (
    translations: Record<string, Record<string, string>>,
    fieldDefinitions: FieldDefinition[],
    currentLocale: string,
    currentEditableValues: Record<string, string>,
    /** The market open now: with one, nothing on screen is touched. */
    marketIdArg?: string
  ) => TransitionResult;

  /** After translateAllForLocale response (all fields → one locale) */
  onTranslateAllForLocaleComplete: (
    translations: Record<string, string>,
    fieldDefinitions: FieldDefinition[],
    targetLocale: string,
    currentLocale: string,
    currentEditableValues: Record<string, string>,
    /** The market open now: with one, nothing on screen is touched. */
    marketIdArg?: string
  ) => TransitionResult;

  /** After updateContent response (save completed) */
  onSaveComplete: (
    savedLocale: string,
    editableValues: Record<string, string>,
    fieldDefinitions: FieldDefinition[],
    /** Fields still inherited from global (current fallbackFields) — skipped when
     *  storing market overlays so a single-field market save doesn't drop the
     *  inherited styling on the rest. Ignored in the global context. */
    inheritedFieldKeys?: Set<string>,
    onlyKeys?: ReadonlySet<string> | null,
    savedMarketId?: string
  ) => TransitionResult;

  /** After translateFieldToAllLocales callback (Accept & Translate) */
  onTranslateFieldToAllLocalesComplete: (
    translationKey: string,
    translations: Record<string, string>,
    currentLocale: string
  ) => TransitionResult;

  /** A "copy to all languages" save did NOT land for these locales: drop the
   *  value the copy wrote into the overlay for them, so the editor shows what
   *  Shopify holds again instead of a value that was never saved. */
  onCopyToLocalesFailed: (
    translationKey: string,
    locales: string[],
    copiedValue: string,
    opts?: { itemUnchanged?: boolean; allLocalesFailed?: boolean },
  ) => void;

  /** When switching to a different item */
  onItemSwitch: () => void;

  /** When user clicks ReloadButton */
  onRefresh: (itemId: string | null) => void;

  /** After a BACKGROUND re-translation this save started has finished and the
   *  loader has been re-read. See the implementation for why it clears exactly
   *  these two refs and leaves the primary cache alone. */
  onBackgroundRetranslation: () => void;

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

  // Metaobjects: the field key is `<Metaobject GID>#<field key>` (§6.1). Only
  // reached when no config was passed — METAOBJECTS_CONFIG has a getFieldValue
  // and short-circuits above — but it answers through the SAME reader so the
  // two cannot disagree about what a compound key means.
  const itemWithMetaobjects = item as {
    metaobjects?: MetaobjectEntry[];
    fieldDefinitions?: MetaobjectDefinitionFieldLike[];
  };
  if (itemWithMetaobjects.metaobjects && Array.isArray(itemWithMetaobjects.metaobjects)) {
    return metaobjectFieldValueFor(
      itemWithMetaobjects.metaobjects as MetaobjectEntryLike[] | undefined,
      itemWithMetaobjects.fieldDefinitions,
      fieldKey,
      isMetaobjectLabelField,
    );
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
    // §3.1 — the rule sources, already parsed into the editor's model by the
    // loader. JSON because every editor value is a string and change detection
    // compares strings; an empty string means "no rules", which is a value the
    // save acts on and not a missing one. That is exactly why the loader's
    // `null` must NOT collapse into "": null means the row holds a model this
    // editor may not touch (a `ruleSet` projection, an unsynced collection),
    // and an empty builder over a collection that HAS rules would make its own
    // emptiness true on the first save.
    // §Phase 3.1 — the category travels as its GID, which is what the write
    // path needs; the NAME is a label and lives on the item, not in this map.
    category: typeof row.categoryId === "string" ? row.categoryId : "",
    // §Phase 3.1 — membership as a comma-joined GID list, like every other
    // value here. `null` means the row was never attribute-synced, and "" would
    // read as "in no collections" — which the save would then act on.
    collections: Array.isArray(row.collections)
      ? (row.collections as Array<{ id?: string }>).map((c) => c.id ?? "").filter(Boolean).join(",")
      : "",
    collectionRules: Array.isArray(row.ruleSources)
      ? JSON.stringify(row.ruleSources)
      : RULES_UNREADABLE,
  };

  return fieldMappings[fieldKey] || "";
}

/**
 * What a BACKGROUND refresh may put on screen: the freshly resolved server
 * values, except in the fields the merchant has typed in and not saved.
 *
 * Pure and exported because it is the one rule of this whole mechanism that
 * holds under every circumstance — the reload reads, it never writes, and it
 * never eats input. The reload is already deferred while the editor is dirty
 * (see `useUnifiedContentEditor`), so in practice this changes nothing; it
 * exists for the keystroke that lands between that decision and the re-resolve.
 *
 * `previousBaseline` is the baseline the current input is dirty AGAINST, i.e.
 * the one captured BEFORE `onDataLoaded` installs the new values. Comparing
 * against the new one would find every field clean and quietly discard the
 * edit.
 *
 * The caller must still set the baseline from `resolved`, NEVER from what this
 * returns: the baseline is what change detection compares against, so writing a
 * preserved edit into it would mark that edit as already saved and the merchant
 * could never save it.
 */
export function preserveUnsavedEdits(
  resolved: Record<string, string>,
  current: Record<string, string>,
  previousBaseline: Record<string, string>,
): { values: Record<string, string>; preservedKeys: string[] } {
  const values: Record<string, string> = { ...resolved };
  const preservedKeys: string[] = [];
  for (const key of Object.keys(current)) {
    const value = current[key];
    if (value === undefined) continue;
    // A field the merchant never touched matches the baseline it was loaded
    // with, and takes the server's new value. Anything else is their input.
    if (value === previousBaseline[key]) continue;
    values[key] = value;
    preservedKeys.push(key);
  }
  return { values, preservedKeys };
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
  // Keys whose "deleted" marker the last copy-to-all-locales cleared (see onCopyToLocalesFailed).
  const clearedDeletedByCopyRef = useRef<Set<string>>(new Set());
  /** The LOCALE marks a copy to every locale dropped, per translation key. */
  const clearedLocaleMarksByCopyRef = useRef<Map<string, string[]>>(new Map());

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
        isMarkedDeleted(deletedTranslationKeysRef.current, translationKey, marketId, locale);
      const globalDeleted = isMarkedDeleted(deletedTranslationKeysRef.current, translationKey, "", locale);

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
            // A PARTIAL primary save (an accepted AI suggestion) overlays only
            // the field it wrote; the others resolve from the item anyway and
            // say nothing about whether the server caught up.
            if (!(field.key in savedOverride)) return true;
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
      marketIdArg?: string,
      // `false` when the merchant has switched away from `targetLocale` while
      // the AI worked: the translation is still staged for that locale, but
      // nothing on screen or in the baseline belongs to it any more.
      viewing: boolean = true
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
      deletedTranslationKeysRef.current.delete(buildLocaleDeletedKey(translationKey, marketId, targetLocale));

      // 2. Store in localTranslationsRef (overlay — replaces item mutation)
      if (!localTranslationsRef.current[translationKey]) {
        localTranslationsRef.current[translationKey] = {};
      }
      localTranslationsRef.current[translationKey][localeKey] =
        translatedValue;

      if (!viewing) {
        return { updatedValues: null, clearedFallbackKeys: [], shouldMarkLoading: false };
      }

      // 3. Compute updated values
      const updatedValues = {
        ...currentEditableValues,
        [fieldKey]: translatedValue,
      };

      // 4. Update baselines (unified + legacy) for THIS field only. The save
      // that follows writes this one field; taking every current value as the
      // baseline marked the merchant's unsaved edits in OTHER fields clean, so
      // they were never sent and vanished at the next reload or item switch.
      originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, [fieldKey]: translatedValue };
      baselineValuesRef.current = { ...baselineValuesRef.current, [fieldKey]: translatedValue };
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

  /** After translateAll response (all fields → all locales).
   *  The run writes the GLOBAL layer. With a MARKET open nothing on screen is
   *  touched: the market's own layer (or its inherited placeholder) is what
   *  shows there, and writing the global answer into the field would make it
   *  read as a market override nobody typed -- the next load resolves it. In
   *  the global view only fields the merchant has NOT edited (current value
   *  equals the baseline) take the answer, and the baseline moves for those
   *  fields alone (mirrors `onTranslateFieldComplete`). */
  const onTranslateAllComplete = useCallback(
    (
      translations: Record<string, Record<string, string>>,
      fieldDefinitions: FieldDefinition[],
      currentLocale: string,
      currentEditableValues: Record<string, string>,
      /** The market open NOW. Defaults to the live selection. */
      marketIdArg?: string
    ): TransitionResult => {
      const localeCount = Object.keys(translations).length;
      const marketId = marketIdArg ?? selectedMarketIdRef.current ?? "";
      debugLog.transition(
        `onTranslateAllComplete: ${localeCount} locales, viewing=${currentLocale} market=${marketId || "-"}`
      );

      // 1. Clear the GLOBAL deleted marks of the fields the answer carries a
      // value for -- never the rest (another field's pending clear stays
      // pending) and never a market's (the run wrote no market override).
      for (const [answeredLocale, fieldMap] of Object.entries(translations)) {
        for (const fieldDef of fieldDefinitions) {
          if (!fieldMap?.[fieldDef.key]) continue;
          const delKey = buildDeletedKey(fieldDef.translationKey, "");
          if (deletedTranslationKeysRef.current.delete(delKey)) {
            debugLog.transition(`  cleared deletedKey: ${delKey}`);
          }
          deletedTranslationKeysRef.current.delete(buildLocaleDeletedKey(fieldDef.translationKey, "", answeredLocale));
        }
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

      // 3. If viewing a translated locale in the GLOBAL layer, put the answer
      // into every field that is not dirty.
      let updatedValues: Record<string, string> | null = null;
      const clearedFallbackKeys: string[] = [];

      const currentLocaleTranslations = translations[currentLocale];
      if (currentLocaleTranslations && !marketId) {
        const next = { ...currentEditableValues };
        const baselinePatch: Record<string, string> = {};
        for (const fieldDef of fieldDefinitions) {
          const value = currentLocaleTranslations[fieldDef.key];
          if (!value) continue;
          const current = currentEditableValues[fieldDef.key] ?? "";
          const baseline = baselineValuesRef.current[fieldDef.key] ?? "";
          if (current !== baseline) continue; // unsaved typing wins
          next[fieldDef.key] = String(value);
          baselinePatch[fieldDef.key] = String(value);
          clearedFallbackKeys.push(fieldDef.key);
        }
        if (clearedFallbackKeys.length > 0) {
          updatedValues = next;
          originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, ...baselinePatch };
          baselineValuesRef.current = { ...baselineValuesRef.current, ...baselinePatch };
          setBaselineVersion((v) => v + 1);
          // 4. Template change detection, per applied field as well.
          if (isThemeContentType(config.contentType)) {
            originalTemplateValuesRef.current = { ...originalTemplateValuesRef.current, ...baselinePatch };
            setTemplateValuesVersion((v) => v + 1);
          }
        }
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale ${currentLocale}`
        );
      }

      return {
        updatedValues,
        clearedFallbackKeys,
        shouldMarkLoading: true,
      };
    },
    [config.contentType, setTemplateValuesVersion]
  );

  /** After translateAllForLocale response (all fields → one locale).
   *  Same rules as `onTranslateAllComplete`: the run writes the GLOBAL layer of
   *  `targetLocale`, so the answer is always staged under the bare locale key,
   *  but it is put on screen only while the merchant still looks at THAT locale
   *  in the GLOBAL view, and only into fields they have not typed into (current
   *  value equals the baseline); the baseline moves for those fields alone.
   *  Another locale or a market open now leaves the screen and the baseline
   *  untouched -- the next load resolves the layer it shows. Only the answered
   *  fields' GLOBAL deleted marks are cleared. */
  const onTranslateAllForLocaleComplete = useCallback(
    (
      translationsArg: Record<string, string>,
      fieldDefinitions: FieldDefinition[],
      targetLocale: string,
      currentLocale: string,
      currentEditableValues: Record<string, string>,
      /** The market open NOW. Defaults to the live selection. */
      marketIdArg?: string
    ): TransitionResult => {
      const translations = translationsArg ?? {};
      const marketId = marketIdArg ?? selectedMarketIdRef.current ?? "";
      debugLog.transition(
        `onTranslateAllForLocaleComplete: target=${targetLocale}, viewing=${currentLocale} market=${marketId || "-"}`
      );

      // 1. Clear the GLOBAL deleted marks of the fields the answer carries a
      // value for -- never another field's pending clear, never a market's.
      // Another locale's own mark (its clear may still be on its way) is never
      // touched: that one is a mark of THIS target locale only.
      for (const fieldDef of fieldDefinitions) {
        if (!translations[fieldDef.key]) continue;
        const delKey = buildDeletedKey(fieldDef.translationKey, "");
        if (deletedTranslationKeysRef.current.delete(delKey)) {
          debugLog.transition(`  cleared deletedKey: ${delKey}`);
        }
        deletedTranslationKeysRef.current.delete(buildLocaleDeletedKey(fieldDef.translationKey, "", targetLocale));
      }

      // 2. Store translations in localTranslationsRef (overlay — replaces item
      // mutation) under the GLOBAL key of the target locale.
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

      // 3. Still viewing this locale in the GLOBAL layer: put the answer into
      // every field that is not dirty.
      let updatedValues: Record<string, string> | null = null;
      const clearedFallbackKeys: string[] = [];

      if (currentLocale === targetLocale && !marketId) {
        const next = { ...currentEditableValues };
        const baselinePatch: Record<string, string> = {};
        for (const fieldDef of fieldDefinitions) {
          const value = translations[fieldDef.key];
          if (!value) continue;
          const current = currentEditableValues[fieldDef.key] ?? "";
          const baseline = baselineValuesRef.current[fieldDef.key] ?? "";
          if (current !== baseline) continue; // unsaved typing wins
          next[fieldDef.key] = String(value);
          baselinePatch[fieldDef.key] = String(value);
          clearedFallbackKeys.push(fieldDef.key);
        }
        if (clearedFallbackKeys.length > 0) {
          updatedValues = next;
          originalLoadedValuesRef.current = { ...originalLoadedValuesRef.current, ...baselinePatch };
          baselineValuesRef.current = { ...baselineValuesRef.current, ...baselinePatch };
          setBaselineVersion((v) => v + 1);
          // 4. Template change detection, per applied field as well.
          if (isThemeContentType(config.contentType)) {
            originalTemplateValuesRef.current = { ...originalTemplateValuesRef.current, ...baselinePatch };
            setTemplateValuesVersion((v) => v + 1);
          }
        }
        debugLog.transition(
          `  updated ${clearedFallbackKeys.length} fields for viewing locale`
        );
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
      inheritedFieldKeys?: Set<string>,
      /** The fields the save actually CARRIED, when it was a partial one (a
       *  single-field translate). Absent = every field. Overlaying the others
       *  would stage the merchant's unsaved input as if it had been saved. */
      onlyKeys?: ReadonlySet<string> | null,
      /** The market the save was SUBMITTED under (savedMarketIdRef). The live
       *  selection may have moved while it was in flight, and an overlay keyed
       *  on it lands in the wrong market's view. */
      savedMarketId?: string
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
        // Every layer mark goes; a foreign clear's own locale marks stay until
        // ITS save answers (dropMarksAfterSave).
        dropMarksAfterSave(deletedTranslationKeysRef.current, null);
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
        const marketId = savedMarketId ?? selectedMarketIdRef.current;
        const localeKey = buildLocaleKey(savedLocale, marketId);

        for (const fieldDef of fieldDefinitions) {
          if (fieldDef.type === "image-gallery") continue;
          if (onlyKeys && !onlyKeys.has(fieldDef.key)) continue;
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
        // locales because the layer marks are not locale-specific. Another
        // locale's own marks stay: its clear may still be on its way, and a
        // re-read would otherwise show the values it is removing.
        dropMarksAfterSave(
          deletedTranslationKeysRef.current,
          { locale: savedLocale, marketId },
          onlyKeys
            ? new Set(fieldDefinitions.filter((f) => onlyKeys.has(f.key)).map((f) => f.translationKey))
            : null,
        );

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

      // 1. Clear deleted key (remembered, so a copy that then FAILS can put
      //    the marker back: the merchant had cleared this field and Shopify
      //    still holds that state).
      if (deletedTranslationKeysRef.current.has(translationKey)) {
        deletedTranslationKeysRef.current.delete(translationKey);
        clearedDeletedByCopyRef.current.add(translationKey);
      } else {
        clearedDeletedByCopyRef.current.delete(translationKey);
      }
      // The written locales' own marks too (a clear of that locale is
      // superseded by the value written there now).
      const clearedLocaleMarks: string[] = [];
      for (const locale of Object.keys(translations)) {
        const mark = buildLocaleDeletedKey(translationKey, "", locale);
        if (deletedTranslationKeysRef.current.delete(mark)) clearedLocaleMarks.push(mark);
      }
      if (clearedLocaleMarks.length > 0) clearedLocaleMarksByCopyRef.current.set(translationKey, clearedLocaleMarks);
      else clearedLocaleMarksByCopyRef.current.delete(translationKey);

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

  const onCopyToLocalesFailed = useCallback(
    (
      translationKey: string,
      locales: string[],
      copiedValue: string,
      opts?: { itemUnchanged?: boolean; allLocalesFailed?: boolean },
    ) => {
      // The copy cleared this key's "deleted" marker on the way in. The marker
      // is per KEY, not per locale: it goes back only when the item is still
      // the one the copy ran on AND no locale took the value (a partial copy
      // did write a translation, so the field is no longer deleted).
      const hadCleared = clearedDeletedByCopyRef.current.delete(translationKey);
      const clearedLocaleMarks = clearedLocaleMarksByCopyRef.current.get(translationKey) ?? [];
      clearedLocaleMarksByCopyRef.current.delete(translationKey);
      if (opts?.itemUnchanged !== false) {
        // A failed locale did not get the copied value: its own clear stands.
        for (const locale of locales) {
          const mark = buildLocaleDeletedKey(translationKey, "", locale);
          if (clearedLocaleMarks.includes(mark)) deletedTranslationKeysRef.current.add(mark);
        }
      }
      if (
        hadCleared &&
        locales.length > 0 &&
        opts?.itemUnchanged !== false &&
        opts?.allLocalesFailed !== false
      ) {
        deletedTranslationKeysRef.current.add(translationKey);
      }
      // The overlay belongs to the item now on screen: after an item switch it
      // is the NEW item's, and the copy's value is not ours to take from it.
      if (opts?.itemUnchanged === false) return;
      const overlay = localTranslationsRef.current[translationKey];
      if (!overlay) return;
      for (const locale of locales) {
        // Only the copy's OWN value: anything written there since (the
        // merchant typing in that locale) is not ours to take back. The copy
        // writes the GLOBAL layer, i.e. the bare locale key.
        if (overlay[locale] === copiedValue) delete overlay[locale];
      }
      debugLog.transition(
        `onCopyToLocalesFailed: key=${translationKey} dropped ${locales.join(", ")}`
      );
    },
    []
  );

  /** When switching to a different item */
  const onItemSwitch = useCallback(() => {
    debugLog.transition("onItemSwitch: clearing all caches");
    deletedTranslationKeysRef.current.clear();
    clearedDeletedByCopyRef.current.clear();
    clearedLocaleMarksByCopyRef.current.clear();
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
    clearedDeletedByCopyRef.current.clear();
    clearedLocaleMarksByCopyRef.current.clear();
  }, []);

  /**
   * The detached re-translation the merchant's own primary save started
   * (`reconcileAfterPrimarySave`) has finished, and the loader has just been
   * re-read. The SERVER now holds the truth about every foreign value of this
   * item, and two of the overlays here would hide it.
   *
   * `deletedTranslationKeysRef` is the load-bearing one: a primary save adds
   * every changed field's translation key to it ("show empty, even if a
   * revalidation brings the value back"), which is exactly right while the
   * server is deleting those translations — and exactly wrong the moment the AI
   * has written new ones. Left standing it turns the feature into its own
   * symptom: the languages the run just filled keep rendering empty, which is
   * the complaint this whole mechanism answers. `onSaveComplete` clears it on
   * the save response, so in practice it is already empty here; clearing it
   * again costs nothing and means a future save path that keeps entries past
   * its response cannot silently re-introduce the bug.
   *
   * `localTranslationsRef` is dropped for the same reason one level down: every
   * value in it mirrors something the server already stores (a saved foreign
   * value, or a translate-to-all-locales run that registered on Shopify before
   * answering), so re-reading it from the loader can only be more current — and
   * a stale entry for a locale the AI has just rewritten would win over the new
   * text and be written straight back by the next save.
   *
   * `savedPrimaryValuesRef` is deliberately NOT touched: it holds what the
   * merchant just saved in the PRIMARY locale, which the AI never writes and
   * the loader may not have caught up with yet. `resolveAll` retires it by
   * itself once the server agrees.
   *
   * Nothing here reads or writes `editableValues` — the caller owns the
   * merchant's unsaved input, and the refresh is only ever allowed to run when
   * there is none (see `useUnifiedContentEditor`).
   */
  const onBackgroundRetranslation = useCallback(() => {
    debugLog.transition("onBackgroundRetranslation: dropping foreign overlays, server wins");
    deletedTranslationKeysRef.current.clear();
    clearedDeletedByCopyRef.current.clear();
    clearedLocaleMarksByCopyRef.current.clear();
    localTranslationsRef.current = {};
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
    onCopyToLocalesFailed,
    onItemSwitch,
    onRefresh,
    onBackgroundRetranslation,
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

/**
 * UnifiedFieldRenderer — renders a single content field with AI controls.
 *
 * Extracted from UnifiedContentEditor to keep each file focused on one concern.
 */

import type { ReactElement } from "react";
import { isThemeContentType } from "~/utils/content-type-groups";
import { Text, Tooltip } from "@shopify/polaris";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { AttributeField } from "./unified/AttributeField";
import { CollectionRulesField } from "./unified/CollectionRulesField";
import { TaxonomyField } from "./unified/TaxonomyField";
import { CollectionsField } from "./unified/CollectionsField";
import { isAttributeField } from "../services/content-attributes.shared";
import { useSeoSettings } from "../contexts/SeoSettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { resolveSeoLimits } from "../utils/character-limits";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { hasFieldMissingTranslations } from "../utils/field-validation.utils";
import type { ValidationOverlays } from "../utils/field-validation.utils";
import type { FieldDefinition, ContentType } from "../types/content-editor.types";
import { IMAGE_ALL_LOCALES_AI_ACTIONS, IMAGE_PER_LOCALE_AI_ACTIONS } from "../constants/ai-actions";

export interface FieldRendererProps {
  field: FieldDefinition;
  value: string;
  onChange: (value: string) => void;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated: boolean;
  isLoading: boolean;
  isDataLoading?: boolean;
  sourceTextAvailable: boolean;
  /** If true, only "Improve with AI" is shown (disabled when empty). Used for templates. */
  disableGeneration?: boolean;
  /** If true, the value is a fallback from primary locale (shown in gray) */
  isFallbackValue?: boolean;
  /** If true, the field is read-only (disabled). Used when primary locale template editing is not enabled. */
  readOnly?: boolean;
  /** If true, the read-only reason is app-embed technical content — swaps the tooltip hint. */
  embedTechnical?: boolean;
  /** Selected market ("" = global). A non-global market locks the URL handle. */
  selectedMarketId?: string;
  /** Error message shown below the field (e.g. AI translation failed due to text being too long) */
  fieldError?: string;
  /** Receives the merchant's ad-hoc instruction from the AIInstructionPrompt box (undefined = generate as before). */
  onGenerateAI?: (userInstruction?: string) => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onCopy?: () => void;
  onCopyToAllLocales?: () => void;
  onAcceptSuggestion: () => void;
  onAcceptAndTranslate: () => void;
  onRejectSuggestion: () => void;
  onClear?: () => void;
  htmlMode: "html" | "rendered";
  onToggleHtmlMode: () => void;
  shopLocales: any[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: any;
  contentType: string;
  t: any;
  validationOverlays?: ValidationOverlays;
  /** PLAN §Phase 3 — tags already in use in this shop, for the `tags` field's
   *  autocomplete. Derived from the loaded list, so it costs no extra query and
   *  is naturally scoped to the resource the merchant is editing. */
  tagSuggestions?: string[];
  /** PLAN §2.4 — false ⇒ the item's attribute block has never been fetched, so
   *  the values in it are the migration's defaults and not the merchant's data.
   *  The attribute controls lock and say so instead of inviting an edit that
   *  would overwrite what is actually in the shop. */
  attributesKnown?: boolean;
  /** The way out of that state. */
  onReloadAttributes?: () => void;
  /** PLAN §Phase 3.1 — the API version the app talks to. The rule editor needs
   *  2026-07; below that `sources[]` does not exist and it says so instead of
   *  offering a control that cannot work. */
  apiVersion?: string;
  /** Shop currency ("EUR"), shown as the `money` field's suffix. Currency is
   *  shop-wide, never per field — the same rule the bulk money columns follow. */
  currencyCode?: string;
}

export function UnifiedFieldRenderer(
  props: FieldRendererProps & { state?: any; handlers?: any; fetcherState?: string; fetcherFormData?: FormData }
) {
  const {
    field,
    value,
    onChange,
    suggestion,
    isPrimaryLocale,
    isTranslated,
    isLoading,
    isDataLoading,
    sourceTextAvailable,
    disableGeneration,
    isFallbackValue,
    readOnly,
    embedTechnical,
    selectedMarketId,
    fieldError,
    onGenerateAI,
    onFormatAI,
    onTranslate,
    onTranslateToAllLocales,
    onCopy,
    onCopyToAllLocales,
    onAcceptSuggestion,
    onAcceptAndTranslate,
    onRejectSuggestion,
    onClear,
    htmlMode,
    onToggleHtmlMode,
    shopLocales,
    currentLanguage,
    primaryLocale,
    selectedItem,
    contentType,
    t,
    state,
    handlers,
    fetcherState,
    fetcherFormData,
    validationOverlays,
    tagSuggestions = [],
    attributesKnown,
    onReloadAttributes,
    currencyCode,
    apiVersion = "",
  } = props;

  const currentAction = fetcherFormData?.get("action");
  const fetcherTargetLocale = fetcherFormData?.get("targetLocale") as string | null;
  const fetcherItemId = fetcherFormData?.get("itemId") as string | null;
  const isSameItem = fetcherItemId === selectedItem?.id;
  const isImageAIActionRunning =
    fetcherState !== "idle" &&
    isSameItem &&
    (IMAGE_ALL_LOCALES_AI_ACTIONS.includes(currentAction as any) ||
      (IMAGE_PER_LOCALE_AI_ACTIONS.includes(currentAction as any) &&
        fetcherTargetLocale === currentLanguage));

  const { locale: appLocale } = useI18n();
  const { seoTitleSuffix, seoLimits } = useSeoSettings();
  const activeLimits = resolveSeoLimits(seoLimits ?? null);
  const localeName = getLocalizedLanguageName(
    currentLanguage,
    appLocale,
    shopLocales.find((l: any) => l.locale === currentLanguage)?.name
  );

  const fieldLabelMap: Record<string, string> = t.content?.fieldLabels || {};
  const translatedFieldLabel = fieldLabelMap[field.key] || field.label;
  const label = `${translatedFieldLabel} (${localeName})`;

  let helpText = "";
  if (typeof field.helpText === "function") {
    helpText = field.helpText(value);
  } else if (field.helpText) {
    helpText = field.helpText;
  } else if (field.type === "text" || field.type === "textarea") {
    const chars = t.content?.characters || "characters";
    const rec = t.content?.recommended || "recommended";
    if (field.key === "seoTitle") {
      // Upper limit adjusts for Shopify's shop-name suffix; lower limit
      // comes from the merchant setting (default 30). seoTitleMin === 1
      // means the merchant disabled the floor — show only the "N / max"
      // form so the hint stays clean.
      const cap = activeLimits.seoTitleMax;
      if (seoTitleSuffix) {
        const combined = value.length + seoTitleSuffix.length;
        helpText = `${combined} / ${cap} ${chars}`;
      } else {
        helpText = activeLimits.seoTitleMin > 1
          ? `${value.length} / ${cap} ${chars} (${rec}: ${activeLimits.seoTitleMin}-${cap})`
          : `${value.length} / ${cap} ${chars}`;
      }
    } else if (field.key === "metaDescription") {
      helpText = `${value.length} ${chars} (${rec}: ${activeLimits.metaDescMin}-${activeLimits.metaDescMax})`;
    } else if (field.key === "title") {
      helpText = `${value.length} ${chars} (${rec}: ${activeLimits.titleMin}-${activeLimits.titleMax})`;
    } else {
      helpText = `${value.length} ${chars}`;
    }
  }

  const helpKeyMap: Record<string, string> = {
    title: "title",
    description: "description",
    body: "description",
    handle: "handle",
    seoTitle: "seoTitle",
    metaDescription: "metaDescription",
    altText: "altText",
    productType: "productType",
  };
  const helpKey = helpKeyMap[field.key];

  const requiredIndicator =
    isPrimaryLocale &&
    !readOnly &&
    (isThemeContentType(contentType) ||
      contentType === "metaobjects" ||
      (contentType === "products" && field.key === "title"));

  // Pass the field's actual Shopify translation key (not field.key). The UI field
  // key and the translation key diverge for some fields — e.g. article "body" →
  // "body_html", "summary" → "summary_html", page "body" → "body_html". Using
  // field.key would make hasFieldMissingTranslations look up translations under the
  // wrong key and report them as permanently missing (blue highlight in primary).
  const fieldHasMissingTranslations = isPrimaryLocale
    ? hasFieldMissingTranslations(selectedItem, field.translationKey ?? field.key, shopLocales, primaryLocale, contentType as ContentType, validationOverlays)
    : false;

  // Custom render function (if provided)
  if (field.renderField) {
    return field.renderField({
      field,
      value,
      onChange,
      suggestion,
      isPrimaryLocale,
      isTranslated,
      isLoading,
      sourceTextAvailable,
      onGenerateAI,
      onFormatAI,
      onTranslate,
      onTranslateToAllLocales,
      onCopy,
      onCopyToAllLocales,
      onAcceptSuggestion,
      onAcceptAndTranslate,
      onRejectSuggestion,
      htmlMode,
      onToggleHtmlMode,
      shopLocales,
      currentLanguage,
      t,
    });
  }

  // Image Gallery Field
  if (field.type === "image-gallery") {
    const hasImages = selectedItem?.images && selectedItem.images.length > 0;
    const hasFeaturedImage = selectedItem?.featuredImage;

    if (!selectedItem || (!hasImages && !hasFeaturedImage)) {
      return null;
    }

    return (
      <ImageGalleryField
        images={selectedItem.images || []}
        featuredImage={selectedItem.featuredImage}
        currentLanguage={currentLanguage}
        primaryLocale={primaryLocale}
        isPrimaryLocale={isPrimaryLocale}
        isFreePlan={false}
        shopLocales={shopLocales}
        altTexts={state.imageAltTexts}
        altTextFallbackIndices={state.fallbackAltTextIndices}
        onAltTextChange={handlers.handleAltTextChange}
        onGenerateAltText={handlers.handleGenerateAltText}
        onGenerateAllAltTexts={handlers.handleGenerateAllAltTexts}
        onCopyAltText={handlers.handleCopyAltText}
        onCopyAltTextToAllLocales={handlers.handleCopyAltTextToAllLocales}
        onTranslateAltText={handlers.handleTranslateAltText}
        onTranslateAltTextToAllLocales={handlers.handleTranslateAltTextToAllLocales}
        onTranslateAllAltTexts={handlers.handleTranslateAllAltTexts}
        onTranslateAllAltTextsForLocale={handlers.handleTranslateAllAltTextsForLocale}
        altTextSuggestions={state.altTextSuggestions}
        onAcceptSuggestion={handlers.handleAcceptAltTextSuggestion}
        onAcceptAndTranslateSuggestion={handlers.handleAcceptAndTranslateAltText}
        onRejectSuggestion={handlers.handleRejectAltTextSuggestion}
        onClearAltText={(imageIndex) => handlers.handleAltTextChange(imageIndex, "")}
        isFieldLoading={(imageIndex) => {
          const isBulkTranslating =
            (state?.loadingFieldKeys?.has("allAltTextsTranslate") ?? false) ||
            (state?.loadingFieldKeys?.has(`allAltTextsTranslate_${currentLanguage}`) ?? false);
          const isBulkGenerating = state?.loadingFieldKeys?.has("allAltTextsGenerate") ?? false;
          if (imageIndex === -1) return isImageAIActionRunning || isBulkTranslating || isBulkGenerating;
          return (
            isImageAIActionRunning ||
            isBulkTranslating ||
            isBulkGenerating ||
            (state?.loadingFieldKeys?.has(`altText_${imageIndex}`) ?? false)
          );
        }}
        t={{
          image: t.products?.image || "Image",
          featuredImage: t.products?.featuredImage || "Featured Image",
          altTextForImage: t.products?.altTextForImage || "Alt-text for image",
          altTextPlaceholder: t.products?.altTextPlaceholder || "Describe the image...",
          generateAllAltTexts: t.products?.generateAllAltTexts || "Generate all alt-texts",
          translateAllAltTexts: t.products?.translateAllAltTexts || "Translate all alt-texts",
          onlyFeaturedImageAvailable:
            t.products?.onlyFeaturedImageAvailable ||
            "Only the featured image is available in the free plan.",
          additionalImagesLocked: t.products?.additionalImagesLocked || "Additional images are locked",
          availableInBasicPlan:
            t.products?.availableInBasicPlan || "Available in Basic plan and above",
          altBadge: t.imageManager?.altBadge || "ALT",
          noAltBadge: t.imageManager?.noAltBadge || "NO ALT",
        }}
      />
    );
  }

  // ── PLAN §Phase 3.1 — the product taxonomy ───────────────────────────────
  // Its own branch, not a case inside AttributeField: the value is a GID and
  // the LABEL lives on the item, so it needs a second input the generic
  // attribute control has no shape for.
  if (field.type === "taxonomy") {
    return (
      <TaxonomyField
        value={value}
        onChange={onChange}
        currentLabel={(selectedItem?.categoryName as string) || ""}
        label={translatedFieldLabel}
        // Same rule as every other attribute: one value per product, so a
        // foreign locale reads it only — WITH the reason, never in silence.
        disabled={!isPrimaryLocale}
        foreignLocaleHint={isPrimaryLocale ? undefined : t.content?.attributesForeignLocale}
        // §2.4 — the same discriminator the neighbouring attribute fields read.
        // Without it an unsynced row renders a confident "Not set" next to
        // fields correctly saying "not loaded yet".
        known={attributesKnown !== false}
        onReload={onReloadAttributes}
        t={(t.content?.taxonomy ?? {}) as Record<string, string>}
      />
    );
  }

  // ── PLAN §Phase 3.1 — collection membership ──────────────────────────────
  if (field.type === "collections") {
    return (
      <CollectionsField
        value={value}
        onChange={onChange}
        memberships={
          Array.isArray(selectedItem?.collections)
            ? (selectedItem.collections as Array<{ id: string; title?: string; automated?: boolean | null }>).map((c) => ({
                collectionId: c.id,
                collectionTitle: c.title ?? "",
                // `null` stays null — unknown is not manual, and the picker
                // locks it rather than offering a change Shopify would refuse.
                automated: c.automated ?? null,
              }))
            : []
        }
        truncated={selectedItem?.hasMoreCollections === true}
        onReload={onReloadAttributes}
        // `collections: null` means the row was never attribute-synced — the
        // same discriminator every other attribute reads. An empty list would
        // say "in no collections", which the save would then act on.
        known={Array.isArray(selectedItem?.collections)}
        label={translatedFieldLabel}
        disabled={!isPrimaryLocale}
        t={{
          ...((t.content?.collectionsField ?? {}) as Record<string, string>),
          // The same sentence the other attribute fields show in a foreign
          // locale — greying every box with no reason is the "DISABLE +
          // tooltip, don't hide" rule half-applied.
          ...(isPrimaryLocale ? {} : { foreignLocale: t.content?.attributesForeignLocale }),
        }}
      />
    );
  }

  // ── PLAN §Phase 3.1 — the rule editor for an existing collection ─────────
  // Its own branch rather than a case inside AttributeField: it carries state
  // of its own (an array of sources), its own validation, and its own reason
  // for being unavailable — the API VERSION, not the plan and not the locale.
  if (field.type === "collectionRules") {
    return (
      <CollectionRulesField
        // Keyed on the item so the "advanced" disclosure does not survive a
        // switch to another collection — it was opened about THIS rule set.
        key={selectedItem?.id ? String(selectedItem.id) : "collection-rules"}
        value={value}
        onChange={onChange}
        label={translatedFieldLabel}
        isPrimaryLocale={isPrimaryLocale}
        apiVersion={apiVersion}
        adminUrlForCollection={
          selectedItem?.id ? `shopify://admin/collections/${String(selectedItem.id).split("/").pop()}` : undefined
        }
        t={t}
      />
    );
  }

  // ── PLAN §Phase 3 merchandising attributes ───────────────────────────────
  // Handled before the read-only plumbing below because none of it applies:
  // these fields carry no AI actions, no translate/copy buttons and no
  // suggestion state, and their one locked case (a foreign locale) has a
  // reason of its own that the generic hint would get wrong.
  if (isAttributeField(field)) {
    const suggestions: string[] = field.suggestionsKey ? tagSuggestions : [];
    // Enum labels are shared with the create modal
    // (`t.content.createModal.options`, keyed `"status.DRAFT"`) rather than
    // duplicated: the two surfaces offer the same values, and a status the
    // modal calls "Draft" while the editor calls it "DRAFT" reads as two
    // different things.
    const optionLabels: Record<string, string> = t.content?.createModal?.options || {};
    const localizedField = {
      ...field,
      ...(field.type === "money" ? { currencyCode } : {}),
      ...(field.options
        ? {
            options: field.options.map((o) => ({
              ...o,
              label: (o.labelKey && optionLabels[o.labelKey]) || optionLabels[`${field.key}.${o.value}`] || o.label,
            })),
          }
        : {}),
    };
    return (
      <AttributeField
        field={localizedField}
        value={value}
        onChange={onChange}
        label={translatedFieldLabel}
        isPrimaryLocale={isPrimaryLocale}
        readOnly={readOnly}
        attributesKnown={attributesKnown}
        onReloadAttributes={onReloadAttributes}
        readOnlyHint={
          t.content?.primaryReadOnlyHint ||
          "This field can't be edited in the main language here — manage the original in your Shopify admin."
        }
        suggestions={suggestions}
        t={{
          notTranslatable: t.content?.attributesForeignLocale,
          addTag: t.content?.addTag,
          add: t.common?.add,
          yes: t.common?.yes,
          no: t.common?.no,
          notSyncedYet: t.content?.attributesNotSyncedYet,
          reload: t.common?.reload,
        }}
      />
    );
  }

  // Options Field
  if (field.type === "options") {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Options field (requires custom implementation per content type)
      </Text>
    );
  }

  const shouldShowClear = !(field.key === "title" && isPrimaryLocale);

  // Read-only fields get a hover tooltip explaining why they can't be edited.
  // The URL handle (slug) cannot be customized per market — Shopify only allows
  // translating it per locale, never a market-specific override. So in a
  // non-global market context the slug is locked (read-only, no translate/copy/
  // clear); it shows the inherited locale value greyed, with its own hint.
  const slugMarketLocked =
    field.type === "slug" && !isPrimaryLocale && !!selectedMarketId;
  // PLAN §Phase 3.5 — a field Shopify stores ONCE per item (vendor, author,
  // template suffix) has nothing to translate. Left editable it would accept a
  // foreign-locale edit and write it to the primary value, which reads as a
  // lost save. `productType` is deliberately not in this class: it IS
  // translatable, shop-wide, through GroupedFieldTranslation.
  const attributeForeignLocked = field.supportsTranslation === false && !isPrimaryLocale;
  const effectiveReadOnly = readOnly || slugMarketLocked || attributeForeignLocked;

  // App-embed technical fields (CSS selectors / config) are locked in EVERY
  // locale, so they get a dedicated hint; the market-locked slug gets its own;
  // other read-only fields (main language of resource-backed rubrics like
  // Abo-Pläne) get the primary-read-only hint.
  const readOnlyHint = String(
    attributeForeignLocked
      ? (t.content?.attributesForeignLocale ||
         "This detail exists once per item, not per language. Switch to the main language to change it.")
      : slugMarketLocked
      ? (t.content?.slugMarketLockedHint ||
         "The URL handle can't be customized per market — Shopify only allows translating it per language. The global (translated) handle is used for every market.")
      : embedTechnical
      ? (t.content?.appEmbedReadOnlyHint ||
         "Technical app-embed element — it can't be edited in the main language or in translations, because changing it would break the embed.")
      : (t.content?.primaryReadOnlyHint ||
         "This field can't be edited in the main language here — manage the original in your Shopify admin. You can still translate it into other languages.")
  );
  const withReadOnlyTooltip = (el: ReactElement): ReactElement =>
    effectiveReadOnly ? (
      <Tooltip content={readOnlyHint} dismissOnMouseOut preferredPosition="above">
        <div>{el}</div>
      </Tooltip>
    ) : el;

  // HTML Field
  if (field.type === "html") {
    return withReadOnlyTooltip(
      <AIEditableHTMLField
        label={label}
        value={value}
        onChange={onChange}
        mode={htmlMode}
        onToggleMode={onToggleHtmlMode}
        fieldType={field.key}
        fieldKey={field.key}
        suggestion={suggestion}
        isPrimaryLocale={isPrimaryLocale}
        isTranslated={isTranslated}
        helpKey={helpKey}
        isLoading={isLoading}
        isDataLoading={isDataLoading}
        sourceTextAvailable={sourceTextAvailable}
        disableGeneration={disableGeneration}
        isFallbackValue={isFallbackValue}
        readOnly={readOnly}
        requiredIndicator={requiredIndicator}
        aiPromptScopeKey={`${selectedItem?.id ?? ""}|${currentLanguage}`}
        hasFieldMissingTranslations={fieldHasMissingTranslations}
        onGenerateAI={field.supportsAI !== false ? onGenerateAI : undefined}
        onFormatAI={field.supportsFormatting !== false ? onFormatAI : undefined}
        onTranslate={field.supportsTranslation !== false ? onTranslate : undefined}
        onTranslateToAllLocales={field.supportsTranslation !== false ? onTranslateToAllLocales : undefined}
        onCopy={field.supportsTranslation !== false ? onCopy : undefined}
        onCopyToAllLocales={field.supportsTranslation !== false ? onCopyToAllLocales : undefined}
        onAcceptSuggestion={onAcceptSuggestion}
        onAcceptAndTranslate={onAcceptAndTranslate}
        onRejectSuggestion={onRejectSuggestion}
        onClear={shouldShowClear ? onClear : undefined}
      />
    );
  }

  // Default: Use AIEditableField for text, slug, textarea, number
  return withReadOnlyTooltip(
    <AIEditableField
      label={label}
      value={value}
      onChange={onChange}
      fieldType={field.key}
      fieldKey={field.key}
      suggestion={suggestion}
      isPrimaryLocale={isPrimaryLocale}
      isTranslated={isTranslated}
      helpText={helpText}
      helpKey={helpKey}
      multiline={field.multiline}
      isLoading={isLoading}
      isDataLoading={isDataLoading}
      sourceTextAvailable={sourceTextAvailable}
      disableGeneration={disableGeneration}
      isFallbackValue={isFallbackValue}
      readOnly={effectiveReadOnly}
      requiredIndicator={requiredIndicator}
      aiPromptScopeKey={`${selectedItem?.id ?? ""}|${currentLanguage}`}
      error={fieldError}
      hasFieldMissingTranslations={fieldHasMissingTranslations}
      seoSuffix={field.key === "seoTitle" && seoTitleSuffix ? seoTitleSuffix : undefined}
      onGenerateAI={slugMarketLocked ? undefined : (field.supportsAI !== false ? onGenerateAI : undefined)}
      onFormatAI={slugMarketLocked ? undefined : (field.supportsFormatting !== false ? onFormatAI : undefined)}
      onTranslate={slugMarketLocked ? undefined : (field.supportsTranslation !== false ? onTranslate : undefined)}
      onTranslateToAllLocales={slugMarketLocked ? undefined : (field.supportsTranslation !== false ? onTranslateToAllLocales : undefined)}
      onCopy={slugMarketLocked ? undefined : (field.supportsTranslation !== false ? onCopy : undefined)}
      onCopyToAllLocales={slugMarketLocked ? undefined : (field.supportsTranslation !== false ? onCopyToAllLocales : undefined)}
      onAcceptSuggestion={onAcceptSuggestion}
      onAcceptAndTranslate={onAcceptAndTranslate}
      onRejectSuggestion={onRejectSuggestion}
      onClear={slugMarketLocked ? undefined : (shouldShowClear ? onClear : undefined)}
    />
  );
}

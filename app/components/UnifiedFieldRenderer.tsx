/**
 * UnifiedFieldRenderer — renders a single content field with AI controls.
 *
 * Extracted from UnifiedContentEditor to keep each file focused on one concern.
 */

import { Text } from "@shopify/polaris";
import { AIEditableField } from "./AIEditableField";
import { AIEditableHTMLField } from "./AIEditableHTMLField";
import { ImageGalleryField } from "./unified/ImageGalleryField";
import { useSeoSettings } from "../contexts/SeoSettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { hasFieldMissingTranslations } from "../utils/field-validation.utils";
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
  /** Error message shown below the field (e.g. AI translation failed due to text being too long) */
  fieldError?: string;
  onGenerateAI?: () => void;
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
  const { seoTitleSuffix } = useSeoSettings();
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
      if (seoTitleSuffix) {
        const combined = value.length + seoTitleSuffix.length;
        helpText = `${combined} / 60 ${chars}`;
      } else {
        helpText = `${value.length} / 60 ${chars} (${rec}: 50-60)`;
      }
    } else if (field.key === "metaDescription") {
      helpText = `${value.length} ${chars} (${rec}: 150-160)`;
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
    (contentType === "templates" ||
      contentType === "metaobjects" ||
      (contentType === "products" && field.key === "title"));

  const fieldHasMissingTranslations = isPrimaryLocale
    ? hasFieldMissingTranslations(selectedItem, field.key, shopLocales, primaryLocale, contentType as ContentType)
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
        altTexts={state.imageAltTexts}
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

  // HTML Field
  if (field.type === "html") {
    return (
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
        readOnly={readOnly}
        requiredIndicator={requiredIndicator}
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
  return (
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
      readOnly={readOnly}
      requiredIndicator={requiredIndicator}
      error={fieldError}
      hasFieldMissingTranslations={fieldHasMissingTranslations}
      seoSuffix={field.key === "seoTitle" && seoTitleSuffix ? seoTitleSuffix : undefined}
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

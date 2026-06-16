import { TextField, Button, InlineStack } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { HelpTooltip } from "./HelpTooltip";
import { useI18n } from "../contexts/I18nContext";
import "../styles/AIEditableField.css";

interface AIEditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fieldType: string;
  fieldKey?: string;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated?: boolean;
  helpText?: string;
  /** Key for help tooltip content from translations (e.g., "title", "description") */
  helpKey?: string;
  multiline?: number;
  maxLength?: number;
  placeholder?: string;
  isLoading?: boolean;
  isDataLoading?: boolean;
  sourceTextAvailable?: boolean;
  hasMissingTranslations?: boolean;
  hasFieldMissingTranslations?: boolean;
  /** If true, only "Improve with AI" is shown (disabled when empty). Used for templates. */
  disableGeneration?: boolean;
  /** If true, the value is a fallback from primary locale (shown in gray) */
  isFallbackValue?: boolean;
  /** If true, the field is read-only (disabled). Used when primary locale template editing is not enabled. */
  readOnly?: boolean;
  /** If true, show required indicator (red asterisk) */
  requiredIndicator?: boolean;
  /** Suffix appended by Shopify (e.g. " – Shop Name"). Displayed inside the field non-editable, and counted in char limit. */
  seoSuffix?: string;
  /** Error message shown below the field (e.g. when AI translation fails due to text being too long) */
  error?: string;
  onGenerateAI?: () => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onCopy?: () => void;
  onCopyToAllLocales?: () => void;
  onAcceptSuggestion?: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion?: () => void;
  onClear?: () => void;
}

export function AIEditableField({
  label,
  value,
  onChange,
  fieldType,
  fieldKey,
  suggestion,
  isPrimaryLocale,
  isTranslated = true,
  helpText,
  helpKey,
  multiline,
  maxLength,
  placeholder,
  isLoading = false,
  isDataLoading = false,
  sourceTextAvailable = true,
  hasMissingTranslations = false,
  hasFieldMissingTranslations,
  disableGeneration = false,
  isFallbackValue = false,
  readOnly = false,
  requiredIndicator = false,
  seoSuffix,
  error,
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
}: AIEditableFieldProps) {
  const { t } = useI18n();

  // Determine background color class based on translation state
  const getBackgroundClass = () => {
    // During initial data loading, show white to prevent flash
    if (isDataLoading) return "bg-white";

    // Priority 1: AI suggestion is active (light blue)
    if (suggestion) return "bg-suggestion";

    // Priority 2: Primary locale is empty (orange)
    if (isPrimaryLocale && !value) return "bg-untranslated";

    // Priority 3: Primary locale has content but THIS FIELD has missing translations (blue)
    // Use field-specific check if provided, otherwise fall back to global check
    const fieldHasMissingTranslations = hasFieldMissingTranslations !== undefined
      ? hasFieldMissingTranslations
      : hasMissingTranslations;

    if (isPrimaryLocale && value && fieldHasMissingTranslations) return "bg-missing-translation";

    // Priority 4: Fallback value (gray) - works for both primary and foreign locales
    // Example: SEO Title field using Product Title as fallback
    if (isFallbackValue) return "bg-fallback";

    // Priority 5: Foreign locale - orange if not translated, white if translated
    if (!isPrimaryLocale) {
      return isTranslated ? "bg-white" : "bg-untranslated";
    }

    // Default: White for primary locale with content
    return "bg-white";
  };

  return (
    <div>
      <div className={`ai-editable-field-wrapper ${getBackgroundClass()}`} style={{ position: "relative" }}>
        {onClear && value && (
          <div style={{ position: "absolute", top: "0", right: "0", zIndex: 10 }}>
            <Button
              size="slim"
              onClick={onClear}
              tone="critical"
              variant="plain"
            >
              {t.common?.clear || "Clear"}
            </Button>
          </div>
        )}
        <TextField
          label={
            <InlineStack gap="100" blockAlign="center">
              <span style={{ fontWeight: 600 }}>
                {label}{requiredIndicator && <span style={{ color: 'var(--p-color-text-critical)' }}> *</span>}
              </span>
              {helpKey && <HelpTooltip helpKey={helpKey} />}
            </InlineStack>
          }
          value={value}
          onChange={onChange}
          disabled={readOnly}
          autoComplete="off"
          helpText={helpText}
          multiline={multiline}
          maxLength={maxLength}
          placeholder={placeholder}
          showCharacterCount={!!maxLength}
          error={error}
          suffix={seoSuffix ? (
            <span style={{ color: "#6d7175", whiteSpace: "nowrap" }}>{seoSuffix}</span>
          ) : undefined}
        />
      </div>

      {suggestion && onAcceptSuggestion && onRejectSuggestion && (
        <AISuggestionBanner
          fieldType={fieldType}
          suggestionText={suggestion}
          isHtml={false}
          onAccept={onAcceptSuggestion}
          onDecline={onRejectSuggestion}
          onAcceptAndTranslate={onAcceptAndTranslate}
          acceptLabel={t.products?.accept || "Accept"}
          declineLabel={t.products?.decline || "Decline"}
          acceptAndTranslateLabel={onAcceptAndTranslate ? (t.products?.acceptTranslate || "Accept & Translate") : undefined}
          titleLabel={t.products?.aiSuggestion || "AI suggestion:"}
        />
      )}

      <div className="ai-field-footer">
        <div className="ai-field-footer-right">
          {onGenerateAI && (
            <Button
              size="slim"
              onClick={onGenerateAI}
              loading={isLoading}
              disabled={(disableGeneration && !value) || isLoading}
            >
              ✨ {disableGeneration || value
                ? (t.products?.aiImprove || "Improve with AI")
                : (t.products?.aiGenerateShort || "Generate with AI")}
            </Button>
          )}
          {onFormatAI && (
            <Button
              size="slim"
              onClick={onFormatAI}
              loading={isLoading}
              disabled={!value || isLoading}
            >
              🎨 {t.products?.formatWithAI || "Format"}
            </Button>
          )}
          {(onTranslate || onTranslateToAllLocales) && (
            <Button
              size="slim"
              onClick={isPrimaryLocale ? (onTranslateToAllLocales || onTranslate) : onTranslate}
              loading={isLoading}
              disabled={(isPrimaryLocale ? (!onTranslateToAllLocales && !onTranslate) : !sourceTextAvailable) || isLoading}
            >
              🌍 {isPrimaryLocale ? (t.products?.translate || "Translate") : t.products?.translateFromPrimary}
            </Button>
          )}
          {(onCopy || onCopyToAllLocales) && (
            <Button
              size="slim"
              onClick={isPrimaryLocale ? onCopyToAllLocales : onCopy}
              loading={isLoading}
              disabled={isPrimaryLocale ? (!value || isLoading) : (!sourceTextAvailable || isLoading)}
            >
              📋 {isPrimaryLocale
                ? (t.products?.copyToAllLocales || "Copy to all")
                : (t.products?.copy || "Copy")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

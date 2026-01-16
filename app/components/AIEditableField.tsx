import { TextField, Button } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
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
  multiline?: number;
  maxLength?: number;
  placeholder?: string;
  isLoading?: boolean;
  sourceTextAvailable?: boolean;
  hasMissingTranslations?: boolean;
  hasFieldMissingTranslations?: boolean;
  onGenerateAI?: () => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
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
  multiline,
  maxLength,
  placeholder,
  isLoading = false,
  sourceTextAvailable = true,
  hasMissingTranslations = false,
  hasFieldMissingTranslations = false,
  onGenerateAI,
  onFormatAI,
  onTranslate,
  onTranslateToAllLocales,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
  onClear,
}: AIEditableFieldProps) {
  const { t } = useI18n();

  // Determine background color class based on translation state
  const getBackgroundClass = () => {
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

    // Priority 4: Foreign locale - orange if not translated, white if translated
    if (!isPrimaryLocale) return isTranslated ? "bg-white" : "bg-untranslated";

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
              {t.common?.clear || t.products?.clear || "Clear"}
            </Button>
          </div>
        )}
        <TextField
          label={<span style={{ fontWeight: 600 }}>{label}</span>}
          value={value}
          onChange={onChange}
          autoComplete="off"
          multiline={multiline}
          maxLength={maxLength}
          placeholder={placeholder}
          showCharacterCount={!!maxLength}
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
          acceptLabel={t.products.accept || "Übernehmen"}
          declineLabel={t.products.decline || "Ablehnen"}
          acceptAndTranslateLabel={onAcceptAndTranslate ? (t.products.acceptTranslate || "Übernehmen & Übersetzen") : undefined}
          titleLabel={t.products.aiSuggestion || "KI-Vorschlag"}
        />
      )}

      <div className="ai-field-footer">
        <div className="ai-field-footer-left">
          {helpText && (
            <span style={{ fontSize: "0.8125rem", color: "#6d7175" }}>
              {helpText}
            </span>
          )}
        </div>
        <div className="ai-field-footer-right">
          {onGenerateAI && (
            <Button
              size="slim"
              onClick={onGenerateAI}
              loading={isLoading}
            >
              ✨ {t.products.aiGenerate}
            </Button>
          )}
          {onFormatAI && (
            <Button
              size="slim"
              onClick={onFormatAI}
              loading={isLoading}
              disabled={!value}
            >
              🎨 {t.products.formatWithAI || "Formatieren"}
            </Button>
          )}
          {(onTranslate || onTranslateToAllLocales) && (
            <Button
              size="slim"
              onClick={isPrimaryLocale ? onTranslateToAllLocales : onTranslate}
              loading={isLoading}
              disabled={(isPrimaryLocale && !onTranslateToAllLocales) || (!isPrimaryLocale && !sourceTextAvailable)}
            >
              🌍 {isPrimaryLocale ? (t.products.translate || "Übersetzen") : t.products.translateFromPrimary}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

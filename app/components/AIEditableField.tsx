import { TextField, Button } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { useI18n } from "../contexts/I18nContext";
import "../styles/AIEditableField.css";

interface AIEditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fieldType: string;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated?: boolean;
  helpText?: string;
  multiline?: number;
  maxLength?: number;
  placeholder?: string;
  isLoading?: boolean;
  onGenerateAI: () => void;
  onTranslate: () => void;
  onTranslateAll?: () => void;
  onAcceptSuggestion: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion: () => void;
}

export function AIEditableField({
  label,
  value,
  onChange,
  fieldType,
  suggestion,
  isPrimaryLocale,
  isTranslated = true,
  helpText,
  multiline,
  maxLength,
  placeholder,
  isLoading = false,
  onGenerateAI,
  onTranslate,
  onTranslateAll,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
}: AIEditableFieldProps) {
  const { t } = useI18n();

  // Determine background color class based on translation state
  const getBackgroundClass = () => {
    if (suggestion) return "bg-suggestion"; // Light blue when AI suggestion is active
    if (isPrimaryLocale) return "bg-white"; // White for primary locale
    return isTranslated ? "bg-white" : "bg-untranslated"; // Orange if not translated
  };

  return (
    <div>
      <div className={`ai-editable-field-wrapper ${getBackgroundClass()}`}>
        <TextField
          label={label}
          value={value}
          onChange={onChange}
          autoComplete="off"
          helpText={helpText}
          multiline={multiline}
          maxLength={maxLength}
          placeholder={placeholder}
          showCharacterCount={!!maxLength}
        />
      </div>

      {suggestion && (
        <AISuggestionBanner
          fieldType={fieldType}
          suggestionText={suggestion}
          isHtml={false}
          onAccept={onAcceptSuggestion}
          onDecline={onRejectSuggestion}
          onAcceptAndTranslate={onAcceptAndTranslate}
          acceptLabel={t.products.acceptSuggestion || "Übernehmen"}
          declineLabel={t.products.rejectSuggestion || "Ablehnen"}
          acceptAndTranslateLabel={onAcceptAndTranslate ? (t.products.acceptAndTranslate || "Übernehmen & Übersetzen") : undefined}
          titleLabel={t.products.aiSuggestion || "KI-Vorschlag"}
        />
      )}

      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
        {isPrimaryLocale ? (
          <>
            <Button
              size="slim"
              onClick={onGenerateAI}
              loading={isLoading}
            >
              ✨ {t.products.aiGenerate}
            </Button>
            {onTranslateAll && (
              <Button
                size="slim"
                onClick={onTranslateAll}
                loading={isLoading}
              >
                🌍 Übersetzen
              </Button>
            )}
          </>
        ) : (
          <Button
            size="slim"
            onClick={onTranslate}
            loading={isLoading}
          >
            🌐 {t.products.translateFromPrimary}
          </Button>
        )}
      </div>
    </div>
  );
}

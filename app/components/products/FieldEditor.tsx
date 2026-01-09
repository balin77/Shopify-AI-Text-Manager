import { TextField, Button, Text } from "@shopify/polaris";
import { AISuggestionBox } from "./AISuggestionBox";

interface FieldEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fieldType: string;
  suggestion?: string;
  isPrimaryLocale: boolean;
  backgroundColor?: string;
  helpText?: string;
  multiline?: number;
  isLoading?: boolean;
  onGenerateAI: () => void;
  onTranslate: () => void;
  onAcceptSuggestion: () => void;
  onAcceptAndTranslate: () => void;
  onRejectSuggestion: () => void;
}

export function FieldEditor({
  label,
  value,
  onChange,
  fieldType,
  suggestion,
  isPrimaryLocale,
  backgroundColor = "white",
  helpText,
  multiline,
  isLoading = false,
  onGenerateAI,
  onTranslate,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
}: FieldEditorProps) {
  return (
    <div>
      <div style={{ background: backgroundColor, borderRadius: "8px", padding: "1px" }}>
        <TextField
          label={label}
          value={value}
          onChange={onChange}
          autoComplete="off"
          helpText={helpText}
          multiline={multiline}
        />
      </div>

      {suggestion && (
        <AISuggestionBox
          suggestion={suggestion}
          onAccept={onAcceptSuggestion}
          onAcceptAndTranslate={onAcceptAndTranslate}
          onReject={onRejectSuggestion}
        />
      )}

      <div style={{ marginTop: "0.5rem" }}>
        {isPrimaryLocale ? (
          <Button
            size="slim"
            onClick={onGenerateAI}
            loading={isLoading}
          >
            ✨ Mit KI generieren / verbessern
          </Button>
        ) : (
          <Button
            size="slim"
            onClick={onTranslate}
            loading={isLoading}
          >
            🌐 Aus Hauptsprache übersetzen
          </Button>
        )}
      </div>
    </div>
  );
}

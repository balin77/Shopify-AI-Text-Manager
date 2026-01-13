import { useRef } from "react";
import { Text, Button, ButtonGroup, InlineStack } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { useI18n } from "../contexts/I18nContext";
import "../styles/AIEditableField.css";

interface AIEditableHTMLFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mode: "html" | "rendered";
  onToggleMode: () => void;
  fieldType: string;
  fieldKey?: string;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated?: boolean;
  isLoading?: boolean;
  sourceTextAvailable?: boolean;
  hasMissingTranslations?: boolean;
  hasFieldMissingTranslations?: boolean;
  onGenerateAI: () => void;
  onTranslate: () => void;
  onTranslateAll?: () => void;
  onAcceptSuggestion: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion: () => void;
}

export function AIEditableHTMLField({
  label,
  value,
  onChange,
  mode,
  onToggleMode,
  fieldType,
  fieldKey,
  suggestion,
  isPrimaryLocale,
  isTranslated = true,
  isLoading = false,
  sourceTextAvailable = true,
  hasMissingTranslations = false,
  hasFieldMissingTranslations = false,
  onGenerateAI,
  onTranslate,
  onTranslateAll,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
}: AIEditableHTMLFieldProps) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);

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

  const handleFormatText = (command: string) => {
    if (mode !== "rendered" || !editorRef.current) return;

    editorRef.current.focus();

    switch (command) {
      case "bold":
        document.execCommand("bold", false);
        break;
      case "italic":
        document.execCommand("italic", false);
        break;
      case "underline":
        document.execCommand("underline", false);
        break;
      case "h1":
        document.execCommand("formatBlock", false, "<h1>");
        break;
      case "h2":
        document.execCommand("formatBlock", false, "<h2>");
        break;
      case "h3":
        document.execCommand("formatBlock", false, "<h3>");
        break;
      case "p":
        document.execCommand("formatBlock", false, "<p>");
        break;
      case "ul":
        document.execCommand("insertUnorderedList", false);
        break;
      case "ol":
        document.execCommand("insertOrderedList", false);
        break;
      case "br":
        document.execCommand("insertHTML", false, "<br>");
        break;
    }

    onChange(editorRef.current.innerHTML);
  };

  return (
    <div className={`ai-editable-html-field ${getBackgroundClass()}`}>
      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="bodyMd" fontWeight="bold">
          {label}
        </Text>
        <Button size="slim" onClick={onToggleMode}>
          {mode === "html" ? t.products.preview : t.products.html}
        </Button>
      </InlineStack>

      {mode === "rendered" && (
        <div
          style={{
            marginTop: "0.5rem",
            display: "flex",
            gap: "0.25rem",
            flexWrap: "wrap",
            padding: "0.5rem",
            background: "#f6f6f7",
            border: "1px solid #c9cccf",
            borderRadius: "8px 8px 0 0",
          }}
        >
          <ButtonGroup variant="segmented">
            <Button size="slim" onClick={() => handleFormatText("bold")}>
              B
            </Button>
            <Button size="slim" onClick={() => handleFormatText("italic")}>
              I
            </Button>
            <Button size="slim" onClick={() => handleFormatText("underline")}>
              U
            </Button>
          </ButtonGroup>
          <ButtonGroup variant="segmented">
            <Button size="slim" onClick={() => handleFormatText("h1")}>
              H1
            </Button>
            <Button size="slim" onClick={() => handleFormatText("h2")}>
              H2
            </Button>
            <Button size="slim" onClick={() => handleFormatText("h3")}>
              H3
            </Button>
          </ButtonGroup>
          <ButtonGroup variant="segmented">
            <Button size="slim" onClick={() => handleFormatText("ul")}>
              {t.products.formatting.list}
            </Button>
            <Button size="slim" onClick={() => handleFormatText("ol")}>
              {t.products.formatting.numberedList}
            </Button>
          </ButtonGroup>
          <ButtonGroup variant="segmented">
            <Button size="slim" onClick={() => handleFormatText("p")}>
              {t.products.formatting.paragraph}
            </Button>
            <Button size="slim" onClick={() => handleFormatText("br")}>
              {t.products.formatting.lineBreak}
            </Button>
          </ButtonGroup>
        </div>
      )}

      {mode === "html" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            minHeight: "200px",
            padding: "12px",
            border: "1px solid #c9cccf",
            borderRadius: "8px",
            fontFamily: "monospace",
            fontSize: "14px",
            marginTop: "0.5rem",
          }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          onInput={(e) => onChange(e.currentTarget.innerHTML)}
          dangerouslySetInnerHTML={{ __html: value }}
          style={{
            width: "100%",
            minHeight: "200px",
            padding: "12px",
            border: "1px solid #c9cccf",
            borderTop: mode === "rendered" ? "none" : "1px solid #c9cccf",
            borderRadius: mode === "rendered" ? "0 0 8px 8px" : "8px",
            lineHeight: "1.6",
          }}
          className="description-editor"
        />
      )}

      {suggestion && (
        <AISuggestionBanner
          fieldType={fieldType}
          suggestionText={suggestion}
          isHtml={true}
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
          <span style={{ fontSize: "0.8125rem", color: "#6d7175" }}>
            {value.replace(/<[^>]*>/g, "").length} {t.products.characters}
          </span>
        </div>
        <div className="ai-field-footer-right">
          <Button size="slim" onClick={onGenerateAI} loading={isLoading}>
            ✨ {t.products.aiGenerate}
          </Button>
          <Button
            size="slim"
            onClick={isPrimaryLocale ? onTranslateAll : onTranslate}
            loading={isLoading}
            disabled={(isPrimaryLocale && !onTranslateAll) || (!isPrimaryLocale && !sourceTextAvailable)}
          >
            🌍 {isPrimaryLocale ? "Übersetzen" : t.products.translateFromPrimary}
          </Button>
        </div>
      </div>
    </div>
  );
}

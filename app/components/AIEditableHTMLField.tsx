import { useRef, useEffect } from "react";
import { Text, Button, InlineStack } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { HelpTooltip } from "./HelpTooltip";
import { HtmlFormattingToolbar } from "./HtmlFormattingToolbar";
import { useI18n } from "../contexts/I18nContext";
import { useHtmlFormatting } from "../hooks/useHtmlFormatting";
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
  /** Key for help tooltip content from translations (e.g., "description") */
  helpKey?: string;
  isLoading?: boolean;
  isDataLoading?: boolean;
  sourceTextAvailable?: boolean;
  hasMissingTranslations?: boolean;
  hasFieldMissingTranslations?: boolean;
  /** If true, only "Improve with AI" is shown (disabled when empty). Used for templates. */
  disableGeneration?: boolean;
  onGenerateAI?: () => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onAcceptSuggestion?: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion?: () => void;
  onClear?: () => void;
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
  helpKey,
  isLoading = false,
  isDataLoading = false,
  sourceTextAvailable = true,
  hasMissingTranslations = false,
  hasFieldMissingTranslations = false,
  disableGeneration = false,
  onGenerateAI,
  onFormatAI,
  onTranslate,
  onTranslateToAllLocales,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
  onClear,
}: AIEditableHTMLFieldProps) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  const { executeCommand } = useHtmlFormatting({ editorRef, onChange });
  const isUserTypingRef = useRef(false);
  const lastEditorElementRef = useRef<HTMLDivElement | null>(null);

  // Initialize content when editor element changes (mode switch) or value changes externally
  useEffect(() => {
    if (!editorRef.current || mode !== "rendered") return;

    const isNewElement = editorRef.current !== lastEditorElementRef.current;

    // If it's a new element (after mode switch), always set content
    if (isNewElement) {
      editorRef.current.innerHTML = value;
      lastEditorElementRef.current = editorRef.current;
      return;
    }

    // Skip update if user is currently typing
    if (isUserTypingRef.current) return;

    // Only update if the content is actually different
    if (editorRef.current.innerHTML !== value) {
      // Save current cursor position
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const startOffset = range?.startOffset;
      const startContainer = range?.startContainer;

      // Update content
      editorRef.current.innerHTML = value;

      // Restore cursor position if possible
      if (startContainer && startOffset !== undefined && editorRef.current.contains(startContainer)) {
        try {
          const newRange = document.createRange();
          newRange.setStart(startContainer, Math.min(startOffset, startContainer.textContent?.length || 0));
          newRange.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(newRange);
        } catch (e) {
          // Cursor restoration failed, that's okay
        }
      }
    }
  }, [value, mode]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    isUserTypingRef.current = true;
    onChange(e.currentTarget.innerHTML);
    // Reset flag after a short delay
    setTimeout(() => {
      isUserTypingRef.current = false;
    }, 0);
  };

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

    // Priority 4: Foreign locale - orange if not translated, white if translated
    if (!isPrimaryLocale) return isTranslated ? "bg-white" : "bg-untranslated";

    // Default: White for primary locale with content
    return "bg-white";
  };

  const handleFormatText = (command: Parameters<typeof executeCommand>[0]) => {
    if (mode !== "rendered") return;
    executeCommand(command);
  };

  return (
    <div className={`ai-editable-html-field ${getBackgroundClass()}`}>
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="100" blockAlign="center">
          <Text as="p" variant="bodyMd" fontWeight="bold">
            {label}
          </Text>
          {helpKey && <HelpTooltip helpKey={helpKey} />}
        </InlineStack>
        <InlineStack gap="200">
          <Button size="slim" onClick={onToggleMode}>
            {mode === "html" ? t.products.preview : t.products.html}
          </Button>
          {onClear && value && (
            <Button
              size="slim"
              onClick={onClear}
              tone="critical"
              variant="plain"
            >
              {t.common?.clear || "Clear"}
            </Button>
          )}
        </InlineStack>
      </InlineStack>

      {mode === "rendered" && (
        <div style={{ marginTop: "0.5rem" }}>
          <HtmlFormattingToolbar onCommand={handleFormatText} />
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
          onInput={handleInput}
          suppressContentEditableWarning
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

      {suggestion && onAcceptSuggestion && onRejectSuggestion && (
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
          {onGenerateAI && (
            <Button size="slim" onClick={onGenerateAI} loading={isLoading} disabled={disableGeneration && !value}>
              ✨ {disableGeneration || value
                ? (t.products.aiImprove || "Improve with AI")
                : (t.products.aiGenerateShort || "Generate with AI")}
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

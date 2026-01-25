import { useRef, useEffect } from "react";
import { Text, Button, ButtonGroup, InlineStack, Tooltip } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
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
  const initializedRef = useRef(false);

  // Initialize content on first render and update only when value changes externally
  useEffect(() => {
    if (!editorRef.current) return;

    // On first render, set the initial content
    if (!initializedRef.current) {
      editorRef.current.innerHTML = value;
      initializedRef.current = true;
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
  }, [value]);

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
        <Text as="p" variant="bodyMd" fontWeight="bold">
          {label}
        </Text>
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
          {/* Text Formatting */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Fett">
              <Button size="slim" onClick={() => handleFormatText("bold")}>
                B
              </Button>
            </Tooltip>
            <Tooltip content="Kursiv">
              <Button size="slim" onClick={() => handleFormatText("italic")}>
                I
              </Button>
            </Tooltip>
            <Tooltip content="Unterstrichen">
              <Button size="slim" onClick={() => handleFormatText("underline")}>
                U
              </Button>
            </Tooltip>
            <Tooltip content="Durchgestrichen">
              <Button size="slim" onClick={() => handleFormatText("strikethrough")}>
                S
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Headings & Normal Text */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Überschrift 1">
              <Button size="slim" onClick={() => handleFormatText("h1")}>
                H1
              </Button>
            </Tooltip>
            <Tooltip content="Überschrift 2">
              <Button size="slim" onClick={() => handleFormatText("h2")}>
                H2
              </Button>
            </Tooltip>
            <Tooltip content="Überschrift 3">
              <Button size="slim" onClick={() => handleFormatText("h3")}>
                H3
              </Button>
            </Tooltip>
            <Tooltip content="Normaler Text / Absatz">
              <Button size="slim" onClick={() => handleFormatText("p")}>
                Text
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Lists */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Aufzählungsliste">
              <Button size="slim" onClick={() => handleFormatText("ul")}>
                {t.products.formatting.list}
              </Button>
            </Tooltip>
            <Tooltip content="Nummerierte Liste">
              <Button size="slim" onClick={() => handleFormatText("ol")}>
                {t.products.formatting.numberedList}
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Special Formats */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Zitat-Block">
              <Button size="slim" onClick={() => handleFormatText("blockquote")}>
                ""
              </Button>
            </Tooltip>
            <Tooltip content="Code-Block">
              <Button size="slim" onClick={() => handleFormatText("code")}>
                {"</>"}
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Links */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Link einfügen">
              <Button size="slim" onClick={() => handleFormatText("link")}>
                🔗
              </Button>
            </Tooltip>
            <Tooltip content="Link entfernen">
              <Button size="slim" onClick={() => handleFormatText("unlink")}>
                🔗✖
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Line Break */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Zeilenumbruch">
              <Button size="slim" onClick={() => handleFormatText("br")}>
                {t.products.formatting.lineBreak}
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Undo/Redo */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Rückgängig">
              <Button size="slim" onClick={() => handleFormatText("undo")}>
                ↶
              </Button>
            </Tooltip>
            <Tooltip content="Wiederholen">
              <Button size="slim" onClick={() => handleFormatText("redo")}>
                ↷
              </Button>
            </Tooltip>
          </ButtonGroup>

          {/* Clear Formatting */}
          <ButtonGroup variant="segmented">
            <Tooltip content="Formatierung entfernen">
              <Button size="slim" onClick={() => handleFormatText("removeFormat")} tone="critical">
                ✖
              </Button>
            </Tooltip>
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
            <Button size="slim" onClick={onGenerateAI} loading={isLoading} disabled={!value}>
              ✨ {t.products.aiImprove || "Improve with AI"}
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

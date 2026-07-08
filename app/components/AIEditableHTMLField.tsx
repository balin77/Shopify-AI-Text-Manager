import { useRef, useEffect, useMemo } from "react";
import { Text, Button, InlineStack, Banner } from "@shopify/polaris";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { HelpTooltip } from "./HelpTooltip";
import { HtmlFormattingToolbar } from "./HtmlFormattingToolbar";
import { useI18n } from "../contexts/I18nContext";
import { useHtmlFormatting } from "../hooks/useHtmlFormatting";
import { sanitizeHTML } from "../utils/sanitizer";
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
  /** If true, the value is a fallback from primary locale (shown in gray) */
  isFallbackValue?: boolean;
  /** If true, the field is read-only (disabled). Used when primary locale template editing is not enabled. */
  readOnly?: boolean;
  /** If true, show required indicator (red asterisk) */
  requiredIndicator?: boolean;
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
  hasFieldMissingTranslations,
  disableGeneration = false,
  isFallbackValue = false,
  readOnly = false,
  requiredIndicator = false,
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
}: AIEditableHTMLFieldProps) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  const { executeCommand } = useHtmlFormatting({ editorRef, onChange });
  const isUserTypingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEditorElementRef = useRef<HTMLDivElement | null>(null);

  // Shopify notification templates (EMAIL_TEMPLATE etc.) contain raw Liquid like
  // `{{ shop.email_logo_url }}` that only Shopify can render server-side. Detect
  // it so we can lock the preview editor and explain why placeholders show up
  // instead of real images — otherwise an inline edit would persist the
  // sanitized (Liquid-stripped) HTML and corrupt the template.
  const containsLiquid = useMemo(() => /\{\{|\{%/.test(value || ""), [value]);
  const previewReadOnly = readOnly || (mode === "rendered" && containsLiquid);

  // Cleanup typing timer on unmount
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
      }
    };
  }, []);

  // Initialize content when editor element changes (mode switch) or value changes externally
  useEffect(() => {
    if (!editorRef.current || mode !== "rendered") return;

    const isNewElement = editorRef.current !== lastEditorElementRef.current;

    // If it's a new element (after mode switch), always set content
    if (isNewElement) {
      // Sanitize HTML content to prevent XSS attacks
      editorRef.current.innerHTML = sanitizeHTML(value);
      lastEditorElementRef.current = editorRef.current;
      return;
    }

    // Skip update if user is currently typing
    if (isUserTypingRef.current) return;

    // Only update if the content is actually different
    const sanitizedValue = sanitizeHTML(value);
    if (editorRef.current.innerHTML !== sanitizedValue) {
      // Save current cursor position
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const startOffset = range?.startOffset;
      const startContainer = range?.startContainer;

      // Update content with sanitized HTML to prevent XSS attacks
      editorRef.current.innerHTML = sanitizedValue;

      // Restore cursor position if possible
      // Note: Cursor restoration may fail if DOM structure changes significantly
      // This is acceptable as security takes priority over UX convenience
      if (startContainer && startOffset !== undefined && editorRef.current.contains(startContainer)) {
        try {
          const newRange = document.createRange();
          newRange.setStart(startContainer, Math.min(startOffset, startContainer.textContent?.length || 0));
          newRange.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(newRange);
        } catch (e) {
          // Cursor restoration failed - DOM structure may have changed after sanitization
          // Position cursor at end of content as fallback
          try {
            const newRange = document.createRange();
            newRange.selectNodeContents(editorRef.current);
            newRange.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(newRange);
          } catch (e2) {
            // Complete failure - ignore, user can reposition cursor manually
          }
        }
      }
    }
  }, [value, mode]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    isUserTypingRef.current = true;
    onChange(e.currentTarget.innerHTML);
    // Reset flag after a short delay
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = setTimeout(() => {
      isUserTypingRef.current = false;
      typingTimerRef.current = null;
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

  const handleFormatText = (command: Parameters<typeof executeCommand>[0]) => {
    if (mode !== "rendered") return;
    executeCommand(command);
  };

  return (
    <div className={`ai-editable-html-field ${getBackgroundClass()}`}>
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="100" blockAlign="center">
          <Text as="span" variant="bodyMd" fontWeight="bold" tone={readOnly ? "subdued" : undefined}>
            {label}{requiredIndicator && <span style={{ color: 'var(--p-color-text-critical)' }}> *</span>}
          </Text>
          {helpKey && <HelpTooltip helpKey={helpKey} />}
        </InlineStack>
        <InlineStack gap="200">
          <Button size="slim" onClick={onToggleMode}>
            {mode === "html" ? t.products?.preview : t.products?.html}
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

      {mode === "rendered" && !previewReadOnly && (
        <div style={{ marginTop: "0.5rem" }}>
          <HtmlFormattingToolbar onCommand={handleFormatText} />
        </div>
      )}

      {mode === "rendered" && containsLiquid && (
        <div style={{ marginTop: "0.5rem" }}>
          <Banner tone="info">
            <p>
              {t.products?.liquidPreviewNotice ||
                "This template contains Liquid variables (e.g. {{ shop.email_logo_url }}) that Shopify only renders when the email is sent. Switch to HTML mode to edit."}
            </p>
          </Banner>
        </div>
      )}

      {mode === "html" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={readOnly}
          aria-label={label}
          style={{
            width: "100%",
            minHeight: "200px",
            padding: "12px",
            border: "1px solid #c9cccf",
            borderRadius: "8px",
            fontFamily: "monospace",
            fontSize: "14px",
            marginTop: "0.5rem",
            ...(readOnly ? { opacity: 0.6 } : {}),
          }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable={!previewReadOnly}
          onInput={handleInput}
          suppressContentEditableWarning
          // R4-UX3: this is the primary body-content editor. Without these a
          // screen reader announces a generic group, not an editable text
          // field, and the readOnly state was only conveyed by opacity.
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          aria-readonly={previewReadOnly}
          tabIndex={0}
          style={{
            width: "100%",
            minHeight: "200px",
            padding: "12px",
            border: "1px solid #c9cccf",
            borderTop: mode === "rendered" && !previewReadOnly ? "none" : "1px solid #c9cccf",
            borderRadius: mode === "rendered" && !previewReadOnly ? "0 0 8px 8px" : "8px",
            lineHeight: "1.6",
            ...(previewReadOnly ? { opacity: readOnly ? 0.6 : 1, userSelect: "text" as const } : {}),
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
          acceptLabel={t.products?.accept || "Accept"}
          declineLabel={t.products?.decline || "Decline"}
          acceptAndTranslateLabel={onAcceptAndTranslate ? (t.products?.acceptTranslate || "Accept & Translate") : undefined}
          titleLabel={t.products?.aiSuggestion || "AI suggestion:"}
        />
      )}

      <div className="ai-field-footer" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", justifyContent: "space-between" }}>
        <div className="ai-field-footer-left" style={{ flex: "0 0 auto" }}>
          <span style={{ fontSize: "0.8125rem", color: "#6d7175" }}>
            {value.replace(/<[^>]*>/g, "").length} {t.products?.characters}
          </span>
        </div>
        <div className="ai-field-footer-right" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", flex: "1 1 auto", justifyContent: "flex-end" }}>
          {onGenerateAI && (
            <div style={{ flex: "0 0 auto", width: "auto" }}>
              <Button size="slim" onClick={onGenerateAI} loading={isLoading} disabled={(disableGeneration && !value) || isLoading}>
                ✨ {disableGeneration || value
                  ? (t.products?.aiImprove || "Improve with AI")
                  : (t.products?.aiGenerateShort || "Generate with AI")}
              </Button>
            </div>
          )}
          {onFormatAI && (
            <div style={{ flex: "0 0 auto", width: "auto" }}>
              <Button
                size="slim"
                onClick={onFormatAI}
                loading={isLoading}
                disabled={!value || isLoading}
              >
                🎨 {t.products?.formatWithAI || "Format"}
              </Button>
            </div>
          )}
          {(onTranslate || onTranslateToAllLocales) && (
            <div style={{ flex: "0 0 auto", width: "auto" }}>
              <Button
                size="slim"
                onClick={isPrimaryLocale ? onTranslateToAllLocales : onTranslate}
                loading={isLoading}
                disabled={(isPrimaryLocale && !onTranslateToAllLocales) || (!isPrimaryLocale && !sourceTextAvailable) || isLoading}
              >
                🌍 {isPrimaryLocale ? (t.products?.translate || "Translate") : t.products?.translateFromPrimary}
              </Button>
            </div>
          )}
          {(onCopy || onCopyToAllLocales) && (
            <div style={{ flex: "0 0 auto", width: "auto" }}>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

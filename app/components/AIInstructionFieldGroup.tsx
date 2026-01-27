import { BlockStack, Text, TextField, Button, InlineStack } from "@shopify/polaris";
import { useRef } from "react";
import { useHtmlFormatting } from "../hooks/useHtmlFormatting";
import { useI18n } from "../contexts/I18nContext";
import { HtmlFormattingToolbar } from "./HtmlFormattingToolbar";

interface AIInstructionFieldGroupProps {
  fieldName: string;
  formatValue: string;
  instructionsValue: string;
  onFormatChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onResetFormat: () => void;
  onResetInstructions: () => void;
  formatPlaceholder: string;
  instructionsPlaceholder: string;
  formatLabel: string;
  instructionsLabel: string;
  isHtmlField?: boolean;
  htmlMode?: "html" | "rendered";
  onToggleHtmlMode?: () => void;
  resetFormatText?: string;
  resetInstructionsText?: string;
}

export function AIInstructionFieldGroup({
  fieldName,
  formatValue,
  instructionsValue,
  onFormatChange,
  onInstructionsChange,
  onResetFormat,
  onResetInstructions,
  formatPlaceholder,
  instructionsPlaceholder,
  formatLabel,
  instructionsLabel,
  isHtmlField = false,
  htmlMode = "rendered",
  onToggleHtmlMode,
  resetFormatText = "Reset",
  resetInstructionsText = "Reset",
}: AIInstructionFieldGroupProps) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  const { executeCommand } = useHtmlFormatting({ editorRef, onChange: onFormatChange });
  return (
    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px", overflow: "visible" }}>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd">{fieldName}</Text>

        {/* Format Example Field */}
        <div style={{ overflow: "visible" }}>
          {isHtmlField && onToggleHtmlMode && (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd" fontWeight="medium">{formatLabel}</Text>
              <InlineStack gap="200" blockAlign="center">
                <Button size="slim" onClick={onToggleHtmlMode}>
                  {htmlMode === "html" ? t.products.preview : t.products.html}
                </Button>
                <Button size="slim" onClick={onResetFormat} tone="critical" variant="plain">
                  {resetFormatText}
                </Button>
              </InlineStack>
            </InlineStack>
          )}

          {!isHtmlField && (
            <>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd" fontWeight="medium">{formatLabel}</Text>
                <Button size="slim" onClick={onResetFormat} tone="critical" variant="plain">
                  {resetFormatText}
                </Button>
              </InlineStack>
              <TextField
                label=""
                value={formatValue}
                onChange={onFormatChange}
                multiline={3}
                autoComplete="off"
                placeholder={formatPlaceholder}
                helpText={`${formatValue.length} ${t.products.characters}`}
              />
            </>
          )}

          {isHtmlField && (
            <>
              {htmlMode === "rendered" && (
                <div style={{ marginTop: "0.5rem" }}>
                  <HtmlFormattingToolbar onCommand={executeCommand} />
                </div>
              )}

              {htmlMode === "html" ? (
                <textarea
                  value={formatValue}
                  onChange={(e) => onFormatChange(e.target.value)}
                  placeholder={formatPlaceholder}
                  style={{
                    width: "100%",
                    minHeight: "150px",
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
                  onInput={(e) => onFormatChange(e.currentTarget.innerHTML)}
                  dangerouslySetInnerHTML={{ __html: formatValue || `<p>${t.settings.exampleText || 'Example text...'}</p>` }}
                  style={{
                    width: "100%",
                    minHeight: "200px",
                    maxHeight: "500px",
                    overflowY: "auto",
                    padding: "12px",
                    border: "1px solid #c9cccf",
                    borderTop: htmlMode === "rendered" ? "none" : "1px solid #c9cccf",
                    borderRadius: htmlMode === "rendered" ? "0 0 8px 8px" : "8px",
                    lineHeight: "1.6",
                    background: "white",
                    boxSizing: "border-box"
                  }}
                  className="description-editor"
                />
              )}
              <Text as="p" variant="bodySm" tone="subdued">
                {formatValue.replace(/<[^>]*>/g, "").length} {t.products.characters}
              </Text>
            </>
          )}
        </div>

        {/* Instructions Field */}
        <div>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodyMd" fontWeight="medium">{instructionsLabel}</Text>
            <Button size="slim" onClick={onResetInstructions} tone="critical" variant="plain">
              {resetInstructionsText}
            </Button>
          </InlineStack>
          <TextField
            label=""
            value={instructionsValue}
            onChange={onInstructionsChange}
            multiline={3}
            autoComplete="off"
            placeholder={instructionsPlaceholder}
            helpText={`${instructionsValue.length} ${t.products.characters}`}
          />
        </div>
      </BlockStack>
    </div>
  );
}

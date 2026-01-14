import { BlockStack, Text, TextField, Button, InlineStack, ButtonGroup, Tooltip } from "@shopify/polaris";
import { useRef } from "react";
import { useHtmlFormatting } from "../hooks/useHtmlFormatting";

interface AIInstructionFieldGroupProps {
  fieldName: string;
  formatValue: string;
  instructionsValue: string;
  onFormatChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onReset: () => void;
  formatPlaceholder: string;
  instructionsPlaceholder: string;
  formatLabel: string;
  instructionsLabel: string;
  isHtmlField?: boolean;
  htmlMode?: "html" | "rendered";
  onToggleHtmlMode?: () => void;
}

export function AIInstructionFieldGroup({
  fieldName,
  formatValue,
  instructionsValue,
  onFormatChange,
  onInstructionsChange,
  onReset,
  formatPlaceholder,
  instructionsPlaceholder,
  formatLabel,
  instructionsLabel,
  isHtmlField = false,
  htmlMode = "rendered",
  onToggleHtmlMode,
}: AIInstructionFieldGroupProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const { executeCommand } = useHtmlFormatting({ editorRef, onChange: onFormatChange });
  return (
    <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px", overflow: "visible" }}>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">{fieldName}</Text>
          <Button size="slim" onClick={onReset} tone="critical" variant="plain">
            Zurücksetzen
          </Button>
        </InlineStack>

        {/* Format Example Field */}
        <div style={{ overflow: "visible" }}>
          {isHtmlField && onToggleHtmlMode && (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd" fontWeight="medium">{formatLabel}</Text>
              <Button size="slim" onClick={onToggleHtmlMode}>
                {htmlMode === "html" ? "Vorschau" : "HTML"}
              </Button>
            </InlineStack>
          )}

          {!isHtmlField && (
            <TextField
              label={formatLabel}
              value={formatValue}
              onChange={onFormatChange}
              multiline={3}
              autoComplete="off"
              placeholder={formatPlaceholder}
              helpText={`${formatValue.length} Zeichen`}
            />
          )}

          {isHtmlField && (
            <>
              {htmlMode === "rendered" && (
                <div style={{
                  marginTop: "0.5rem",
                  display: "flex",
                  gap: "0.25rem",
                  flexWrap: "wrap",
                  padding: "0.75rem",
                  background: "white",
                  border: "1px solid #c9cccf",
                  borderRadius: "8px 8px 0 0",
                  minHeight: "52px"
                }}>
                  {/* Text Formatting */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Fett">
                      <Button size="slim" onClick={() => executeCommand("bold")}>
                        B
                      </Button>
                    </Tooltip>
                    <Tooltip content="Kursiv">
                      <Button size="slim" onClick={() => executeCommand("italic")}>
                        I
                      </Button>
                    </Tooltip>
                    <Tooltip content="Unterstrichen">
                      <Button size="slim" onClick={() => executeCommand("underline")}>
                        U
                      </Button>
                    </Tooltip>
                    <Tooltip content="Durchgestrichen">
                      <Button size="slim" onClick={() => executeCommand("strikethrough")}>
                        S
                      </Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Headings & Normal Text */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Überschrift 1">
                      <Button size="slim" onClick={() => executeCommand("h1")}>H1</Button>
                    </Tooltip>
                    <Tooltip content="Überschrift 2">
                      <Button size="slim" onClick={() => executeCommand("h2")}>H2</Button>
                    </Tooltip>
                    <Tooltip content="Überschrift 3">
                      <Button size="slim" onClick={() => executeCommand("h3")}>H3</Button>
                    </Tooltip>
                    <Tooltip content="Normaler Text / Absatz">
                      <Button size="slim" onClick={() => executeCommand("p")}>Text</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Lists */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Aufzählungsliste">
                      <Button size="slim" onClick={() => executeCommand("ul")}>Liste</Button>
                    </Tooltip>
                    <Tooltip content="Nummerierte Liste">
                      <Button size="slim" onClick={() => executeCommand("ol")}>Num.</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Special Formats */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Zitat-Block">
                      <Button size="slim" onClick={() => executeCommand("blockquote")}>""</Button>
                    </Tooltip>
                    <Tooltip content="Code-Block">
                      <Button size="slim" onClick={() => executeCommand("code")}>{"</>"}</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Links */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Link einfügen">
                      <Button size="slim" onClick={() => executeCommand("link")}>🔗</Button>
                    </Tooltip>
                    <Tooltip content="Link entfernen">
                      <Button size="slim" onClick={() => executeCommand("unlink")}>🔗✖</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Line Break */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Zeilenumbruch">
                      <Button size="slim" onClick={() => executeCommand("br")}>Umbruch</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Undo/Redo */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Rückgängig">
                      <Button size="slim" onClick={() => executeCommand("undo")}>↶</Button>
                    </Tooltip>
                    <Tooltip content="Wiederholen">
                      <Button size="slim" onClick={() => executeCommand("redo")}>↷</Button>
                    </Tooltip>
                  </ButtonGroup>

                  {/* Clear Formatting */}
                  <ButtonGroup variant="segmented">
                    <Tooltip content="Formatierung entfernen">
                      <Button size="slim" onClick={() => executeCommand("removeFormat")} tone="critical">✖</Button>
                    </Tooltip>
                  </ButtonGroup>
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
                  dangerouslySetInnerHTML={{ __html: formatValue || '<p>Beispieltext...</p>' }}
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
                {formatValue.replace(/<[^>]*>/g, "").length} Zeichen
              </Text>
            </>
          )}
        </div>

        {/* Instructions Field */}
        <TextField
          label={instructionsLabel}
          value={instructionsValue}
          onChange={onInstructionsChange}
          multiline={3}
          autoComplete="off"
          placeholder={instructionsPlaceholder}
          helpText={`${instructionsValue.length} Zeichen`}
        />
      </BlockStack>
    </div>
  );
}

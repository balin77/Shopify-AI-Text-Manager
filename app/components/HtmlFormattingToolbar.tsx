import { Button, ButtonGroup, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

type FormattingCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "h1"
  | "h2"
  | "h3"
  | "p"
  | "ul"
  | "ol"
  | "blockquote"
  | "code"
  | "link"
  | "unlink"
  | "br"
  | "undo"
  | "redo"
  | "removeFormat";

interface HtmlFormattingToolbarProps {
  onCommand: (command: FormattingCommand) => void;
}

export function HtmlFormattingToolbar({ onCommand }: HtmlFormattingToolbarProps) {
  const { t } = useI18n();
  const f = t.products.formatting;

  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        flexWrap: "wrap",
        padding: "0.5rem 0.75rem",
        background: "#f6f6f7",
        border: "1px solid #c9cccf",
        borderRadius: "8px 8px 0 0",
        minHeight: "52px",
      }}
    >
      {/* Text Formatting */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.bold}>
          <Button size="slim" onClick={() => onCommand("bold")}>
            B
          </Button>
        </Tooltip>
        <Tooltip content={f.italic}>
          <Button size="slim" onClick={() => onCommand("italic")}>
            I
          </Button>
        </Tooltip>
        <Tooltip content={f.underline}>
          <Button size="slim" onClick={() => onCommand("underline")}>
            U
          </Button>
        </Tooltip>
        <Tooltip content={f.strikethrough}>
          <Button size="slim" onClick={() => onCommand("strikethrough")}>
            S
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Headings & Normal Text */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.heading1}>
          <Button size="slim" onClick={() => onCommand("h1")}>
            {f.h1}
          </Button>
        </Tooltip>
        <Tooltip content={f.heading2}>
          <Button size="slim" onClick={() => onCommand("h2")}>
            {f.h2}
          </Button>
        </Tooltip>
        <Tooltip content={f.heading3}>
          <Button size="slim" onClick={() => onCommand("h3")}>
            {f.h3}
          </Button>
        </Tooltip>
        <Tooltip content={f.paragraph}>
          <Button size="slim" onClick={() => onCommand("p")}>
            Text
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Lists */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.bulletList}>
          <Button size="slim" onClick={() => onCommand("ul")}>
            {f.list}
          </Button>
        </Tooltip>
        <Tooltip content={f.numberedList}>
          <Button size="slim" onClick={() => onCommand("ol")}>
            Num.
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Special Formats */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.quote}>
          <Button size="slim" onClick={() => onCommand("blockquote")}>
            ""
          </Button>
        </Tooltip>
        <Tooltip content={f.codeBlock}>
          <Button size="slim" onClick={() => onCommand("code")}>
            {"</>"}
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Links */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.insertLink}>
          <Button size="slim" onClick={() => onCommand("link")}>
            🔗
          </Button>
        </Tooltip>
        <Tooltip content={f.removeLink}>
          <Button size="slim" onClick={() => onCommand("unlink")}>
            🔗✖
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Line Break */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.lineBreak}>
          <Button size="slim" onClick={() => onCommand("br")}>
            {f.lineBreak}
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Undo/Redo */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.undo}>
          <Button size="slim" onClick={() => onCommand("undo")}>
            ↶
          </Button>
        </Tooltip>
        <Tooltip content={f.redo}>
          <Button size="slim" onClick={() => onCommand("redo")}>
            ↷
          </Button>
        </Tooltip>
      </ButtonGroup>

      {/* Clear Formatting */}
      <ButtonGroup variant="segmented">
        <Tooltip content={f.clearFormat}>
          <Button size="slim" onClick={() => onCommand("removeFormat")} tone="critical">
            ✖
          </Button>
        </Tooltip>
      </ButtonGroup>
    </div>
  );
}

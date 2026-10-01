/**
 * The corner mark on a gallery tile that has a replacement in the language (and
 * market) the editor is showing. A SYMBOL, deliberately not an outline: the
 * tile's outline already says "selected" (blue) and "main image" (gold), and a
 * third border colour would be ambiguous. Tiles keep showing the ORIGINAL —
 * reordering and dragging act on originals.
 *
 * Absolutely positioned: the caller's tile must be `position: relative`.
 */
import { Icon } from "@shopify/polaris";
import { ReplaceIcon } from "@shopify/polaris-icons";

export function ReplacedMediaBadge({ label, size = 20, top = 4, left = 4 }: { label: string; size?: number; top?: number; left?: number }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        position: "absolute",
        top,
        left,
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#6b4eaa",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }}
    >
      {/* Polaris draws icons at 20px; scaled to sit inside the round badge. */}
      <span style={{ display: "flex", transform: `scale(${(size * 0.7) / 20})`, flex: "0 0 auto" }}>
        <Icon source={ReplaceIcon} tone="inherit" />
      </span>
    </span>
  );
}

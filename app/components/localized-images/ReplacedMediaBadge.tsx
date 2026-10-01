/**
 * The corner mark on a gallery tile that shows a replacement in the language
 * (and market) the editor is showing. A SYMBOL, deliberately not an outline: the
 * tile's outline already says "selected" (blue) and "main image" (gold), and a
 * third border colour would be ambiguous.
 *
 * The tile shows the REPLACEMENT in place of the original, and this symbol is
 * the way back to the original and forth again (`onToggle`). The click must
 * neither select the tile nor start a drag: the dnd-kit listeners and the
 * tile's own click sit on an ancestor, so every pointer/mouse/touch/key event
 * stops here. The symbol is purple while the replacement is shown and grey while the
 * original is; a draft (not saved yet) wears a dashed white ring.
 *
 * Absolutely positioned: the caller's tile must be `position: relative`. It is
 * a `span role="button"`, never a `<button>`, because the plain gallery's tile
 * is itself a button and nested buttons are invalid markup (and a hydration
 * mismatch on a server-rendered page).
 */
import type { KeyboardEvent, SyntheticEvent } from "react";
import { Icon } from "@shopify/polaris";
import { ReplaceIcon } from "@shopify/polaris-icons";

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * The symbol's colour says what the tile shows right now; the ONE place the two
 * colours live. A draft keeps its colour and is told apart by a dashed ring.
 */
export const REPLACED_BADGE_COLORS = {
  /** The tile shows the replacement. */
  replacement: "#6b4eaa",
  /** The tile was flipped to the original. */
  original: "#5c5f62",
} as const;

export function ReplacedMediaBadge({
  label,
  size = 20,
  top = 4,
  left = 4,
  onToggle,
  draft = false,
  showingOriginal = false,
}: {
  label: string;
  size?: number;
  top?: number;
  left?: number;
  /** Flips the tile between the replacement and the original. */
  onToggle?: () => void;
  /** The replacement is not saved yet. */
  draft?: boolean;
  /** The tile currently shows the original. */
  showingOriginal?: boolean;
}) {
  const background = showingOriginal ? REPLACED_BADGE_COLORS.original : REPLACED_BADGE_COLORS.replacement;
  const interactive = !!onToggle;
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (interactive && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onToggle?.();
    }
  };
  return (
    <span
      role={interactive ? "button" : "img"}
      aria-label={label}
      aria-pressed={interactive ? showingOriginal : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={label}
      onClick={interactive ? (e) => { e.stopPropagation(); onToggle?.(); } : undefined}
      onPointerDown={interactive ? stop : undefined}
      onMouseDown={interactive ? stop : undefined}
      onTouchStart={interactive ? stop : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      style={{
        position: "absolute",
        top,
        left,
        width: size,
        height: size,
        borderRadius: "50%",
        background,
        color: "#fff",
        border: draft ? "1.5px dashed #fff" : "none",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        cursor: interactive ? "pointer" : "default",
        pointerEvents: interactive ? "auto" : "none",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
        zIndex: 2,
      }}
    >
      {/* Polaris draws icons at 20px; scaled to sit inside the round badge. */}
      <span style={{ display: "flex", transform: `scale(${(size * 0.7) / 20})`, flex: "0 0 auto" }}>
        <Icon source={ReplaceIcon} tone="inherit" />
      </span>
    </span>
  );
}

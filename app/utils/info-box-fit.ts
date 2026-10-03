/**
 * How the navigation's message strip (MainNavigation's InfoBox) fits a message
 * without changing the navigation's height.
 *
 * The strip used to be one line tall for a short message and two lines tall
 * for a long one, and the whole page below the fixed navigation moved by a
 * line every time a message came and went. Its height is now FIXED — the
 * height the one-line strip always had, `INFO_BOX_STRIP_HEIGHT` — with the
 * text vertically centred in it, and a message that does not fit on one line
 * at the normal size is drawn COMPACT instead: a smaller font and line height,
 * so two lines fit into the same box. Anything longer than
 * two compact lines is clamped with an ellipsis — the full text is in the
 * strip's tooltip and in the bell's history.
 *
 * Import-free and pure, so the decision is unit-testable; the component only
 * measures the two widths.
 */

export type InfoBoxFitMode = "single" | "compact";

/** Normal size: one line. */
export const INFO_BOX_NORMAL = { fontSizePx: 14, lineHeightPx: 20 } as const;
/** Compact size: two lines in the height of one normal line plus the reclaimed padding. */
export const INFO_BOX_COMPACT = { fontSizePx: 12, lineHeightPx: 15 } as const;
/** The strip's vertical padding (px, per side) — small, the height is fixed anyway. */
export const INFO_BOX_PADDING_Y = 3;
/** 1px border on each side. */
export const INFO_BOX_BORDER_PX = 1;

/**
 * The strip's fixed outer height (its `min-height`): what the old one-line
 * strip measured — one normal line, 0.5rem padding above and below, the
 * border. Two compact lines plus `INFO_BOX_PADDING_Y` must fit in it — pinned
 * by a test.
 */
export const INFO_BOX_STRIP_HEIGHT = INFO_BOX_NORMAL.lineHeightPx + 2 * 8 + 2 * INFO_BOX_BORDER_PX;

/**
 * `naturalWidth` is the message's width on ONE line at the normal size,
 * `availableWidth` the width its text box has. Unknown (0 / NaN) widths answer
 * "single": the strip renders before it can be measured, and the normal size
 * is the right first guess for the common short message.
 */
export function infoBoxFitMode(naturalWidth: number, availableWidth: number): InfoBoxFitMode {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(availableWidth)) return "single";
  if (availableWidth <= 0 || naturalWidth <= 0) return "single";
  // Half a pixel of tolerance: sub-pixel text widths round differently in
  // the measuring copy and the real box.
  return naturalWidth > availableWidth + 0.5 ? "compact" : "single";
}

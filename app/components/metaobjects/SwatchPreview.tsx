/**
 * The colour / image chip next to a metaobject entry's name.
 *
 * It resolves through `resolveSwatch`, the SAME function the variants card
 * uses, so the two surfaces can never paint a different colour for one value.
 * `null` is a real answer there and it is a real answer here: nothing is drawn
 * when no colour is honestly resolvable, because a confidently wrong swatch is
 * worse than none -- it is the thing the merchant looks at INSTEAD of the name.
 *
 * A rounded SQUARE, not a dot, and that is not decoration: on a colour entry
 * this chip IS the button that opens the colour picker, and what the picker
 * shows is a rounded rectangle (`<input type="color">` in `HexColorInput`). A
 * bullet that opens a swatch is two shapes for one value; the merchant clicks
 * a dot and a rectangle appears. It is also the entry's colour AREA rather
 * than a bullet in front of its name, which is what the card header is for.
 * The radius and the border are the input's, so the two read as one control.
 */

import { resolveSwatch, type OptionValueSwatch } from "~/services/product-option-swatch.shared";

/**
 * The corner, from the ONE place app-wide formatting lives (`:root` in
 * responsive.css), exactly like `--app-page-padding` and the field chrome.
 *
 * A TS constant here was the first cut and it was already drifting: the card's
 * activator ring restated `6px`, `HexColorInput` restated it for the native
 * picker, and the app's own `--app-field-border-radius` is 8px. Four literals
 * for one visual relationship — the swatch, the ring around it, the picker it
 * opens and that picker's chips must all share a corner or the panel reads as
 * three controls for one value.
 */
const SWATCH_RADIUS = "var(--app-swatch-radius)";

interface Props {
  /** The entry's display name — the fallback source for a colour word / hex. */
  name: string;
  /** What the entry's own fields say: a colour value and/or an image URL. */
  swatch?: OptionValueSwatch | null;
  size?: number;
  /**
   * Draw an EMPTY placeholder where nothing resolves, instead of nothing.
   *
   * Off by default, because "no colour is known" is a real answer and a card
   * that shows an invented square states something the merchant did not. On
   * when the swatch is the CONTROL: an entry whose colour is unset is exactly
   * the one somebody wants to click, and a control that is not there cannot be
   * found.
   */
  showEmpty?: boolean;
}

export function SwatchPreview({ name, swatch, size = 28, showEmpty = false }: Props) {
  const resolved = resolveSwatch(name, swatch);
  if (!resolved) {
    if (!showEmpty) return null;
    return (
      <span
        data-swatch="true"
        aria-hidden="true"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: SWATCH_RADIUS,
          // Dashed, so "not set" cannot be mistaken for "set to white".
          border: "1px dashed var(--p-color-border)",
          background: "var(--p-color-bg-surface-secondary)",
          flexShrink: 0,
        }}
      />
    );
  }

  const common = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: SWATCH_RADIUS,
    // A light border so #FFFFFF is still a visible square on a white card.
    border: "1px solid var(--p-color-border)",
    flexShrink: 0,
  } as const;

  if (resolved.imageUrl) {
    return (
      <span
        data-swatch="true"
        aria-hidden="true"
        style={{
          ...common,
          backgroundImage: `url(${resolved.imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
    );
  }
  return <span data-swatch="true" aria-hidden="true" style={{ ...common, backgroundColor: resolved.color }} />;
}

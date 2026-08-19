/**
 * The colour dot / image chip next to a metaobject entry's name.
 *
 * It resolves through `resolveSwatch`, the SAME function the variants card
 * uses, so the two surfaces can never paint a different colour for one value.
 * `null` is a real answer there and it is a real answer here: nothing is drawn
 * when no colour is honestly resolvable, because a confidently wrong swatch is
 * worse than none -- it is the thing the merchant looks at INSTEAD of the name.
 */

import { resolveSwatch, type OptionValueSwatch } from "~/services/product-option-swatch.shared";

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
   * that shows an invented dot states something the merchant did not. On when
   * the dot is the CONTROL: an entry whose colour is unset is exactly the one
   * somebody wants to click, and a control that is not there cannot be found.
   */
  showEmpty?: boolean;
}

export function SwatchPreview({ name, swatch, size = 20, showEmpty = false }: Props) {
  const resolved = resolveSwatch(name, swatch);
  if (!resolved) {
    if (!showEmpty) return null;
    return (
      <span
        aria-hidden="true"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: "50%",
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
    borderRadius: "50%",
    // A light border so #FFFFFF is still a visible circle on a white card.
    border: "1px solid var(--p-color-border)",
    flexShrink: 0,
  } as const;

  if (resolved.imageUrl) {
    return (
      <span
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
  return <span aria-hidden="true" style={{ ...common, backgroundColor: resolved.color }} />;
}

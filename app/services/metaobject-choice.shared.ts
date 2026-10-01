/**
 * The colour a metaobject entry stands for, read out of its cached fields.
 *
 * Shopify's standard colour definition carries a field of TYPE `color`; a
 * merchant's own definition may call its field anything. So the type is asked
 * first and the key only as a fallback, and both are checked against the same
 * hex rule the swatch resolver uses — a field that holds something else yields
 * nothing rather than a chip of an unknown colour.
 *
 * Its own module because the route reads it from Prisma JSON and the tests read
 * it from a literal; neither should have to know the other's imports.
 */

/** `#rgb`, `#rrggbb`, `#rrggbbaa` — the same shape the swatch resolver takes. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface MetaobjectField {
  key?: unknown;
  value?: unknown;
  type?: unknown;
}

/**
 * `undefined` when the entry carries no colour — a real answer, and the one
 * the picker shows as a name without a chip.
 */
export function metaobjectSwatchColor(fields: unknown): string | undefined {
  if (!Array.isArray(fields)) return undefined;

  const usable = (field: MetaobjectField): string | undefined => {
    const value = typeof field.value === "string" ? field.value.trim() : "";
    return HEX.test(value) ? value : undefined;
  };

  // A field DECLARED as a colour is the merchant's own statement of intent.
  for (const field of fields as MetaobjectField[]) {
    if (typeof field?.type === "string" && field.type.toLowerCase() === "color") {
      const value = usable(field);
      if (value) return value;
    }
  }
  // Otherwise a field NAMED like one — but still only if it holds a hex, so a
  // "color_description" reading "warm brown" is passed over rather than shown
  // as a swatch of nothing.
  for (const field of fields as MetaobjectField[]) {
    if (typeof field?.key === "string" && /colou?r|farbe/i.test(field.key)) {
      const value = usable(field);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Hex values for 17 of Shopify's 19 base colour names — as SUGGESTIONS.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * Shopify's taxonomy exposes NO colour for a taxonomy value. Measured on a
 * live shop (2026-08-19, API 2026-07, PLAN_METAOBJECT_TAXONOMY_CREATE §1.2):
 * `__type(TaxonomyValue)` answers exactly `id, name`. So picking "Gold" in the
 * taxonomy field tells the storefront nothing about what gold looks like —
 * that is what the separate `color` field is for, and setting it meant reaching
 * for a colour picker and eyeballing a shade.
 *
 * ── What these values ARE, and what they are not ────────────────────────────
 * They are NOT Shopify's. Shopify publishes none, and this module must never
 * be read as if it had recovered them. FIFTEEN of the names are CSS Color
 * Level 4 KEYWORDS, so their hex is a published standard rather than anybody's
 * taste. TWO more — Bronze and Rose gold — have no keyword and carry a stated
 * convention instead, marked `convention: true` so the UI can say so. The
 * remaining TWO are absent entirely, for the reason below.
 *
 * The merchant always overrides: this is a one-click starting point next to a
 * free hex field, never a value written on their behalf. Nothing here is ever
 * saved without a click, and `color` stays whatever they type.
 *
 * ── Why "Clear" and "Multicolor" have no entry ──────────────────────────────
 * Neither is a colour. `clear` is the absence of one and `multicolor` is
 * several; inventing a hex for either would put a specific shade behind a name
 * that denies having one. They are simply absent, and the palette shows what
 * it has.
 */

export interface BaseColorSuggestion {
  /** The taxonomy value's name, as Shopify spells it. */
  name: string;
  hex: string;
  /**
   * True where no CSS keyword exists and the value is this app's convention.
   * The UI marks these, because "the standard says #FFD700" and "we picked a
   * bronze" are different claims.
   */
  convention?: boolean;
}

/**
 * The nineteen names are the ones MEASURED on the `color` attribute (§1.3):
 * Beige, Black, Blue, Bronze, Brown, Clear, Gold, Gray, Green, Multicolor,
 * Navy, Orange, Pink, Purple, Red, Rose gold, Silver, White, Yellow.
 */
export const BASE_COLOR_SUGGESTIONS: BaseColorSuggestion[] = [
  // CSS Color Level 4 keywords — a published standard, not a preference.
  { name: "Beige", hex: "#f5f5dc" },
  { name: "Black", hex: "#000000" },
  { name: "Blue", hex: "#0000ff" },
  { name: "Brown", hex: "#a52a2a" },
  { name: "Gold", hex: "#ffd700" },
  { name: "Gray", hex: "#808080" },
  { name: "Green", hex: "#008000" },
  { name: "Navy", hex: "#000080" },
  { name: "Orange", hex: "#ffa500" },
  { name: "Pink", hex: "#ffc0cb" },
  { name: "Purple", hex: "#800080" },
  { name: "Red", hex: "#ff0000" },
  { name: "Silver", hex: "#c0c0c0" },
  { name: "White", hex: "#ffffff" },
  { name: "Yellow", hex: "#ffff00" },
  // No CSS keyword. Widely used values, and named as this app's convention.
  { name: "Bronze", hex: "#cd7f32", convention: true },
  { name: "Rose gold", hex: "#b76e79", convention: true },
];

/** Lower-cased name -> suggestion, for matching a taxonomy value by name. */
const BY_NAME = new Map(BASE_COLOR_SUGGESTIONS.map((c) => [c.name.toLowerCase(), c]));

/**
 * The suggestion for a taxonomy value's name, if there is one.
 *
 * `null` for "Clear", "Multicolor" and anything else with no entry — never a
 * fallback shade, because a wrong colour beside a name reads as that name's
 * colour.
 */
export function baseColorFor(name: string): BaseColorSuggestion | null {
  return BY_NAME.get((name ?? "").trim().toLowerCase()) ?? null;
}

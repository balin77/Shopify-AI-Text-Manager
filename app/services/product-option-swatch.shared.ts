/**
 * What colour to paint next to an option value.
 *
 * Client-safe and pure, so the variants card and any future surface resolve a
 * swatch the same way.
 *
 * -- Three sources, in strictly decreasing authority ---------------------------
 * 1. Shopify's OWN swatch (`ProductOptionValue.swatch`). The merchant set it,
 *    it is per value, and it is the only source that can be WRONG only if the
 *    merchant made it wrong. It wins whenever it exists.
 * 2. A colour written in the value's name as a hex or an `rgb()` — unambiguous
 *    text that means exactly one colour in every language. The `#` is optional
 *    ONLY on an option that is about colour: `DDD` is a bra cup size, `EEE` a
 *    shoe width and `ABC` a style code, and every one of them is also a valid
 *    three-digit hex.
 * 3. A small table of basic colour WORDS in the three languages this app ships
 *    in. This is the only guessing step and it is deliberately narrow: "Rot",
 *    "red" and "rojo" are the same colour in every shop that has ever existed,
 *    while "Sand", "Nude" or "Petrol" are not, so they are absent and get no
 *    swatch rather than a plausible one.
 *
 * -- Why not more ------------------------------------------------------------
 * The obvious next step is a large name->hex dictionary, and it is the wrong
 * one: a swatch that is confidently the wrong colour is worse than no swatch,
 * because it is the thing the merchant is looking at INSTEAD of the name. The
 * fix for a missing swatch is to set it in Shopify, where it belongs and where
 * the storefront reads it from too.
 */

/** A value's swatch as Shopify reports it. */
export interface OptionValueSwatch {
  /** A hex colour, e.g. "#B71C1C". */
  color?: string | null;
  /** A swatch IMAGE (a fabric, a pattern) — a URL when there is one. */
  imageUrl?: string | null;
}

export interface ResolvedSwatch {
  /** A CSS colour, ready to paint. */
  color?: string;
  /** An image to show instead — a pattern cannot be expressed as one colour. */
  imageUrl?: string;
  /**
   * Where it came from. The UI does not currently distinguish them, but the
   * caller can: a derived swatch is an inference and a shop one is a fact.
   */
  source: "shopify" | "hex" | "name";
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** An `http(s)` URL. A swatch image is painted into a CSS `url()`, and the
 *  escaping that makes that safe lives in the CALLER — so the value is pinned
 *  to a shape that cannot mean anything else, here, where it is resolved. */
const HTTP_URL = /^https?:\/\/[^\s"'()\\]+$/i;
/** `rgb(1,2,3)` / `rgba(1,2,3,.5)`, digits and separators only — no expressions. */
const RGB = /^rgba?\(\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*(?:[,/]\s*(?:0|1|0?\.\d+)\s*)?\)$/i;

/**
 * Basic colour words, lowercased, in German, English and Spanish.
 *
 * Every entry has to be a colour in ALL of them or unambiguous in the one it
 * belongs to. Entries that a merchant plausibly uses as a product name rather
 * than a colour are left out on purpose.
 */
const COLOUR_WORDS: Record<string, string> = {
  // German
  rot: "#D32F2F", blau: "#1976D2", gruen: "#388E3C", grün: "#388E3C",
  gelb: "#FBC02D", schwarz: "#000000", weiss: "#FFFFFF", weiß: "#FFFFFF",
  grau: "#9E9E9E", braun: "#6D4C41", orange: "#F57C00", violett: "#7B1FA2",
  lila: "#7B1FA2", rosa: "#EC407A", pink: "#EC407A", tuerkis: "#00ACC1",
  türkis: "#00ACC1", beige: "#D7CCC8", silber: "#C0C0C0", gold: "#D4AF37",
  // English
  red: "#D32F2F", blue: "#1976D2", green: "#388E3C", yellow: "#FBC02D",
  black: "#000000", white: "#FFFFFF", grey: "#9E9E9E", gray: "#9E9E9E",
  brown: "#6D4C41", purple: "#7B1FA2", violet: "#7B1FA2", turquoise: "#00ACC1",
  silver: "#C0C0C0",
  // Spanish
  rojo: "#D32F2F", azul: "#1976D2", verde: "#388E3C", amarillo: "#FBC02D",
  negro: "#000000", blanco: "#FFFFFF", gris: "#9E9E9E", marron: "#6D4C41",
  marrón: "#6D4C41", morado: "#7B1FA2", naranja: "#F57C00", turquesa: "#00ACC1",
  plata: "#C0C0C0", dorado: "#D4AF37", rosado: "#EC407A",
};

/**
 * The swatch for one value, or null when none can be resolved HONESTLY.
 *
 * `null` is a real answer: it means "no colour is known", and the card then
 * shows the name alone, which is what it always did.
 */
export function resolveSwatch(
  valueName: string,
  swatch?: OptionValueSwatch | null,
  options?: {
    /** True when the OPTION is about colour. Only then is a bare hex (no `#`)
     *  read as one — see rule 2 in the header. */
    isColourOption?: boolean;
  },
): ResolvedSwatch | null {
  // 1. Shopify's own. A swatch image keeps its colour alongside it: an image
  //    that 404s or is blocked would otherwise leave an empty chip where a
  //    known colour was available.
  const shopColor = swatch?.color?.trim();
  const validShopColor = shopColor && (HEX.test(shopColor) || RGB.test(shopColor)) ? shopColor : undefined;
  if (swatch?.imageUrl && HTTP_URL.test(swatch.imageUrl.trim())) {
    return { imageUrl: swatch.imageUrl.trim(), color: validShopColor, source: "shopify" };
  }
  if (validShopColor) return { color: validShopColor, source: "shopify" };

  const name = (valueName ?? "").trim();
  if (!name) return null;

  // 2. A colour written out as text.
  if (HEX.test(name)) return { color: name, source: "hex" };
  if (options?.isColourOption && HEX.test(`#${name}`)) return { color: `#${name}`, source: "hex" };
  if (RGB.test(name)) return { color: name, source: "hex" };

  // 3. A basic colour word. Only the whole name counts — "Rot meliert" is a
  //    fabric, not the colour red, and painting it red would state something
  //    the merchant did not.
  //
  //    `Object.hasOwn`, because a plain object literal answers "constructor"
  //    and "__proto__" with something truthy that is not a colour, and this
  //    function promises `null` for anything it is not sure of.
  const key = name.toLowerCase();
  const word = Object.hasOwn(COLOUR_WORDS, key) ? COLOUR_WORDS[key] : undefined;
  return word ? { color: word, source: "name" } : null;
}

/**
 * True when an OPTION is about colour.
 *
 * The one thing it gates is rule 2's bare hex: on a colour option "FF0000" is
 * a colour, and on a size option "DDD" is a cup size. Everything else resolves
 * per value regardless, so a false negative here costs at most a `#`.
 */
export function looksLikeColourOption(optionName: string, linkedMetafieldKey?: string): boolean {
  if (linkedMetafieldKey && /colou?r|farbe/i.test(linkedMetafieldKey)) return true;
  return /^(colou?r|farbe|farben|color(es)?)$/i.test((optionName ?? "").trim());
}

/**
 * A Shopify market's name, in the app's language where that is honest.
 *
 * Shopify stores a market under the name it was created with — on a shop set
 * up in English that is "Switzerland" / "European Union", and the Settings →
 * Shop-Sprachen checkboxes printed exactly that to a German merchant. A market
 * NAME is merchant data, though, and a renamed market ("DACH-Raum") must stay
 * as written. So a name is only localized when it IS a region's standard name
 * in one of the common admin languages (the name Shopify generates for a
 * one-country market, or the EU); anything else comes back verbatim.
 *
 * `Intl.DisplayNames` is the same source `getLocalizedLanguageName` renders
 * with on both sides of hydration, keyed on the app locale — the residual is
 * CLDR drift between ICU builds (CLAUDE.md, "Hydration").
 */

/** Admin languages whose region names are recognised as Shopify's own. */
const SOURCE_LOCALES = ["en", "de", "es", "fr", "it", "nl", "pt", "pl", "sv", "da", "nb", "fi", "cs", "ja", "zh", "ko"];

let regionIndex: Map<string, string> | null = null;

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
  } catch {
    return null;
  }
}

/** Standard region name (lower-cased) → region code, built once. */
function regionCodeIndex(): Map<string, string> {
  if (regionIndex) return regionIndex;
  const index = new Map<string, string>();
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b));
  }
  for (const locale of SOURCE_LOCALES) {
    const names = displayNames(locale);
    if (!names) continue;
    for (const code of codes) {
      // ZZ is CLDR's "Unknown Region" — never a market.
      if (code === "ZZ") continue;
      const name = names.of(code);
      if (!name || name === code) continue;
      const key = name.trim().toLowerCase();
      if (!index.has(key)) index.set(key, code);
    }
  }
  regionIndex = index;
  return index;
}

export function localizedMarketName(name: string, appLocale: string): string {
  const code = regionCodeIndex().get(name.trim().toLowerCase());
  if (!code) return name;
  return displayNames(appLocale)?.of(code) || name;
}

/** The region code a standard market name stands for (`"Spanien"` → `"ES"`), if any. */
export function regionCodeForName(name: string): string | undefined {
  return regionCodeIndex().get(name.trim().toLowerCase());
}

/**
 * Codes CLDR names that are not countries a market can contain (Shopify's
 * `CountryCode` is ISO 3166-1 plus Kosovo): territories without their own
 * country code, the EU/eurozone, the UN, pseudo-locales and the unknown region.
 */
const NON_COUNTRY_CODES = new Set(["AC", "CP", "CQ", "DG", "EA", "EU", "EZ", "IC", "QO", "TA", "UN", "XA", "XB", "ZR", "ZZ"]);

/** Every country, named in the app's language — the market editor's picker. */
export function countryOptions(appLocale: string): Array<{ code: string; name: string }> {
  const names = displayNames(appLocale) ?? displayNames("en");
  if (!names) return [];
  const out: Array<{ code: string; name: string }> = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NON_COUNTRY_CODES.has(code)) continue;
      const name = names.of(code);
      if (name && name !== code) out.push({ code, name });
    }
  }
  return out;
}

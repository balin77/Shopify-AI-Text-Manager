/**
 * Shopify's published taxonomy file, parsed — the pure half.
 *
 * The format is two comment lines and then one category per line:
 *
 *   # Shopify Product Taxonomy - Categories: 2026-05
 *   # Format: {GID} : {Ancestor name} > ... > {Category name}
 *
 *   gid://shopify/TaxonomyCategory/ap      : Tiere & Tierbedarf
 *   gid://shopify/TaxonomyCategory/hg-3-72 : Heim & Garten > Dekoration > Vasen
 *
 * Everything here is string work with no network and no database, so the rules
 * that matter can be tested without either.
 */

/** One parsed line. `name` is split here so no read has to do it later. */
export interface ParsedTaxonomyName {
  gid: string;
  fullName: string;
  /** The last segment of the path — what a derived product type is built from. */
  name: string;
}

export interface ParsedTaxonomyFile {
  /** "2026-05", or "" when the header did not carry one. */
  version: string;
  entries: ParsedTaxonomyName[];
}

/**
 * A file this short is not the taxonomy.
 *
 * The real one carries ~14 600 entries. A truncated download, an error page
 * served with a 200, or a tag whose dist folder was reorganised would all
 * parse into a handful of lines — and importing THAT would replace a good
 * table with a broken one. The same rule the DB backup follows: a dump is
 * verified before it counts.
 */
export const MIN_PLAUSIBLE_ENTRIES = 1000;

/** Only the GID shape the Admin API also returns. Anything else is a line we
 *  do not understand, and a category we would key wrongly. */
const GID_PREFIX = "gid://shopify/TaxonomyCategory/";

/** The path separator Shopify writes, with the spaces it writes around it. */
const PATH_SEPARATOR = ">";

/**
 * Parse the file. Unreadable lines are SKIPPED, never guessed at — a line this
 * does not understand is one category missing its translation, which falls
 * back to the API's English name; a line misread is a category labelled wrong.
 */
export function parseTaxonomyCategoriesFile(text: string): ParsedTaxonomyFile {
  let version = "";
  const entries: ParsedTaxonomyName[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      // "# Shopify Product Taxonomy - Categories: 2026-05"
      const marker = line.indexOf("Categories:");
      if (marker >= 0 && !version) version = line.slice(marker + "Categories:".length).trim();
      continue;
    }

    if (!line.startsWith(GID_PREFIX)) continue;

    // Split at the FIRST " : " only: a category name may legitimately contain a
    // colon, and splitting on every one would truncate it.
    const separator = line.indexOf(" : ");
    if (separator < 0) continue;

    const gid = line.slice(0, separator).trim();
    const fullName = line.slice(separator + 3).trim();
    if (!gid || !fullName) continue;

    const lastSegment = fullName.lastIndexOf(PATH_SEPARATOR);
    const name = lastSegment >= 0 ? fullName.slice(lastSegment + 1).trim() : fullName;
    if (!name) continue;

    entries.push({ gid, fullName, name });
  }

  return { version, entries };
}

/**
 * Which dist folder a shop locale reads.
 *
 * Shopify's own locales are the tags the repo publishes ("de", "pt-BR"), so
 * this is mostly a pass-through — but a shop locale arrives in whatever casing
 * Shopify felt like, and the folder names are case-sensitive on a raw file
 * host. `pt-br` would 404 where `pt-BR` works, and a 404 here is silently "no
 * translations for this shop", which is exactly the kind of quiet wrong answer
 * this codebase keeps chasing.
 */
export function taxonomyLocaleFolder(locale: string): string | null {
  const trimmed = (locale || "").trim();
  if (!trimmed) return null;
  const [language, region] = trimmed.split("-");
  if (!/^[A-Za-z]{2,3}$/.test(language)) return null;
  const lower = language.toLowerCase();
  return region ? `${lower}-${region.toUpperCase()}` : lower;
}

/**
 * English is what the Admin API already returns, so importing it would be two
 * copies of one answer — and the second could drift when Shopify ships a
 * category before the open-data release catches up.
 */
export function needsLocalization(locale: string): boolean {
  const folder = taxonomyLocaleFolder(locale);
  return !!folder && !folder.startsWith("en");
}

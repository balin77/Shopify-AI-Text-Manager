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
  /**
   * Derived, because the file does not carry it — see `deriveLeafFlags`.
   *
   * It is not decoration: the picker marks a non-leaf "(broad)", and a product
   * filed under a branch shows up wrong in marketplace listings. Getting it
   * wrong in either direction is a false statement — every hit marked broad,
   * or the warning missing where it is due.
   */
  isLeaf: boolean;
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
 * The last segment of a category path — "Vasen" out of "Heim & Garten >
 * Dekoration > Vasen".
 *
 * Exported because TWO places need it and a second copy is how a splitter
 * drifts: the import below, and the picker's closed control, which shows the
 * chosen category rather than the whole path. A path with no separator IS its
 * own leaf, and a trailing separator yields the segment before it rather than
 * an empty label.
 */
export function leafNameOf(fullName: string): string {
  const path = (fullName || "").trim();
  if (!path) return "";
  const segments = path
    .split(PATH_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : path;
}

/**
 * Which of these categories have children — read off the GIDs themselves.
 *
 * Shopify's taxonomy ids ARE the hierarchy: `hg-3-66-1` sits under `hg-3-66`
 * sits under `hg-3` sits under `hg` (measured on a live shop, where the API's
 * own `parentId` agreed with exactly this reading at every sampled depth). So
 * a category is a leaf when no other line names it as a prefix — no second
 * lookup, no second source, and it cannot disagree with the file it came from.
 */
function deriveLeafFlags(gids: string[]): Set<string> {
  const parents = new Set<string>();
  for (const gid of gids) {
    const lastDash = gid.lastIndexOf("-");
    // A vertical ("…/hg") has no dash and therefore no parent to record.
    if (lastDash > 0) parents.add(gid.slice(0, lastDash));
  }
  return parents;
}

/**
 * Parse the file. Unreadable lines are SKIPPED, never guessed at — a line this
 * does not understand is one category missing its translation, which falls
 * back to the API's English name; a line misread is a category labelled wrong.
 */
export function parseTaxonomyCategoriesFile(text: string): ParsedTaxonomyFile {
  let version = "";
  const entries: Array<Omit<ParsedTaxonomyName, "isLeaf">> = [];

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

    const name = leafNameOf(fullName);
    if (!name) continue;

    entries.push({ gid, fullName, name });
  }

  // Two passes, because a leaf can only be recognised once every line is in:
  // the children of "hg-3" are scattered through the file, not next to it.
  const parents = deriveLeafFlags(entries.map((e) => e.gid));
  return {
    version,
    entries: entries.map((e) => ({ ...e, isLeaf: !parents.has(e.gid) })),
  };
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
 * The dist folders to try for a locale, best first.
 *
 * A regional locale falls back to its base language: Shopify publishes
 * `dist/fr` but no `dist/fr-CA`, and without this a Canadian-French shop 404s
 * once and is then remembered as "no translations" for the whole process —
 * pinned to English although its language is right there. Canadian French
 * labelled from `dist/fr` is the correct answer, not a compromise.
 */
export function taxonomyFolderCandidates(locale: string): string[] {
  const folder = taxonomyLocaleFolder(locale);
  if (!folder) return [];
  const base = folder.split("-")[0];
  return folder === base ? [folder] : [folder, base];
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

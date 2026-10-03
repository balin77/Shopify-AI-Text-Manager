/**
 * Utility functions for Shopify theme template key/file mapping and JSON value replacement.
 * Extracted from app/routes/app.templates.tsx for reusability and testability.
 */

/**
 * Maps a Shopify translatable resource key to its theme file path.
 * Returns null for unknown key patterns (these should be skipped for Shopify push).
 */
export function keyToFilename(key: string): string | null {
  // section.page.{name}.json.* → templates/page.{name}.json (name can contain dots)
  const pageMatch = key.match(/^section\.(page\..+?)\.json\./);
  if (pageMatch) return `templates/${pageMatch[1]}.json`;

  // section.{name}.json.* → templates/{name}.json (name can contain dots, e.g. "product.stoffwaren-anna")
  // Section-group keys carry their theme-root folder ("sections/header-group"), so the
  // name already encodes a full path and must NOT be prefixed with templates/. Ordinary
  // JSON templates never contain a slash, so a "/" reliably distinguishes the two.
  const sectionMatch = key.match(/^section\.(.+?)\.json\./);
  if (sectionMatch) {
    const name = sectionMatch[1];
    return name.includes("/") ? `${name}.json` : `templates/${name}.json`;
  }

  // collections.json.* → templates/list-collections.json (Shopify's default name)
  if (key.startsWith("collections.json.")) return "templates/list-collections.json";

  // Unknown patterns — skip Shopify push
  return null;
}

/**
 * Recursively replaces string values in a JSON object.
 * Uses old→new value mapping with key hints for disambiguation.
 *
 * @returns Set of translation keys that were successfully replaced
 */
export function replaceValuesInJson(
  obj: unknown,
  replacements: Map<string, { oldValue: string; newValue: string; keyHint: string }>,
  currentPath: string[] = [],
): Set<string> {
  const replaced = new Set<string>();

  if (obj === null || obj === undefined || typeof obj !== "object") {
    return replaced;
  }

  // Build a reverse lookup: oldValue → [{ translationKey, newValue, keyHint }]
  const oldValueLookup = new Map<string, Array<{ translationKey: string; newValue: string; keyHint: string }>>();
  for (const [translationKey, { oldValue, newValue, keyHint }] of replacements) {
    if (replaced.has(translationKey)) continue;
    if (!oldValue) continue;
    const existing = oldValueLookup.get(oldValue) || [];
    existing.push({ translationKey, newValue, keyHint });
    oldValueLookup.set(oldValue, existing);
  }

  const record = obj as Record<string, unknown>;
  for (const jsonKey of Object.keys(record)) {
    const value = record[jsonKey];

    if (typeof value === "string" && oldValueLookup.has(value)) {
      const candidates = oldValueLookup.get(value)!;

      // Try to find a match using key hint (last segment of translation key = JSON property name)
      let matched = candidates.find((c) => c.keyHint === jsonKey);

      // If no hint match and only one candidate, use it
      if (!matched && candidates.length === 1) {
        matched = candidates[0];
      }

      if (matched) {
        record[jsonKey] = matched.newValue;
        replaced.add(matched.translationKey);
        const remaining = candidates.filter((c) => c.translationKey !== matched!.translationKey);
        if (remaining.length === 0) {
          oldValueLookup.delete(value);
        } else {
          oldValueLookup.set(value, remaining);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const childReplaced = replaceValuesInJson(value, replacements, [...currentPath, jsonKey]);
      for (const key of childReplaced) {
        replaced.add(key);
      }
    }
  }

  return replaced;
}

/** How many times `value` occurs as a whole string value anywhere in a parsed JSON tree. */
export function countStringOccurrences(obj: unknown, value: string): number {
  if (obj === null || typeof obj !== "object") return 0;
  let count = 0;
  for (const child of Object.values(obj as Record<string, unknown>)) {
    if (typeof child === "string") {
      if (child === value) count++;
    } else if (child && typeof child === "object") {
      count += countStringOccurrences(child, value);
    }
  }
  return count;
}

/** Resource types whose keys live in the theme's default locale file. */
export const LOCALE_CONTENT_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME",
]);

/** Resource types whose values live in config/settings_data.json. */
export const SETTINGS_DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
  "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
]);

/**
 * Whether a key's PRIMARY value has a theme file the app can write. The one
 * answer behind the primary save's file routing and the editor's decision to
 * offer a primary picker at all (an app-embed image setting has no such file).
 */
export function hasPrimaryThemeFile(key: string, resourceType: string | null | undefined): boolean {
  if (keyToFilename(key)) return true;
  const type = resourceType ?? "";
  return LOCALE_CONTENT_RESOURCE_TYPES.has(type) || SETTINGS_DATA_RESOURCE_TYPES.has(type);
}

// ─── Writing a primary value by its exact JSON PATH ──────────────────────────
//
// A translation key names the section (and block) a setting lives in, so the
// JSON path can be derived from it and VERIFIED against the file: a path is only
// used when it EXISTS and holds the value the save expects. Everything here is
// guesswork made safe by that check - a wrongly derived path simply holds
// another value (or nothing) and the caller falls back to the value search.
//
// Verified formats (repo tests and sync): `section.<template>.json.<section>.<setting>`
// and `section.sections/<group>.json.<section>.<setting>` for templates and
// section groups; `<category>.<setting>` for settings_data.json top-level
// settings; `section.<section>[.<block>].<setting>` for settings_data sections.
// NOT verified against a live shop: the spelling of BLOCK segments (a bare
// block id, a literal `block`/`blocks` before it, or `<setting>:<blockId>`) -
// all of these are tried, nested blocks included, and the file decides.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The value at a path, or undefined. */
export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const part of path) {
    if (!isObj(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Sets the value at an EXISTING path (the parent must exist). */
export function setAtPath(root: unknown, path: readonly string[], value: string): boolean {
  const parent = getAtPath(root, path.slice(0, -1));
  if (!isObj(parent)) return false;
  parent[path[path.length - 1]] = value;
  return true;
}

/**
 * Where settings_data.json keeps its LIVE values: `current` (an object), or
 * `presets[current]` when `current` is the NAME of a preset (a string).
 */
export function settingsDataLiveBase(fileJson: unknown): string[] {
  if (isObj(fileJson) && typeof fileJson.current === "string") {
    const presets = fileJson.presets;
    if (isObj(presets) && isObj(presets[fileJson.current])) return ["presets", fileJson.current];
  }
  return ["current"];
}

function walkSection(root: unknown, sectionsPath: string[], segs: string[]): string[][] {
  const sections = getAtPath(root, sectionsPath);
  if (!isObj(sections) || segs.length < 2) return [];
  const sectionId = segs[0];
  const rest = segs.slice(1);
  const last = rest[rest.length - 1];
  const middle = rest.slice(0, -1).filter((x) => x !== "block" && x !== "blocks");
  const variants: Array<{ setting: string; extra: string[] }> = [{ setting: last, extra: [] }];
  if (last.includes(":")) {
    const [setting, id] = last.split(":");
    if (setting && id) variants.push({ setting, extra: [id] });
  }
  const out: string[][] = [];
  for (const v of variants) {
    let path = [...sectionsPath, sectionId];
    let ok = isObj(sections[sectionId]);
    for (const id of [...middle, ...v.extra]) {
      if (!ok) break;
      const blocks = getAtPath(root, [...path, "blocks"]);
      if (!isObj(blocks) || !isObj(blocks[id])) { ok = false; break; }
      path = [...path, "blocks", id];
    }
    if (!ok) continue;
    const candidate = [...path, "settings", v.setting];
    if (typeof getAtPath(root, candidate) === "string") out.push(candidate);
  }
  return out;
}

/**
 * The JSON paths (holding a string) a translation key may address in `filename`.
 * Empty for locale files (they have their own exact-path logic) and for keys it
 * cannot read. The caller still checks the VALUE at the path.
 */
export function resolveKeyJsonPaths(key: string, filename: string, fileJson: unknown): string[][] {
  if (/^(templates|sections)\/.+\.json$/.test(filename)) {
    const m = key.match(/^section\.(.+?)\.json\.(.+)$/);
    return m ? walkSection(fileJson, ["sections"], m[2].split(".")) : [];
  }
  if (filename === "config/settings_data.json") {
    const base = settingsDataLiveBase(fileJson);
    if (key.startsWith("section.")) return walkSection(fileJson, [...base, "sections"], key.slice("section.".length).split("."));
    const setting = key.split(".").pop() ?? "";
    const path = [...base, setting];
    return setting && typeof getAtPath(fileJson, path) === "string" ? [path] : [];
  }
  return [];
}

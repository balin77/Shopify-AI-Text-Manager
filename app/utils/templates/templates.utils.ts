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

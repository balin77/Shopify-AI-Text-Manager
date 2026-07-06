/**
 * Theme-ID helpers for the Theme-Auswahl (Theme Selection) feature.
 *
 * Shopify's `translatableResources(resourceType:…)` query cannot be filtered by
 * theme (see PLAN_THEME_SELECTION §2, Fakt A/B). The only theme identity we get
 * back is the `theme_id` query parameter embedded in a theme resource's GID, e.g.
 *
 *   gid://shopify/OnlineStoreThemeSettingsCategory/Brand+information?theme_id=123456&first_setting_id=brand_headline
 *
 * These helpers extract that id and normalise it to the canonical Theme-GID form
 * (`gid://shopify/OnlineStoreTheme/<id>`) so it is directly comparable with the
 * ids returned by GET_THEMES (`themes.edges[].node.id`).
 */

const THEME_GID_PREFIX = "gid://shopify/OnlineStoreTheme/";

/**
 * Normalise a raw theme id (numeric, or an already-qualified GID in any of the
 * forms Shopify emits) to the canonical `gid://shopify/OnlineStoreTheme/<id>`.
 * Returns null for empty/garbage input.
 */
export function normalizeThemeGid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // decodeURIComponent throws URIError on malformed percent-encoding (e.g. a
  // stray "%"). Fall back to the raw value so a single bad resourceId can never
  // abort a sync or a write. Mirrors scripts/backfill-theme-id.js.
  let value: string;
  try {
    value = decodeURIComponent(String(raw)).trim();
  } catch {
    value = String(raw).trim();
  }
  if (!value) return null;

  // Already a full OnlineStoreTheme GID → return as-is.
  if (value.startsWith(THEME_GID_PREFIX)) {
    const id = value.slice(THEME_GID_PREFIX.length);
    return id ? `${THEME_GID_PREFIX}${id}` : null;
  }

  // Any GID that ends in a numeric segment (defensive: legacy/other forms) →
  // take the trailing numeric id.
  const gidMatch = value.match(/(\d+)\s*$/);
  if (value.startsWith("gid://") && gidMatch) {
    return `${THEME_GID_PREFIX}${gidMatch[1]}`;
  }

  // Bare numeric id.
  if (/^\d+$/.test(value)) {
    return `${THEME_GID_PREFIX}${value}`;
  }

  return null;
}

/**
 * Extract the theme this resource belongs to from its translatable resourceId,
 * normalised to the canonical Theme-GID. Returns null when the GID carries no
 * `theme_id` parameter (some resource types may not — the caller then falls back
 * to the active/selected theme; see PLAN_THEME_SELECTION §4.1, Fakt C).
 */
export function extractThemeIdFromResourceId(resourceId: string | null | undefined): string | null {
  if (!resourceId) return null;
  const match = String(resourceId).match(/[?&]theme_id=([^&]+)/);
  if (!match) return null;
  return normalizeThemeGid(match[1]);
}

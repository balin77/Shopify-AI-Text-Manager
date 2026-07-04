/**
 * Content-type grouping helpers.
 *
 * The Templates page and the three new rubrics it was generalised into (System /
 * Online-Store-Extras / Selling-Plans) all share the SAME ThemeContent data
 * model and the SAME editor behaviour — they only differ by plan-gating
 * `contentType`. The editor stack historically hardwired `contentType ===
 * 'templates'` to switch on that shared behaviour; this helper widens those
 * gates to the whole theme-content family so every rubric behaves identically.
 */

import type { ContentType } from "~/types/content-editor.types";

/** ContentTypes backed by the ThemeContent / ThemeTranslation tables. */
const THEME_CONTENT_TYPES: readonly string[] = [
  "templates",
  "system",
  "delivery",
  "sellingPlans",
  "onlineStoreExtras",
];

/**
 * True when the given content type uses the ThemeContent model and therefore
 * the shared theme-content editor behaviour (dynamic fields, lazy group load,
 * ThemeTranslation persistence, primary-edit gating, etc.).
 */
export function isThemeContentType(contentType: ContentType | string | undefined): boolean {
  return !!contentType && THEME_CONTENT_TYPES.includes(contentType);
}

/**
 * Theme-content rubrics backed by a Shopify RESOURCE rather than a theme file —
 * i.e. the whole family EXCEPT `templates` (the `theme` domain). Their
 * primary/source value cannot be written by this app (no theme file, and the
 * owning resource's update API is either app-owned or unavailable — see the
 * primary-read-only research), so the main language is read-only and only
 * translation into foreign locales is supported.
 */
export function isResourceBackedThemeContent(contentType: ContentType | string | undefined): boolean {
  return isThemeContentType(contentType) && contentType !== "templates";
}

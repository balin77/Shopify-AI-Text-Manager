/**
 * AI action type constants used to classify running fetcher actions.
 *
 * Used by UnifiedContentEditor and UnifiedFieldRenderer to determine
 * loading state scope: "all locales" actions block all language buttons,
 * "per locale" actions only block the targeted language.
 */

/** Actions that translate/generate across ALL locales at once. */
export const ALL_LOCALES_AI_ACTIONS = [
  "translateAll",
  "translateAllAltTextsToAllLocales",
] as const;

/** Actions that target a single locale (block only that locale's buttons). */
export const PER_LOCALE_AI_ACTIONS = [
  "translateAllForLocale",
  "translateAllAltTextsForLocale",
] as const;

/** Image-related actions that block across all locales (used in ImageGalleryField context). */
export const IMAGE_ALL_LOCALES_AI_ACTIONS = [
  "generateAltText",
  "translateAltText",
  "translateAltTextToAllLocales",
  "translateAllAltTextsToAllLocales",
] as const;

/** Image-related actions that target a single locale. */
export const IMAGE_PER_LOCALE_AI_ACTIONS = [
  "translateAllAltTextsForLocale",
] as const;

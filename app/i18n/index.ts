import { de } from "./de";
import { en } from "./en";
import { es } from "./es";

export const translations = {
  de,
  en,
  es,
};

export type Locale = keyof typeof translations;

// Default locale for fallback
export const DEFAULT_LOCALE: Locale = "en";

// Available locales array for iteration/validation
export const availableLocales = Object.keys(translations) as Locale[];

export function getTranslation(locale: Locale) {
  if (!translations[locale]) {
    console.warn(
      `Translation for locale "${locale}" not found, falling back to "${DEFAULT_LOCALE}"`
    );
  }
  return translations[locale] || translations[DEFAULT_LOCALE];
}

// Export individual translations for direct access
export { de, en, es };

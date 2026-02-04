import { de } from "./de";
import { en } from "./en";
import { es } from "./es";

export const translations = {
  de,
  en,
  es,
};

export type Locale = keyof typeof translations;

export function getTranslation(locale: Locale) {
  return translations[locale] || translations.en;
}

// Export individual translations for direct access
export { de, en, es };

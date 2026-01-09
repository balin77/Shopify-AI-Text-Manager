import { de } from "./de";
import { en } from "./en";

export const translations = {
  de,
  en,
};

export type Locale = keyof typeof translations;

export function getTranslation(locale: Locale) {
  return translations[locale] || translations.de;
}

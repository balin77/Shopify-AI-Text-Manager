import { en, type MarketingTranslation } from "./en";
import { de } from "./de";
import { es } from "./es";
import {
  MARKETING_DEFAULT_LOCALE,
  type MarketingLocale,
} from "../../services/marketing-locale.shared";

const bundles: Record<MarketingLocale, MarketingTranslation> = { en, de, es };

export function getMarketingTranslation(locale: MarketingLocale): MarketingTranslation {
  return bundles[locale] ?? bundles[MARKETING_DEFAULT_LOCALE];
}

export type { MarketingTranslation };
export { en, de, es };

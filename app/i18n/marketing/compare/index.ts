import type { MarketingLocale } from "../../../services/marketing-locale.shared";
import { MARKETING_DEFAULT_LOCALE } from "../../../services/marketing-locale.shared";
import { compareDe } from "./de";
import { compareEn } from "./en";
import { compareEs } from "./es";
import type { CompareCopy } from "./types";

/** Own bundle, like the guide's: only the two comparison routes need it. */
const bundles: Record<MarketingLocale, CompareCopy> = { en: compareEn, de: compareDe, es: compareEs };

export function getCompareCopy(locale: MarketingLocale): CompareCopy {
  return bundles[locale] ?? bundles[MARKETING_DEFAULT_LOCALE];
}

export type { CompareCopy, CompetitorCopy } from "./types";

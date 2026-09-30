import type { MarketingLocale } from "../../../services/marketing-locale.shared";
import { MARKETING_DEFAULT_LOCALE } from "../../../services/marketing-locale.shared";
import { guideDe } from "./de";
import { guideEn } from "./en";
import { guideEs } from "./es";
import type { GuideCopy } from "./types";

/**
 * The guide's copy is its own bundle rather than part of `marketing/*.ts`:
 * it is several times the size of everything else on the site, and only the
 * two guide routes need it.
 */
const bundles: Record<MarketingLocale, GuideCopy> = { en: guideEn, de: guideDe, es: guideEs };

export function getGuideCopy(locale: MarketingLocale): GuideCopy {
  return bundles[locale] ?? bundles[MARKETING_DEFAULT_LOCALE];
}

export type { GuideCopy, GuideTopicCopy, GuideSection, GuideCategoryCopy } from "./types";

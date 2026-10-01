/**
 * The ONE echo matcher (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md §2.2).
 *
 * Import-free on purpose: both the verified write helpers and
 * `ShopifyContentService` compare a Shopify echo against what they SENT, and
 * they must agree.
 *
 * The LOCALE is compared case-insensitively — Shopify is inconsistent about
 * the case of regional codes (`pt-BR` sent, `pt-br` echoed), and a
 * translation stored under a differently-cased spelling is the same
 * translation. The KEY is compared exactly (translatable-content keys are
 * lower-case ASCII by construction). Every result is keyed by the spelling
 * that was SENT, never the echoed one: callers look pairs up with what they
 * sent.
 */

export const ECHO_PAIR_SEP = "\u0000";

export function localesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `locale\0key` with the locale folded to lower case — a comparison key only,
 *  never something to mirror or report. */
export function echoComparisonKey(locale: string, key: string): string {
  return `${locale.toLowerCase()}${ECHO_PAIR_SEP}${key}`;
}

export interface EchoedTranslation {
  key: string;
  locale: string;
  value?: string | null;
  market?: { id: string } | null;
}

export interface SentTranslation {
  key: string;
  locale: string;
  marketId?: string;
}

/**
 * The echo entry that confirms one SENT translation, or undefined.
 * `checkMarket`: when Shopify DOES echo a market it must be the one written;
 * when it does not (older echo shape) the app's own tracking governs.
 */
export function findEchoFor<T extends EchoedTranslation>(
  echoed: readonly T[] | null | undefined,
  sent: SentTranslation,
  options: { checkMarket?: boolean } = {},
): T | undefined {
  return (echoed ?? []).find(
    (t) =>
      t.key === sent.key &&
      localesMatch(t.locale, sent.locale) &&
      (!options.checkMarket || !t.market?.id || !sent.marketId || t.market.id === sent.marketId),
  );
}

/**
 * A MARKET override is removed when the text it translates moves.
 *
 * Shopify Markets lets a shop hold a second translation of the same locale for
 * one market — German for Switzerland worded differently from German for
 * Germany. It sits beside the global row under the same (resource, key, locale)
 * and wins on that market's storefront.
 *
 * For a long time every purge in this app filtered `marketId: ""` and left the
 * override standing: it is a deliberately different wording, and deleting one
 * would throw away work nobody could reconstruct. That was right about the
 * value and wrong about the outcome. Nothing re-translates a market override —
 * the automation writes global rows only, because overwriting a hand-written
 * market wording is the one thing it must not do — so when the primary text
 * changed, the override was neither refreshed nor removed. It kept describing
 * text that no longer exists, on the storefront, silently, for good.
 *
 * So the rule is now the one the merchant would state: **the market layer goes
 * exactly when something happens to the global layer beside it.** Purged where
 * the global row is purged, and purged where the global row is RE-TRANSLATED,
 * since that is the one refresh it can never receive. With both switches off
 * nothing is touched, here as everywhere else — "don't delete" means don't
 * delete.
 *
 * Three rails, and the middle one is why this is a module and not four lines at
 * each call site:
 *
 * - It asks the MIRROR first (`TranslationMirror.marketRows`). One DB query,
 *   and on a shop with no overrides — which is most shops — an empty answer
 *   ends it before a single Shopify call. The syncs import market translations
 *   into that mirror, so an override written in Shopify's own editor is in
 *   there too once the resource has been synced; one written since the last
 *   sync is the stated residual.
 * - It removes ONE MARKET PER CALL. `translationsRemove` takes a `marketIds`
 *   list, so every market could ride in one mutation — but its echo carries the
 *   key and the locale and NO market, so a multi-market call cannot say which
 *   layer it actually cleared. Deleting local rows on that evidence is exactly
 *   the "local says gone while the storefront still serves it" failure the echo
 *   rule exists to prevent.
 * - A removal Shopify does not ECHO leaves the local row alone, the same rule
 *   as everywhere else. An unconfirmed market removal costs one stale local row
 *   that the next sync corrects; a wrong delete costs the merchant a wording
 *   they wrote by hand.
 */

import { removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } from "./verified-translations.server";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { TranslationMirror, TranslationRef } from "./stale-translation-sync.server";
import { logger } from "../../utils/logger.server";

/** Separator of the grouping key — written as an ESCAPE, never as a literal
 *  control byte: a NUL in the source makes git treat the file as binary, and
 *  the module that decides irreversible deletions of hand-written merchant
 *  content is the last one that may lose its diff, its blame and its merge.
 *  The same rule `LOCALE_KEY_SEP`, `IN_FLIGHT_SEP` and `digestBaselineKey`
 *  already state where they spell it. */
const GROUP_SEP = "\u0000";

/** The one shape both producers of `currentOverrides` build. */
export function marketOverrideKey(
  resourceId: string,
  marketId: string,
  locale: string,
  key: string,
): string {
  return [resourceId, marketId, locale, key].join(GROUP_SEP);
}

/**
 * Remove every market override of these (resource, key, locale) triples.
 *
 * `refs` are the resources in SHOPIFY terms — the ids `translationsRemove`
 * addresses — and the mirror maps them onto its own rows, exactly as it does
 * for the global layer.
 *
 * Returns how many (market, locale, key) rows were confirmed removed. Never
 * throws: this runs after a primary write that has already succeeded, so a
 * failure here logs and leaves the override standing rather than failing a save
 * or a webhook.
 */
export async function purgeMarketOverrides(params: {
  gateway: ShopifyApiGateway;
  mirror: TranslationMirror;
  refs: readonly TranslationRef[];
  locales: readonly string[];
  keys: readonly string[];
  /**
   * Overrides this purge must WALK PAST, as
   * `resourceId\u0000marketId\u0000locale\u0000key` (`marketOverrideKey`).
   *
   * Two producers, one shape. The sync path puts in what Shopify itself reports
   * as NOT outdated — someone re-translated it against the new source after the
   * change, so it is current and deleting it is plain data loss. A SAVE puts in
   * what it wrote on a market layer itself: the merchant may edit a row's
   * primary text and one market's translation of it in the same save, and
   * whether the purge or the write lands first is the order the client happened
   * to send, which must not decide whether their value survives.
   */
  currentOverrides?: ReadonlySet<string>;
  /** For the log line, so a shop's overrides can be traced to a surface. */
  context?: string;
  /**
   * Filled with the KEYS whose market layer this call did NOT clear for sure:
   * an override it could not read, walked past (current) or whose removal was
   * not confirmed. A key that is in neither this set nor un-asked-for is gone
   * from every market. The caller reports the rest to the editor, which hides
   * market values only for keys proven purged.
   */
  outcome?: { failedKeys: Set<string> };
}): Promise<number> {
  const { gateway, mirror, refs, locales, keys, currentOverrides, context, outcome } = params;
  if (refs.length === 0 || locales.length === 0 || keys.length === 0) return 0;

  let rows: Array<{ resourceId: string; locale: string; key: string; marketId: string }>;
  try {
    rows = await mirror.marketRows(refs, locales, keys);
  } catch (error: unknown) {
    logger.warn("[MarketPurge] Could not read the market overrides — they stay", {
      context: "MarketPurge",
      surface: context,
      error: error instanceof Error ? error.message : String(error),
    });
    for (const key of keys) outcome?.failedKeys.add(key);
    return 0;
  }
  if (rows.length === 0) return 0;

  const refById = new Map(refs.map((ref) => [ref.resourceId, ref] as const));

  // (market, resource) → the locales and keys that market actually holds.
  // Narrowed to the UNION of what exists rather than to the exact pairs:
  // `translationsRemove` takes keys x locales as a cross product and cannot
  // express "this key in that locale only", so a market holding `title` in de
  // and `body_html` in fr is asked for both keys in both locales. The extra
  // pairs are removals of translations that market never had — a no-op Shopify
  // answers silently, which is why the local delete below only follows the
  // ECHO and never the request.
  const byMarketResource = new Map<
    string,
    { marketId: string; ref: TranslationRef; locales: Set<string>; keys: Set<string> }
  >();
  // (market, locale, key) pairs this call is asked to remove; the confirmed
  // ones are ticked off below and whatever is left is reported as failed.
  const wanted = new Set<string>();
  for (const row of rows) {
    const ref = refById.get(row.resourceId);
    if (!ref) continue;
    // An empty market id is the GLOBAL layer, and `removeAndVerifyAcrossLocales`
    // reads it as one: a row that slips through here without a real market
    // would send a global removal — deleting the very translation the repair is
    // about to write back. A store that cannot say which market a row belongs
    // to has not identified an override.
    if (!row.marketId) continue;
    // Shopify says this override is up to date: it was re-translated against
    // the new source after the change. Removing it would delete a current,
    // hand-written value — the one outcome the `outdated` evidence exists to
    // prevent, and the reason it is threaded down here at all.
    if (currentOverrides?.has(marketOverrideKey(row.resourceId, row.marketId, row.locale, row.key))) {
      outcome?.failedKeys.add(row.key);
      continue;
    }
    wanted.add(`${row.marketId}${GROUP_SEP}${row.locale}${GROUP_SEP}${row.key}`);
    const id = `${row.marketId}${GROUP_SEP}${row.resourceId}`;
    const group = byMarketResource.get(id) ?? {
      marketId: row.marketId,
      ref,
      locales: new Set<string>(),
      keys: new Set<string>(),
    };
    group.locales.add(row.locale);
    group.keys.add(row.key);
    byMarketResource.set(id, group);
  }

  let removed = 0;
  let unconfirmed = 0;
  for (const group of byMarketResource.values()) {
    const groupLocales = [...group.locales];
    const groupKeys = [...group.keys];
    try {
      const { confirmedPairs } = await removeAndVerifyAcrossLocales(
        gateway,
        group.ref.resourceId,
        groupKeys,
        groupLocales,
        group.marketId,
      );
      for (const locale of groupLocales) {
        const confirmed = groupKeys.filter((key) =>
          confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}${key}`),
        );
        if (confirmed.length === 0) {
          unconfirmed++;
          continue;
        }
        await mirror.removeMarket(group.ref, locale, confirmed, group.marketId);
        removed += confirmed.length;
        for (const key of confirmed) wanted.delete(`${group.marketId}${GROUP_SEP}${locale}${GROUP_SEP}${key}`);
      }
    } catch (error: unknown) {
      unconfirmed++;
      logger.warn("[MarketPurge] A market removal failed — that override stays", {
        context: "MarketPurge",
        surface: context,
        resourceId: group.ref.resourceId,
        marketId: group.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outcome) {
    for (const pair of wanted) outcome.failedKeys.add(pair.slice(pair.lastIndexOf(GROUP_SEP) + GROUP_SEP.length));
  }
  if (removed > 0 || unconfirmed > 0) {
    logger.info("[MarketPurge] Market overrides of a changed primary text", {
      context: "MarketPurge",
      surface: context,
      markets: new Set([...byMarketResource.values()].map((g) => g.marketId)).size,
      removed,
      unconfirmed,
    });
  }
  return removed;
}

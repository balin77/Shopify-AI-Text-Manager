/**
 * Shared sync utilities
 *
 * Extracted from content-sync, background-sync, and product-sync services
 * to eliminate duplication of fetchShopLocales and fetchAllTranslations.
 */

import { logger } from '~/utils/logger.server';
import type { GraphQLFunction, ShopLocale, ResolvedTranslation, PrimaryContentMap } from './sync-types';
import type { MarketInfo } from '~/types/content-editor.types';

/**
 * Fetch all shop locales from Shopify
 *
 * @param graphqlFn - GraphQL function (admin.graphql or gateway.graphql)
 */
export async function fetchShopLocales(graphqlFn: GraphQLFunction): Promise<ShopLocale[]> {
  const response = await graphqlFn(
    `#graphql
      query getShopLocales {
        shopLocales {
          locale
          name
          primary
          published
        }
      }`
  );

  const data = await response.json();

  if (data.errors?.length > 0) {
    logger.error(`[SyncUtils] GraphQL errors fetching shop locales:`, { errors: data.errors });
    throw new Error(`Failed to fetch shop locales: ${data.errors[0].message}`);
  }

  const locales: ShopLocale[] = data.data?.shopLocales || [];

  if (locales.length === 0) {
    logger.warn(`[SyncUtils] No shop locales found - this might indicate an API issue`);
  }

  return locales;
}

/**
 * Fetch the shop's markets for the market-aware read-back passes.
 *
 * Delegates to ShopifyContentService.loadMarkets, which NEVER throws: missing
 * `read_markets` scope, API errors, or a shop without markets all degrade to
 * `[]` — the sync then runs exactly as before (global layer only).
 */
export async function fetchShopMarkets(graphqlFn: GraphQLFunction): Promise<MarketInfo[]> {
  try {
    const { ShopifyContentService } = await import('../../src/services/shopify-content.service');
    const service = new ShopifyContentService({ graphql: graphqlFn } as never);
    const { markets } = await service.loadMarkets();
    return markets;
  } catch (error) {
    // Belt-and-braces: the market read-back must never break a sync run.
    logger.warn('[SyncUtils] fetchShopMarkets failed — continuing global-only', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Whether a market serves a locale. An empty localeCodes list means the market
 * has no dedicated web presence and therefore no per-locale restriction —
 * Translate & Adapt allows market overrides for ANY published locale there.
 */
export function marketServesLocale(market: MarketInfo, locale: string): boolean {
  return market.localeCodes.length === 0 || market.localeCodes.includes(locale);
}

/**
 * The translation layers to fetch for one locale: the global layer ("") plus
 * one layer per market that actually serves the locale. Bounding by
 * localeCodes keeps the API fan-out proportional to real market coverage.
 */
export function marketLayersForLocale(markets: MarketInfo[], locale: string): string[] {
  return ['', ...markets.filter((m) => marketServesLocale(m, locale)).map((m) => m.id)];
}

/**
 * All layers a market-aware sync run writes: global ("") + every market id.
 * Used to SCOPE delete/cleanup statements so a sync never deletes rows of a
 * layer it did not (re-)fetch — in particular, when loadMarkets degrades to
 * `[]` (missing scope / API error) existing market rows must survive a
 * global-only re-sync. Callers must EXCLUDE markets whose fetch failed
 * (pass `markets.filter(m => !failedMarketIds.has(m.id))`).
 *
 * Deliberate scope note: the scope is per MARKET, not per (locale, market)
 * tuple. When a market stops serving a locale (localeCodes shrank), its rows
 * for that locale are no longer fetched but ARE still cleaned up — that is
 * intended: the storefront can no longer display them, and Shopify remains
 * the source of truth (re-adding the locale restores them on the next sync).
 */
export function fetchedMarketLayers(markets: MarketInfo[]): string[] {
  return ['', ...markets.map((m) => m.id)];
}

/**
 * Fetch translations for all locales for a single resource
 *
 * IMPORTANT: Only saves ACTUAL translations from Shopify.
 * If a field has no translation in Shopify, it will NOT be stored in the database.
 * This prevents the primary language text from appearing as a "translation".
 *
 * Market-aware: when `markets` is non-empty, each (locale, market) pair the
 * market serves is fetched additionally to the global layer and tagged with
 * its marketId on the returned rows ("" = global).
 *
 * @param graphqlFn - GraphQL function (admin.graphql or gateway.graphql)
 * @param resourceId - Shopify resource GID
 * @param locales - Published shop locales
 * @param resourceType - Resource type string for DB storage
 * @param markets - Shop markets for the market-specific passes (default: none)
 * @param failedMarketIds - OUT param: populated with the ids of markets whose
 *   fetch errored for at least one locale. Callers doing delete-then-recreate
 *   must exclude these markets from their delete scope, otherwise a transient
 *   API error would wipe that market's rows without recreating them.
 * @param primaryContentOut - OUT param: filled with the resource's CURRENT
 *   primary values + digests (`translatableContent`). Shopify only lists keys
 *   that HAVE a value, so an absent key means the merchant cleared that field
 *   — which is what the stale-translation reconciliation reads it for
 *   (services/translations/stale-translations.shared.ts).
 */
export async function fetchAllTranslations(
  graphqlFn: GraphQLFunction,
  resourceId: string,
  locales: ShopLocale[],
  resourceType: string,
  markets: MarketInfo[] = [],
  failedMarketIds?: Set<string>,
  primaryContentOut?: PrimaryContentMap
): Promise<ResolvedTranslation[]> {
  const allTranslationsMap = new Map<string, ResolvedTranslation>();

  for (const locale of locales) {
    if (!locale.published) continue;

    for (const marketId of marketLayersForLocale(markets, locale.locale)) {
      try {
        const response = await graphqlFn(
          `#graphql
            query getTranslations($resourceId: ID!, $locale: String!, $marketId: ID) {
              translatableResource(resourceId: $resourceId) {
                translatableContent {
                  key
                  value
                  digest
                  locale
                }
                translations(locale: $locale, marketId: $marketId) {
                  key
                  value
                  locale
                  outdated
                }
              }
            }`,
          { variables: { resourceId, locale: locale.locale, marketId: marketId || null } }
        );

        const data = await response.json();
        if (data.errors?.length > 0) {
          logger.warn(`[SyncUtils] GraphQL error fetching translations for ${locale.locale}${marketId ? ` (market ${marketId})` : ''}: ${data.errors[0].message}`);
          if (marketId) failedMarketIds?.add(marketId);
          continue;
        }

        const resource = data.data?.translatableResource;
        if (!resource) {
          // Null resource on a market pass counts as a failed layer (mirrors
          // product-sync's own fetchAllTranslations) so the caller's delete
          // scope stays conservative on this ambiguous response.
          if (marketId) failedMarketIds?.add(marketId);
          continue;
        }

        const digestMap = new Map<string, string>();

        // Build digest map from translatableContent (for reference only)
        // DO NOT store these as translations - they are source language text
        if (resource.translatableContent) {
          for (const content of resource.translatableContent) {
            digestMap.set(content.key, content.digest);
            if (primaryContentOut) {
              primaryContentOut[content.key] = { value: content.value ?? "", digest: content.digest };
            }
          }
        }

        // ONLY save actual translations from Shopify
        // DO NOT save translatableContent values - those are the source language text
        if (resource.translations && resource.translations.length > 0) {
          for (const translation of resource.translations) {
            const uniqueKey = `${translation.key}::${translation.locale}::${marketId}`;
            if (!allTranslationsMap.has(uniqueKey)) {
              allTranslationsMap.set(uniqueKey, {
                key: translation.key,
                value: translation.value,
                locale: translation.locale,
                digest: digestMap.get(translation.key),
                resourceType,
                marketId,
                outdated: translation.outdated,
              });
            }
          }
        }
      } catch (error) {
        logger.warn(`[SyncUtils] Error fetching translations for locale ${locale.locale}${marketId ? ` (market ${marketId})` : ''}:`, error);
        if (marketId) failedMarketIds?.add(marketId);
      }
    }
  }

  return Array.from(allTranslationsMap.values());
}

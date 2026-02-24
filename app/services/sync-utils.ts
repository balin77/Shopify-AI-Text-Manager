/**
 * Shared sync utilities
 *
 * Extracted from content-sync, background-sync, and product-sync services
 * to eliminate duplication of fetchShopLocales and fetchAllTranslations.
 */

import { logger } from '~/utils/logger.server';
import type { GraphQLFunction, ShopLocale, ResolvedTranslation } from './sync-types';

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
 * Fetch translations for all locales for a single resource
 *
 * IMPORTANT: Only saves ACTUAL translations from Shopify.
 * If a field has no translation in Shopify, it will NOT be stored in the database.
 * This prevents the primary language text from appearing as a "translation".
 *
 * @param graphqlFn - GraphQL function (admin.graphql or gateway.graphql)
 * @param resourceId - Shopify resource GID
 * @param locales - Published shop locales
 * @param resourceType - Resource type string for DB storage
 */
export async function fetchAllTranslations(
  graphqlFn: GraphQLFunction,
  resourceId: string,
  locales: ShopLocale[],
  resourceType: string
): Promise<ResolvedTranslation[]> {
  const allTranslationsMap = new Map<string, ResolvedTranslation>();

  for (const locale of locales) {
    if (!locale.published) continue;

    try {
      const response = await graphqlFn(
        `#graphql
          query getTranslations($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                value
                digest
                locale
              }
              translations(locale: $locale) {
                key
                value
                locale
              }
            }
          }`,
        { variables: { resourceId, locale: locale.locale } }
      );

      const data = await response.json();
      if (data.errors?.length > 0) {
        logger.warn(`[SyncUtils] GraphQL error fetching translations for ${locale.locale}: ${data.errors[0].message}`);
        continue;
      }

      const resource = data.data?.translatableResource;
      if (!resource) continue;

      const digestMap = new Map<string, string>();

      // Build digest map from translatableContent (for reference only)
      // DO NOT store these as translations - they are source language text
      if (resource.translatableContent) {
        for (const content of resource.translatableContent) {
          digestMap.set(content.key, content.digest);
        }
      }

      // ONLY save actual translations from Shopify
      // DO NOT save translatableContent values - those are the source language text
      if (resource.translations && resource.translations.length > 0) {
        for (const translation of resource.translations) {
          const uniqueKey = `${translation.key}::${translation.locale}`;
          if (!allTranslationsMap.has(uniqueKey)) {
            allTranslationsMap.set(uniqueKey, {
              key: translation.key,
              value: translation.value,
              locale: translation.locale,
              digest: digestMap.get(translation.key),
              resourceType,
            });
          }
        }
      }
    } catch (error) {
      logger.warn(`[SyncUtils] Error fetching translations for locale ${locale.locale}:`, error);
    }
  }

  return Array.from(allTranslationsMap.values());
}

/**
 * Shop Locales Cache
 *
 * Caches shop locales from Shopify API to reduce GraphQL calls.
 * Shop locales don't change frequently, so caching them improves TTFB.
 */

import { logger } from '~/utils/logger.server';

interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

interface CachedLocales {
  locales: ShopLocale[];
  timestamp: number;
}

// In-memory cache with 60-second TTL
const SHOP_LOCALES_CACHE = new Map<string, CachedLocales>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// In-flight promise deduplication: concurrent requests for the same shop share one fetch
const IN_FLIGHT = new Map<string, Promise<ShopLocale[]>>();

/**
 * Get shop locales with caching
 * Returns cached locales if available and not expired, otherwise fetches fresh data.
 * Concurrent requests for the same shop are deduplicated via in-flight promise sharing.
 */
export async function getCachedShopLocales(
  admin: any,
  shop: string
): Promise<ShopLocale[]> {
  // Check cache first
  const cached = SHOP_LOCALES_CACHE.get(shop);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    logger.debug(`[ShopLocalesCache] Cache HIT for shop: ${shop} (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
    return cached.locales;
  }

  // Deduplicate concurrent fetches for the same shop
  const existing = IN_FLIGHT.get(shop);
  if (existing) {
    logger.debug(`[ShopLocalesCache] In-flight dedup for shop: ${shop}`);
    return existing;
  }

  logger.debug(`[ShopLocalesCache] Cache MISS for shop: ${shop} - fetching from Shopify`);

  const fetchPromise = (async (): Promise<ShopLocale[]> => {
    try {
      const response = await admin.graphql(`
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }
      `);

      const json = await response.json();
      const locales: ShopLocale[] = json.data?.shopLocales || [];

      // Cache the result
      SHOP_LOCALES_CACHE.set(shop, {
        locales,
        timestamp: Date.now(),
      });

      logger.info(`[ShopLocalesCache] Cached ${locales.length} locales for shop: ${shop}`);
      return locales;
    } catch (error) {
      logger.error(`[ShopLocalesCache] Error fetching locales for shop: ${shop}`, { error });

      // Re-throw 401 so the loader-factory can handle re-authentication.
      // Swallowing a 401 here masks a revoked token and lets the loader continue
      // making more API calls that will also fail.
      if (error instanceof Response && error.status === 401) {
        throw error;
      }

      // For other errors, fall back to stale cache or empty array
      if (cached) {
        logger.info('[ShopLocalesCache] Returning stale cache as fallback');
        return cached.locales;
      }

      return [];
    } finally {
      IN_FLIGHT.delete(shop);
    }
  })();

  IN_FLIGHT.set(shop, fetchPromise);
  return fetchPromise;
}

/**
 * Clear cache for a specific shop (useful for testing or when locales change)
 */
export function clearShopLocalesCache(shop: string): void {
  SHOP_LOCALES_CACHE.delete(shop);
  logger.debug(`[ShopLocalesCache] Cache cleared for shop: ${shop}`);
}

/**
 * Clear all cached locales (useful for testing)
 */
export function clearAllShopLocalesCache(): void {
  const size = SHOP_LOCALES_CACHE.size;
  SHOP_LOCALES_CACHE.clear();
  logger.debug(`[ShopLocalesCache] All cache cleared (${size} entries)`);
}

/**
 * Get cache statistics (useful for debugging)
 */
export function getShopLocalesCacheStats() {
  return {
    size: SHOP_LOCALES_CACHE.size,
    shops: Array.from(SHOP_LOCALES_CACHE.keys()),
    ttlMinutes: CACHE_TTL_MS / 1000 / 60,
  };
}

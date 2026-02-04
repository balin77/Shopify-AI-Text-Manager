/**
 * Shop Locales Cache
 *
 * Caches shop locales from Shopify API to reduce GraphQL calls.
 * Shop locales don't change frequently, so caching them improves TTFB.
 */

interface ShopLocale {
  locale: string;
  primary: boolean;
  published: boolean;
}

interface CachedLocales {
  locales: ShopLocale[];
  timestamp: number;
}

// In-memory cache with 5-minute TTL
const SHOP_LOCALES_CACHE = new Map<string, CachedLocales>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get shop locales with caching
 * Returns cached locales if available and not expired, otherwise fetches fresh data
 */
export async function getCachedShopLocales(
  admin: any,
  shop: string
): Promise<ShopLocale[]> {
  // Check cache first
  const cached = SHOP_LOCALES_CACHE.get(shop);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`[ShopLocalesCache] Cache HIT for shop: ${shop} (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
    return cached.locales;
  }

  console.log(`[ShopLocalesCache] Cache MISS for shop: ${shop} - fetching from Shopify`);

  // Fetch fresh data from Shopify
  try {
    const response = await admin.graphql(`
      query getShopLocales {
        shopLocales {
          locale
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
      timestamp: now,
    });

    console.log(`[ShopLocalesCache] Cached ${locales.length} locales for shop: ${shop}`);
    return locales;
  } catch (error) {
    console.error(`[ShopLocalesCache] Error fetching locales for shop: ${shop}`, error);

    // If we have stale cache, return it as fallback
    if (cached) {
      console.log(`[ShopLocalesCache] Returning stale cache as fallback`);
      return cached.locales;
    }

    // No cache available, return empty array
    return [];
  }
}

/**
 * Clear cache for a specific shop (useful for testing or when locales change)
 */
export function clearShopLocalesCache(shop: string): void {
  SHOP_LOCALES_CACHE.delete(shop);
  console.log(`[ShopLocalesCache] Cache cleared for shop: ${shop}`);
}

/**
 * Clear all cached locales (useful for testing)
 */
export function clearAllShopLocalesCache(): void {
  const size = SHOP_LOCALES_CACHE.size;
  SHOP_LOCALES_CACHE.clear();
  console.log(`[ShopLocalesCache] All cache cleared (${size} entries)`);
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

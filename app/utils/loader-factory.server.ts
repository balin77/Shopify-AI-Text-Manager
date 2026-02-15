/**
 * Loader Factory — Eliminates boilerplate across content route loaders.
 *
 * Every content route (products, collections, pages, blog, menus, templates)
 * shares the same pattern: auth → locales → aiSettings → load items →
 * load translations → build response → error handling.
 *
 * This factory handles the common frame. Each route only provides its
 * specific sync + load + transform logic via the `loadData` callback.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "./logger.server";

// ============================================================================
// Types
// ============================================================================

export interface LoaderContext {
  admin: any;
  session: { shop: string; [key: string]: any };
  db: any;
  shopLocales: any[];
  primaryLocale: string;
  aiSettings: any;
}

export interface ContentLoaderConfig<T> {
  /** Used for log messages, e.g. "PRODUCTS", "COLLECTIONS" */
  logPrefix: string;

  /** Resource type for ContentTranslation lookup, e.g. "Product". null = skip translations. */
  resourceType: string | null;

  /** Key name in the JSON response, e.g. "products", "collections" */
  itemsKey: string;

  /** Sync + Load + Transform. Returns items (without translations) and their IDs. */
  loadData: (ctx: LoaderContext) => Promise<{ items: T[]; ids: string[] }>;

  /** Optional: extra data to include in the response (e.g. plan, maxProducts) */
  extraData?: (ctx: LoaderContext) => Promise<Record<string, any>>;

  /** Optional: extra fields for the error fallback response */
  errorFallback?: Record<string, any>;
}

// ============================================================================
// Factory
// ============================================================================

export function createContentLoader<T extends { id: string }>(
  config: ContentLoaderConfig<T>,
) {
  return async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");
      const { loadAISettingsForValidation } = await import("./loader-helpers");
      const { getCachedShopLocales } = await import("./shop-locales-cache.server");

      const [shopLocales, aiSettings] = await Promise.all([
        getCachedShopLocales(admin, session.shop),
        loadAISettingsForValidation(db, session.shop),
      ]);
      const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

      const ctx: LoaderContext = { admin, session, db, shopLocales, primaryLocale, aiSettings };

      // Route-specific: load items
      const { items, ids } = await config.loadData(ctx);

      // Common: load + group translations
      let translationsByResource: Record<string, any[]> = {};
      if (config.resourceType && ids.length > 0) {
        const allTranslations = await db.contentTranslation.findMany({
          where: { resourceType: config.resourceType, resourceId: { in: ids } },
        });
        translationsByResource = groupBy(allTranslations, "resourceId");
      }

      // Attach translations to items
      const itemsWithTranslations = items.map((item) => ({
        ...item,
        translations: translationsByResource[item.id] || [],
      }));

      // Optional: extra data
      const extra = config.extraData ? await config.extraData(ctx) : {};

      return json({
        [config.itemsKey]: itemsWithTranslations,
        shop: session.shop,
        shopLocales,
        primaryLocale,
        error: null,
        aiSettings,
        ...extra,
      });
    } catch (error: any) {
      logger.error(`[${config.logPrefix}-LOADER] Error`, {
        context: config.logPrefix,
        error: error instanceof Error ? error.message : String(error),
        stack: error.stack,
      });
      return json(
        {
          [config.itemsKey]: [],
          shop: session.shop,
          shopLocales: [],
          primaryLocale: "en",
          error: error.message,
          aiSettings: null,
          ...(config.errorFallback || {}),
        },
        { status: 500 },
      );
    }
  };
}

// ============================================================================
// incrementalSync — Shared helper for Collections, Articles, Menus
// ============================================================================

export async function incrementalSync(
  ctx: LoaderContext,
  options: {
    shopifyIds: Set<string>;
    dbModel: any;
    resourceType: string;
    syncFn: (id: string) => Promise<void>;
    logPrefix: string;
  },
) {
  const local = await options.dbModel.findMany({
    where: { shop: ctx.session.shop },
    select: { id: true },
  });
  const localIds = new Set<string>(local.map((r: any) => r.id));

  // Sync missing items (in Shopify but not in DB)
  const missing = [...options.shopifyIds].filter((id) => !localIds.has(id));
  if (missing.length > 0) {
    logger.info(`[${options.logPrefix}-LOADER] Syncing ${missing.length} new item(s) from Shopify`);
    await Promise.all(missing.map((id) => options.syncFn(id)));
  }

  // Remove deleted items (in DB but not in Shopify)
  const removed = [...localIds].filter((id) => !options.shopifyIds.has(id));
  if (removed.length > 0) {
    logger.info(`[${options.logPrefix}-LOADER] Removing ${removed.length} deleted item(s) from DB`);
    await options.dbModel.deleteMany({
      where: { shop: ctx.session.shop, id: { in: removed } },
    });
    await ctx.db.contentTranslation.deleteMany({
      where: { resourceType: options.resourceType, resourceId: { in: removed } },
    });
  }
}

// ============================================================================
// Utility
// ============================================================================

function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce((acc: Record<string, T[]>, item) => {
    const k = String(item[key]);
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

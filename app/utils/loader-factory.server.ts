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
import { PrismaClient } from "@prisma/client";
import type { AISettings } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { logger } from "./logger.server";
import type { ShopifyGraphQLClient } from "../services/sync-types";
import type { ShopLocale } from "../types/content-editor.types";

// ============================================================================
// Types
// ============================================================================

/** Minimal Prisma model delegate used by incrementalSync */
interface PrismaModelDelegate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany: (args?: { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: any }) => Promise<{ id: string }[]>;
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>;
}

/** AI settings shape returned by loadAISettingsForValidation */
export interface AISettingsForValidation {
  hasHuggingfaceApiKey: boolean;
  hasGeminiApiKey: boolean;
  hasClaudeApiKey: boolean;
  hasOpenaiApiKey: boolean;
  hasGrokApiKey: boolean;
  hasDeepseekApiKey: boolean;
  preferredProvider: string | null;
}

export interface LoaderContext {
  admin: ShopifyGraphQLClient;
  session: { shop: string };
  db: PrismaClient;
  shopLocales: ShopLocale[];
  primaryLocale: string;
  aiSettings: AISettingsForValidation | null;
}

export interface ContentLoaderConfig<T, K extends string = string, E extends Record<string, unknown> = Record<string, unknown>> {
  /** Used for log messages, e.g. "PRODUCTS", "COLLECTIONS" */
  logPrefix: string;

  /** Resource type for ContentTranslation lookup, e.g. "Product". Array for mixed types (e.g. ["Article", "Blog"]). null = skip translations. */
  resourceType: string | string[] | null;

  /** Key name in the JSON response, e.g. "products", "collections" */
  itemsKey: K;

  /** Sync + Load + Transform. Returns items (without translations) and their IDs. */
  loadData: (ctx: LoaderContext) => Promise<{ items: T[]; ids: string[] }>;

  /** Optional: extra data to include in the response (e.g. plan, maxProducts) */
  extraData?: (ctx: LoaderContext) => Promise<E>;

  /** Optional: extra fields for the error fallback response */
  errorFallback?: Partial<E>;
}

// ============================================================================
// Factory
// ============================================================================

export function createContentLoader<T extends { id: string }, K extends string, E extends Record<string, unknown>>(
  config: ContentLoaderConfig<T, K, E>,
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
      const primaryLocale = shopLocales.find((l: ShopLocale) => l.primary)?.locale || "en";

      const ctx: LoaderContext = { admin, session, db, shopLocales, primaryLocale, aiSettings };

      // Route-specific: load items
      const { items, ids } = await config.loadData(ctx);

      // Common: load + group translations
      let translationsByResource: Record<string, unknown[]> = {};
      if (config.resourceType && ids.length > 0) {
        const resourceTypeFilter = Array.isArray(config.resourceType)
          ? { in: config.resourceType }
          : config.resourceType;
        const allTranslations = await db.contentTranslation.findMany({
          where: { shop: session.shop, resourceType: resourceTypeFilter, resourceId: { in: ids } },
        });
        translationsByResource = groupBy(allTranslations, "resourceId");
      }

      // Attach translations to items
      // NOTE: If item already has translations (e.g., metaobjects loaded from Shopify GraphQL),
      // preserve them. Otherwise, use DB translations.
      const itemsWithTranslations = items.map((item) => ({
        ...item,
        translations: (item as { translations?: unknown }).translations || translationsByResource[item.id] || [],
      }));

      // Optional: extra data
      const extra = config.extraData ? await config.extraData(ctx) : ({} as E);

      type LoaderData = Record<K, (T & { translations: unknown[] })[]> & {
        shop: string;
        shopLocales: ShopLocale[];
        primaryLocale: string;
        error: string | null;
        aiSettings: AISettingsForValidation | null;
      } & E;

      return json({
        [config.itemsKey]: itemsWithTranslations,
        shop: session.shop,
        shopLocales,
        primaryLocale,
        error: null,
        aiSettings,
        ...extra,
      } as unknown as LoaderData);
    } catch (error: unknown) {
      if (error instanceof Response) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[${config.logPrefix}-LOADER] Error`, {
        context: config.logPrefix,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      type LoaderData = Record<K, (T & { translations: unknown[] })[]> & {
        shop: string;
        shopLocales: ShopLocale[];
        primaryLocale: string;
        error: string | null;
        aiSettings: AISettingsForValidation | null;
      } & E;

      return json({
        [config.itemsKey]: [],
        shop: session.shop,
        shopLocales: [],
        primaryLocale: "en",
        error: errorMessage,
        aiSettings: null,
        ...(config.errorFallback || {}),
      } as unknown as LoaderData, { status: 500 });
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
    dbModel: PrismaModelDelegate;
    resourceType: string;
    syncFn: (id: string) => Promise<void>;
    logPrefix: string;
    /** When set, the Shopify fetch was capped at this limit.
     *  Deletion of "removed" items is skipped because we can't
     *  distinguish "deleted from Shopify" vs "not fetched due to cap". */
    maxItems?: number;
  },
) {
  const local = await options.dbModel.findMany({
    where: { shop: ctx.session.shop },
    select: { id: true },
  });
  const localIds = new Set<string>(local.map((r: { id: string }) => r.id));

  // Sync missing items (in Shopify but not in DB)
  const missing = [...options.shopifyIds].filter((id) => !localIds.has(id));
  if (missing.length > 0) {
    logger.info(`[${options.logPrefix}-LOADER] Syncing ${missing.length} new item(s) from Shopify`);
    await Promise.all(missing.map((id) => options.syncFn(id)));
  }

  // Remove deleted items (in DB but not in Shopify)
  // Skip when the Shopify fetch was capped — we can't tell if items
  // are truly deleted or just beyond the plan limit.
  const fetchWasCapped = options.maxItems != null && options.shopifyIds.size >= options.maxItems;
  if (!fetchWasCapped) {
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

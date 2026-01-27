import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { restResources } from "@shopify/shopify-api/rest/admin/2025-10";
import prisma from "./db.server";
import { logger } from "./utils/logger.server";

/**
 * Map string API version (e.g., "2025-10") to ApiVersion enum
 * Falls back to October25 (2025-10) if not found or not set
 */
function getApiVersion(versionString?: string): ApiVersion {
  const versionMap: Record<string, ApiVersion> = {
    "2022-10": ApiVersion.October22,
    "2023-01": ApiVersion.January23,
    "2023-04": ApiVersion.April23,
    "2023-07": ApiVersion.July23,
    "2023-10": ApiVersion.October23,
    "2024-01": ApiVersion.January24,
    "2024-04": ApiVersion.April24,
    "2024-07": ApiVersion.July24,
    "2024-10": ApiVersion.October24,
    "2025-01": ApiVersion.January25,
    "2025-04": ApiVersion.April25,
    "2025-07": ApiVersion.July25,
    "2025-10": ApiVersion.October25,
    "2026-01": ApiVersion.January26,
    "2026-04": ApiVersion.April26,
    "unstable": ApiVersion.Unstable,
  };

  const defaultVersion = ApiVersion.October25; // Default to 2025-10 for MEDIA_IMAGE translation support

  if (!versionString) {
    return defaultVersion;
  }

  const version = versionMap[versionString.toLowerCase()];
  if (!version) {
    logger.warn(`[SHOPIFY.SERVER] Unknown API version "${versionString}", falling back to 2025-10`);
    return defaultVersion;
  }

  return version;
}

// Get API version from environment variable
const selectedApiVersion = getApiVersion(process.env.SHOPIFY_API_VERSION);

// Log Shopify configuration on startup
logger.info(`[SHOPIFY.SERVER] Initializing Shopify App...`);
logger.debug(`[SHOPIFY.SERVER] Environment Variables:`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_API_KEY: ${process.env.SHOPIFY_API_KEY ? `${process.env.SHOPIFY_API_KEY.substring(0, 8)}...` : "❌ MISSING"}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_API_SECRET: ${process.env.SHOPIFY_API_SECRET ? "✅ SET" : "❌ MISSING"}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_APP_URL: ${process.env.SHOPIFY_APP_URL || "❌ MISSING (using default)"}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_SCOPES: ${process.env.SHOPIFY_SCOPES || "❌ MISSING"}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_API_VERSION: ${process.env.SHOPIFY_API_VERSION || "❌ MISSING (using default: 2025-10)"}`);
logger.debug(`[SHOPIFY.SERVER]  - NODE_ENV: ${process.env.NODE_ENV || "development"}`);

const scopes = process.env.SHOPIFY_SCOPES?.split(",") || [];
logger.debug(`[SHOPIFY.SERVER] Parsed scopes (${scopes.length}):`, scopes);
logger.debug(`[SHOPIFY.SERVER] Using API version: ${selectedApiVersion}`);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: selectedApiVersion,
  scopes: scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "https://localhost:3000",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  restResources: restResources as any,
  hooks: {
    afterAuth: async ({ session }) => {
      logger.info(`[SHOPIFY.SERVER] afterAuth hook triggered`);
      logger.debug(`[SHOPIFY.SERVER]  - Shop: ${session.shop}`);
      logger.debug(`[SHOPIFY.SERVER]  - Session ID: ${session.id}`);
      logger.debug(`[SHOPIFY.SERVER]  - Has Access Token: ${session.accessToken ? true : false}`);
      logger.debug(`[SHOPIFY.SERVER]  - Scopes: ${session.scope}`);

      try {
        await shopify.registerWebhooks({ session });
        logger.info(`[SHOPIFY.SERVER] Webhooks registered successfully`);
      } catch (error) {
        logger.error(`[SHOPIFY.SERVER] Webhook registration failed:`, error);
      }
    },
  },
  // Note: customShopDomains removed for multi-tenant SaaS compatibility
  // Each shop's custom domain is handled automatically by Shopify's OAuth flow
});

logger.info(`[SHOPIFY.SERVER] Shopify App initialized`);

// Import activity tracking and sync scheduler
import { trackActivity } from "./middleware/activity-tracker.middleware";
import { syncScheduler } from "./services/sync-scheduler.service";

// Wrap authenticate.admin to add activity tracking and scheduler management
const originalAuthenticateAdmin = shopify.authenticate.admin;

const enhancedAuthenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    // Call original authentication
    const { admin, session } = await originalAuthenticateAdmin(request);

    // Track activity for this shop
    await trackActivity(session.shop);

    // Start sync scheduler if not already active
    if (!syncScheduler.isShopActive(session.shop)) {
      logger.info('[SHOPIFY.SERVER] Starting background sync for shop: ' + session.shop);
      syncScheduler.startSyncForShop(session.shop, admin);
    }

    return { admin, session };
  }
};

export default shopify;
export const apiVersion = selectedApiVersion;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = enhancedAuthenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

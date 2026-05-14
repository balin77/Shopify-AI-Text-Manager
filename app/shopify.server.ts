import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { logger } from "./utils/logger.server";
import { EncryptedPrismaSessionStorage } from "./utils/encrypted-session-storage.server";
import { checkAndSyncSubscription } from "./services/billing.server";

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

// Validate ENCRYPTION_KEY at startup — fail fast with a clear message rather than a
// confusing auth loop on the first request (which is what happens when it's missing).
if (!process.env.ENCRYPTION_KEY) {
  throw new Error(
    '[STARTUP] ENCRYPTION_KEY environment variable is required but not set. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

// Trim env vars to prevent whitespace/newline issues.
// A trailing newline in SHOPIFY_API_SECRET breaks HMAC-SHA256 JWT signature
// verification (token exchange) while OAuth client_secret POST still works,
// causing an auth loop where every request after OAuth triggers another OAuth.
const apiKey = (process.env.SHOPIFY_API_KEY || "").trim();
const apiSecretKey = (process.env.SHOPIFY_API_SECRET || "").trim();
const appUrl = (process.env.SHOPIFY_APP_URL || "https://localhost:3000").trim();

// Log Shopify configuration on startup
logger.info(`[SHOPIFY.SERVER] Initializing Shopify App...`);
logger.info(`[SHOPIFY.SERVER] Env diagnostics: SHOPIFY_API_KEY=${apiKey ? `${apiKey.substring(0, 8)}... (len=${apiKey.length})` : "MISSING"} | SHOPIFY_API_SECRET=${apiSecretKey ? `SET (len=${apiSecretKey.length}, rawLen=${process.env.SHOPIFY_API_SECRET?.length})` : "MISSING"} | SHOPIFY_APP_URL=${appUrl}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_SCOPES: ${process.env.SHOPIFY_SCOPES || "❌ MISSING"}`);
logger.debug(`[SHOPIFY.SERVER]  - SHOPIFY_API_VERSION: ${process.env.SHOPIFY_API_VERSION || "❌ MISSING (using default: 2025-10)"}`);
logger.debug(`[SHOPIFY.SERVER]  - NODE_ENV: ${process.env.NODE_ENV || "development"}`);

const scopes = (process.env.SHOPIFY_SCOPES || "").split(",").map(s => s.trim()).filter(Boolean);
logger.info(`[SHOPIFY.SERVER] Parsed scopes (${scopes.length}): ${scopes.join(",")}`);
logger.debug(`[SHOPIFY.SERVER] Using API version: ${selectedApiVersion}`);

const shopify = shopifyApp({
  apiKey,
  apiSecretKey,
  apiVersion: selectedApiVersion,
  scopes,
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedPrismaSessionStorage(new PrismaSessionStorage(prisma)),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      logger.info(`[SHOPIFY.SERVER] afterAuth hook triggered`);
      logger.debug(`[SHOPIFY.SERVER]  - Shop: ${session.shop}`);
      logger.debug(`[SHOPIFY.SERVER]  - Session ID: ${session.id}`);
      logger.debug(`[SHOPIFY.SERVER]  - Has Access Token: ${session.accessToken ? true : false}`);
      logger.debug(`[SHOPIFY.SERVER]  - Scopes: ${session.scope}`);

      // Stop any stale SyncScheduler that was bound to the previous OAuth token.
      // Without this, a reinstalled shop keeps running background sync with the old
      // revoked token until the 5-min inactivity timeout fires.
      if (syncScheduler.isShopActive(session.shop)) {
        syncScheduler.stopSyncForShop(session.shop);
        logger.info(`[SHOPIFY.SERVER] Cleared stale scheduler for ${session.shop} after re-auth`);
      }

      // All webhook subscriptions (app/uninstalled, products/*, collections/*,
      // articles/*, app_subscriptions/update) are declared in shopify.app.toml and
      // registered by Shopify automatically on every (re)install.

      // Reconcile DB plan with live Shopify Billing state on every (re)install.
      // Without this, a reinstall after uninstall keeps the old paid plan in
      // aISettings even though Shopify auto-cancels the subscription on uninstall,
      // until the next APP_SUBSCRIPTIONS_UPDATE webhook or settings load fires.
      try {
        await checkAndSyncSubscription(admin, session.shop);
      } catch (error) {
        logger.warn(`[SHOPIFY.SERVER] afterAuth subscription sync failed`, { shop: session.shop, error: error instanceof Error ? error.message : String(error) });
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

    // Track activity for this shop (fire-and-forget — must not block the response)
    trackActivity(session.shop).catch(err => {
      logger.error('[SHOPIFY.SERVER] trackActivity failed:', err);
    });

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

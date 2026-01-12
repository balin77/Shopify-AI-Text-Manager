import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";
import prisma from "./db.server";

// Log Shopify configuration on startup
console.log("🚀 [SHOPIFY.SERVER] Initializing Shopify App...");
console.log("🔍 [SHOPIFY.SERVER] Environment Variables:");
console.log("  - SHOPIFY_API_KEY:", process.env.SHOPIFY_API_KEY ? `${process.env.SHOPIFY_API_KEY.substring(0, 8)}...` : "❌ MISSING");
console.log("  - SHOPIFY_API_SECRET:", process.env.SHOPIFY_API_SECRET ? "✅ SET" : "❌ MISSING");
console.log("  - SHOPIFY_APP_URL:", process.env.SHOPIFY_APP_URL || "❌ MISSING (using default)");
console.log("  - SHOPIFY_SCOPES:", process.env.SHOPIFY_SCOPES || "❌ MISSING");
console.log("  - NODE_ENV:", process.env.NODE_ENV || "development");

const scopes = process.env.SHOPIFY_SCOPES?.split(",") || [];
console.log("🔍 [SHOPIFY.SERVER] Parsed scopes (" + scopes.length + "):", scopes);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October24,
  scopes: scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "https://localhost:3000",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  restResources: restResources as any,
  hooks: {
    afterAuth: async ({ session }) => {
      console.log("🔐 [SHOPIFY.SERVER] afterAuth hook triggered");
      console.log("  - Shop:", session.shop);
      console.log("  - Session ID:", session.id);
      console.log("  - Access Token:", session.accessToken ? "✅ Present" : "❌ Missing");
      console.log("  - Scopes:", session.scope);

      try {
        await shopify.registerWebhooks({ session });
        console.log("✅ [SHOPIFY.SERVER] Webhooks registered successfully");
      } catch (error) {
        console.error("❌ [SHOPIFY.SERVER] Webhook registration failed:", error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

console.log("✅ [SHOPIFY.SERVER] Shopify App initialized");

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
      console.log(`[SHOPIFY.SERVER] Starting background sync for shop: ${session.shop}`);
      syncScheduler.startSyncForShop(session.shop, admin);
    }

    return { admin, session };
  }
};

export default shopify;
export const apiVersion = ApiVersion.October24;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = enhancedAuthenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createRequire } from "module";

// Import CommonJS modules (rate limiters + server logger)
const require = createRequire(import.meta.url);

let serverLogger;
try {
  ({ serverLogger } = require("./app/middleware/server-logger.cjs"));
} catch (e) {
  // Fallback to console if Winston/server-logger fails to load
  serverLogger = { info: console.log, error: console.error, warn: console.warn };
  console.error("[server.js] Failed to load server-logger.cjs:", e.message);
}

let rateLimiters;
try {
  rateLimiters = require("./app/middleware/rate-limit-cjs.cjs");
} catch (e) {
  serverLogger.error("[server.js] Failed to load rate-limit-cjs.cjs: " + e.message);
  // Provide no-op middleware so server can still start
  const noop = (req, res, next) => next();
  rateLimiters = { apiRateLimit: noop, aiActionRateLimit: noop, webhookRateLimit: noop, authRateLimit: noop, strictRateLimit: noop, bulkOperationRateLimit: noop };
}

const {
  apiRateLimit,
  aiActionRateLimit,
  contentActionRateLimit,
  webhookRateLimit,
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
} = rateLimiters;

installGlobals();

const viteDevServer =
  process.env.NODE_ENV === "production"
    ? undefined
    : await import("vite").then((vite) =>
        vite.createServer({
          server: { middlewareMode: true },
        })
      );

const app = express();

// Trust proxy - configure for Railway deployment
// Only trust the first proxy (Railway's load balancer)
// This prevents IP spoofing while allowing proper IP detection
app.set('trust proxy', 1);

app.use(compression());

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable("x-powered-by");

// Basic security headers (CSP removed - causes issues with Shopify App Bridge)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Apply granular rate limiting
// Webhook rate limiting (high limit for Shopify bursts)
app.use('/webhooks', webhookRateLimit);

// Auth rate limiting (strict to prevent brute force)
app.use('/auth', authRateLimit);

// Strict rate limiting for sensitive settings
app.use('/app/settings', strictRateLimit);

// Bulk operation rate limiting for expensive operations
app.use('/api/sync-products', bulkOperationRateLimit);
app.use('/api/sync-content', bulkOperationRateLimit);

// Content page rate limiting — applied to form submissions (save, copy, translate).
// Uses a permissive 200/min limit because these pages mix AI and non-AI operations
// and routine copy/save clicks must not be throttled. The /api/ai route has its
// own strict 30/min AI limit for direct AI API calls.
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')) {
    if (req.path.includes('/app/products') ||
        req.path.includes('/app/content') ||
        req.path.includes('/app/collections')) {
      return contentActionRateLimit(req, res, next);
    }
  }
  next();
});

// AI API rate limiting for direct /api/ai calls
app.use('/api/ai', aiActionRateLimit);

// General API rate limiting (catch-all for /api routes)
// Exclude polling endpoints that have their own built-in backoff mechanisms
app.use('/api', (req, res, next) => {
  // Skip rate limiting for these endpoints - they have exponential backoff in the client
  const excludedPaths = [
    '/running-tasks-count',
    '/recently-completed-tasks'
  ];

  if (excludedPaths.includes(req.path)) {
    return next();
  }

  return apiRateLimit(req, res, next);
});

// handle asset requests
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  // Vite fingerprints its assets so we can cache forever.
  app.use(
    "/assets",
    express.static("build/client/assets", { immutable: true, maxAge: "1y" })
  );
}

// Everything else (like favicon.ico) is cached for an hour. You may want to be
// more aggressive with this caching.
app.use(express.static("build/client", { maxAge: "1h" }));

app.use(morgan("tiny"));

// Health check endpoint for Railway deployment
// This endpoint is called by Railway to determine if the app is ready to receive traffic
// Returns 503 until the app is fully ready to handle requests
let remixBuildForHealth = null;
app.get("/health", async (req, res) => {
  try {
    // In production, verify the Remix build is loaded and cached
    if (process.env.NODE_ENV === "production") {
      if (!remixBuildForHealth) {
        serverLogger.info("[health] Loading Remix build for health check...");
        remixBuildForHealth = await import("./build/server/index.js");
        serverLogger.info("[health] Remix build loaded, entry exists: " + !!remixBuildForHealth?.entry);
      }
      if (!remixBuildForHealth || !remixBuildForHealth.entry) {
        throw new Error("Remix build not fully loaded (entry=" + !!remixBuildForHealth?.entry + ")");
      }
    }

    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (error) {
    serverLogger.error("[health] Health check failed: " + error.message);
    if (error.stack) serverLogger.error("[health] Stack: " + error.stack.substring(0, 500));
    res.status(503).json({ status: "not ready", error: error.message });
  }
});

// handle SSR requests
serverLogger.info("[server.js] Loading Remix build...");
let remixServerBuild;
try {
  remixServerBuild = viteDevServer
    ? null
    : await import("./build/server/index.js");
  serverLogger.info("[server.js] Remix build loaded successfully");
} catch (e) {
  serverLogger.error("[server.js] Failed to load Remix build: " + e.message);
  serverLogger.error("[server.js] Stack: " + (e.stack || "no stack"));
}

app.all(
  "*",
  createRequestHandler({
    build: viteDevServer
      ? () => viteDevServer.ssrLoadModule("virtual:remix/server-build")
      : remixServerBuild,
    mode: process.env.NODE_ENV,
  })
);

const port = process.env.PORT || 8080;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, async () => {
  serverLogger.info(`Express server listening at http://${host}:${port}`);

  // Start task cleanup service
  try {
    const { TaskCleanupService } = await import("./task-cleanup.service.js");
    const cleanupService = TaskCleanupService.getInstance();
    cleanupService.start();
    serverLogger.info("Task cleanup service started");
  } catch (error) {
    serverLogger.error("Failed to start task cleanup service", { error: String(error) });
  }

  // Recover pending tasks after server restart and start stuck task monitoring
  try {
    const { TaskRecoveryService } = await import("./task-recovery.service.js");
    const recoveryService = TaskRecoveryService.getInstance();
    const result = await recoveryService.recoverPendingTasks();
    serverLogger.info(`Task recovery: ${result.recovered} recovered, ${result.failed} marked as failed`);

    // Start periodic monitoring for stuck tasks
    recoveryService.startStuckTaskMonitoring();
    serverLogger.info("Stuck task monitoring started");
  } catch (error) {
    serverLogger.error("Failed to recover tasks", { error: String(error) });
  }
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  serverLogger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(async () => {
    serverLogger.info("HTTP server closed");

    try {
      // Stop task cleanup service
      const { TaskCleanupService } = await import("./task-cleanup.service.js");
      const cleanupService = TaskCleanupService.getInstance();
      cleanupService.stop();
      serverLogger.info("Task cleanup service stopped");
    } catch (error) {
      serverLogger.error("Error stopping task cleanup service", { error: String(error) });
    }

    try {
      // Stop stuck task monitoring
      const { TaskRecoveryService } = await import("./task-recovery.service.js");
      const recoveryService = TaskRecoveryService.getInstance();
      recoveryService.stopStuckTaskMonitoring();
      serverLogger.info("Stuck task monitoring stopped");
    } catch (error) {
      serverLogger.error("Error stopping stuck task monitoring", { error: String(error) });
    }

    try {
      // Close the shared PrismaClient (used by Remix app + background services)
      if (globalThis.__db) {
        await globalThis.__db.$disconnect();
        serverLogger.info("Database connections closed");
      }
    } catch (error) {
      serverLogger.error("Error closing database connections", { error: String(error) });
    }

    serverLogger.info("Graceful shutdown complete");
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    serverLogger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

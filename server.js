import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createRequire } from "module";

// Import rate limiters from CommonJS module
const require = createRequire(import.meta.url);
const {
  apiRateLimit,
  aiActionRateLimit,
  webhookRateLimit,
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
} = require("./app/middleware/rate-limit-cjs.cjs");

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

// AI action rate limiting for generation/translation
app.use((req, res, next) => {
  // Check if this is an AI action based on form data
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')) {
    // These might be AI actions, apply limit
    if (req.path.includes('/app/products') ||
        req.path.includes('/app/content') ||
        req.path.includes('/app/collections')) {
      return aiActionRateLimit(req, res, next);
    }
  }
  next();
});

// General API rate limiting (catch-all for /api routes)
app.use('/api', apiRateLimit);

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

// handle SSR requests
app.all(
  "*",
  createRequestHandler({
    build: viteDevServer
      ? () => viteDevServer.ssrLoadModule("virtual:remix/server-build")
      : await import("./build/server/index.js"),
    mode: process.env.NODE_ENV,
  })
);

const port = process.env.PORT || 8080;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, async () => {
  console.log(`Express server listening at http://${host}:${port}`);

  // Start task cleanup service
  try {
    const { TaskCleanupService } = await import("./task-cleanup.service.js");
    const cleanupService = TaskCleanupService.getInstance();
    cleanupService.start();
    console.log("✅ Task cleanup service started");
  } catch (error) {
    console.error("❌ Failed to start task cleanup service:", error);
  }
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed');

    try {
      // Stop task cleanup service
      const { TaskCleanupService } = await import("./task-cleanup.service.js");
      const cleanupService = TaskCleanupService.getInstance();
      cleanupService.stop();
      console.log('✅ Task cleanup service stopped');
    } catch (error) {
      console.error('Error stopping task cleanup service:', error);
    }

    try {
      // Close Prisma connections
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      await prisma.$disconnect();
      console.log('✅ Database connections closed');
    } catch (error) {
      console.error('Error closing database connections:', error);
    }

    console.log('Graceful shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

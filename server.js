// Initialize the Shopify Node platform adapter BEFORE the React Router build is
// loaded. The build's module body calls shopifyApp({...}) at top level, which
// reads abstractRuntimeString — if no adapter has registered a runtime string
// yet, the call throws "Missing adapter implementation for 'abstractRuntimeString'"
// and the entire build module fails to load (health check stays at 503 →
// Railway healthcheck retries exhaust → deploy fails).
//
// Why here, not in shopify.server.ts: the side-effect-only import in
// shopify.server.ts gets dropped from the Vite SSR bundle by Rollup
// (@shopify/shopify-app-react-router declares no "sideEffects" field), and even an
// explicit setAbstractRuntimeString call at module top-level was observed to
// be ineffective in the production bundle (Rollup reordering / dual module
// instance suspected). server.js is NOT bundled — Node executes it raw, so
// the side effects always run. The nodeAdapterInitialized binding is used
// below to force-keep this import even if anything ever does bundle this file.
import { nodeAdapterInitialized } from "@shopify/shopify-api/adapters/node";
void nodeAdapterInitialized;

import { createRequestHandler } from "@react-router/express";
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

// installGlobals() is gone in React Router 7: Node 22 (see package.json
// "engines") provides fetch/Request/Response/FormData natively, which is
// everything it used to polyfill.

// Defensive process-level error reporting. Only active in real production
// (APP_ENV === "production" + SENTRY_DSN); otherwise a complete no-op so the
// dev/staging environment never sends events. Lazy + try/catch so a Sentry
// load failure can never prevent the server from starting (mirrors the
// server-logger fallback pattern above).
// Shared gate + scrubbing — the SAME module the TS app uses, so events sent
// from this early window are redacted identically (review R2/H2). Plain .cjs
// so it loads via require() before the React Router build exists.
let sentryScrub;
try {
  sentryScrub = require("./app/utils/sentry-scrub.cjs");
} catch (e) {
  sentryScrub = null;
  serverLogger.error("[server.js] Failed to load sentry-scrub.cjs: " + e.message);
}

let sentryNode = null;
if (sentryScrub && sentryScrub.sentryEnabled()) {
  try {
    sentryNode = await import("@sentry/node");
    sentryNode.init({
      dsn: process.env.SENTRY_DSN,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || "production",
      release:
        process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0"),
      sendDefaultPii: false,
      // Drop OnUncaughtException (R1: would exit despite our handler below),
      // Console (B2: PII/noise breadcrumbs), and LocalVariables(Async)
      // (RISIKO: leaks local variable values — keys/tokens/PII — into stack
      // frames; also shrinks payloads, free-tier friendly).
      integrations: (defaults) =>
        defaults.filter(
          (i) =>
            i.name !== "OnUncaughtException" &&
            i.name !== "Console" &&
            i.name !== "LocalVariables" &&
            i.name !== "LocalVariablesAsync",
        ),
      // R2/B1/B2: identical redaction to the app's beforeSend.
      beforeSend: (event) => sentryScrub.scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => sentryScrub.scrubBreadcrumb(breadcrumb),
    });
    // After an uncaughtException the process is in an undefined state — Node
    // best practice (and the reviewer) say: capture, flush, then exit so
    // Railway restarts a clean container. We override Sentry's own fatal
    // handler (R1) precisely so we control the exit path here.
    process.on("uncaughtException", (err) => {
      serverLogger.error("[server.js] uncaughtException (exiting): " + (err?.stack || err));
      try { sentryNode.captureException(err); } catch {}
      // Flush queued events (2s cap), then exit non-zero regardless.
      Promise.resolve(sentryNode.flush(2000)).catch(() => {}).finally(() => process.exit(1));
      // Hard fallback in case flush() hangs past the cap.
      setTimeout(() => process.exit(1), 2500).unref();
    });
    // Unhandled rejections are usually less catastrophic; keep logging +
    // capturing without exiting to avoid restart loops on transient async
    // errors (the chosen option scoped the controlled exit to
    // uncaughtException only).
    process.on("unhandledRejection", (reason) => {
      try { sentryNode.captureException(reason); } catch {}
      serverLogger.error("[server.js] unhandledRejection: " + String(reason));
    });
    serverLogger.info("[server.js] Sentry initialized (production)");
  } catch (e) {
    sentryNode = null;
    serverLogger.error("[server.js] Sentry init skipped: " + e.message);
  }
}

// Process-level safety net — FALLBACK only. When Sentry is active the richer
// scrubbing + controlled-exit handlers above are already registered; this
// block exists so dev/staging (Sentry disabled) is not left with NO handler
// at all (Node would otherwise terminate on unhandledRejection with no log).
// Guarded on !sentryNode so handlers are never double-registered.
if (!sentryNode) {
  process.on("uncaughtException", (err) => {
    serverLogger.error("[server.js] uncaughtException (exiting): " + (err?.stack || err));
    // Undefined state after an uncaughtException — exit so the supervisor
    // restarts a clean process (mirrors the Sentry-path philosophy).
    setTimeout(() => process.exit(1), 100).unref();
  });
  process.on("unhandledRejection", (reason) => {
    serverLogger.error("[server.js] unhandledRejection: " + String(reason?.stack || reason));
  });
}

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

// HTTP → HTTPS redirect — defense-in-depth. Railway terminates TLS and also
// redirects at the proxy level, but this catches any path that reaches the app
// with X-Forwarded-Proto: http (e.g., internal mis-routing or proxy config change).
// Only active when X-Forwarded-Proto is explicitly "http" so dev has no redirect.
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

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
let reactRouterBuildForHealth = null;
app.get("/health", async (req, res) => {
  try {
    // In production, verify the React Router build is loaded and cached
    if (process.env.NODE_ENV === "production") {
      if (!reactRouterBuildForHealth) {
        serverLogger.info("[health] Loading React Router build for health check...");
        reactRouterBuildForHealth = await import("./build/server/index.js");
        serverLogger.info("[health] React Router build loaded, entry exists: " + !!reactRouterBuildForHealth?.entry);
      }
      if (!reactRouterBuildForHealth || !reactRouterBuildForHealth.entry) {
        throw new Error("React Router build not fully loaded (entry=" + !!reactRouterBuildForHealth?.entry + ")");
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
serverLogger.info("[server.js] Loading React Router build...");
let reactRouterServerBuild;
try {
  reactRouterServerBuild = viteDevServer
    ? null
    : await import("./build/server/index.js");
  serverLogger.info("[server.js] React Router build loaded successfully");
} catch (e) {
  serverLogger.error("[server.js] Failed to load React Router build: " + e.message);
  serverLogger.error("[server.js] Stack: " + (e.stack || "no stack"));
}

app.all(
  "*",
  createRequestHandler({
    build: viteDevServer
      ? () => viteDevServer.ssrLoadModule("virtual:react-router/server-build")
      : reactRouterServerBuild,
    mode: process.env.NODE_ENV,
  })
);

const port = process.env.PORT || 8080;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, async () => {
  serverLogger.info(`Express server listening at http://${host}:${port}`);

  // ───────────────────────────────────────────────────────────────────────
  // R4-C2 — KNOWN multi-instance limitation (assessed; deliberately NOT
  // patched here, documented instead).
  //
  // Every replica that boots starts ALL of the singleton background jobs
  // below (task cleanup, GDPR-audit cleanup, task-recovery / stuck-task
  // reaper, stale-image cleanup, WebP processor) and the in-bundle
  // sync-scheduler cleanup. With >1 replica they run concurrently:
  //   • two reapers can both select the same stuck WebP tasks before either
  //     flips them → double image-op REFUND (interacts with R4-DI3: the
  //     refund is atomic per statement but two reapers each issue one);
  //   • the R4-DI5 product-delete tombstone is an in-process Map → it only
  //     guards resurrect/refund WITHIN one instance, not across replicas;
  //   • duplicated cleanup churn / racing deletes.
  //
  // This is currently LATENT: the app is deployed as a single web process
  // (railway.json: `startCommand: npm run start:production`). NOTE the replica
  // count is NOT pinned in railway.json — it is a Railway dashboard value, so
  // this assumption is only as strong as that setting. Scaling the service past
  // one instance activates every problem listed above.
  //
  // A correct fix needs cluster-wide mutual exclusion, but every safe option
  // is a dedicated piece of infra work, NOT a rider here:
  //   • a held session advisory lock needs a dedicated connection — Prisma's
  //     pool can recycle the lock-owning connection, silently releasing it;
  //   • wrapping each whole job in one tx + pg_try_advisory_xact_lock pins a
  //     connection for minutes and is outright wrong for stale-image (it
  //     sleeps between products → idle-in-transaction);
  //   • a leader-election/lease table needs a migration + TTL renewal.
  // RECOMMENDED when multi-instance is actually enabled: a dedicated
  // `pg`-client session advisory lock acquired once at boot (one well-known
  // key); only the lock holder starts the jobs below; release on shutdown.
  // ───────────────────────────────────────────────────────────────────────

  // Start task cleanup service
  try {
    const { TaskCleanupService } = await import("./task-cleanup.service.js");
    const cleanupService = TaskCleanupService.getInstance();
    cleanupService.start();
    serverLogger.info("Task cleanup service started");
  } catch (error) {
    serverLogger.error("Failed to start task cleanup service", { error: String(error) });
  }

  // Start GDPR audit log cleanup service (enforces 3-year retention,
  // GDPR Art. 5(1)(e)). Compliance-critical — intentionally NOT gated.
  try {
    const { GdprAuditLogCleanupService } = await import("./gdpr-audit-cleanup.service.js");
    const gdprCleanupService = GdprAuditLogCleanupService.getInstance();
    gdprCleanupService.start();
    serverLogger.info("GDPR audit log cleanup service started");
  } catch (error) {
    serverLogger.error("Failed to start GDPR audit log cleanup service", { error: String(error) });
  }

  // Start WebP conversion task processor — gated while app is under Shopify review.
  // Remove this guard once the Image Manager feature set is approved.
  if (process.env.APP_ENV !== "production") {
    try {
      const { WebPProcessorService } = await import("./webp-processor.service.js");
      const webpProcessor = WebPProcessorService.getInstance();
      webpProcessor.start();
      serverLogger.info("WebP processor service started");
    } catch (error) {
      serverLogger.error("Failed to start WebP processor service", { error: String(error) });
    }
  } else {
    serverLogger.info("WebP processor service skipped (APP_ENV=production, feature gated for review)");
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

  // Start stale image cleanup service — gated while app is under Shopify review.
  // Remove this guard once the Image Manager feature set is approved.
  if (process.env.APP_ENV !== "production") {
    try {
      const { StaleImageCleanupService } = await import("./stale-image-cleanup.service.js");
      const staleImageService = StaleImageCleanupService.getInstance();
      staleImageService.start();
      serverLogger.info("Stale image cleanup service started");
    } catch (error) {
      serverLogger.error("Failed to start stale image cleanup service", { error: String(error) });
    }
  } else {
    serverLogger.info("Stale image cleanup service skipped (APP_ENV=production, feature gated for review)");
  }
});

// Graceful shutdown handler
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
  // Reentrancy guard: SIGTERM quickly followed by SIGINT (or a repeated
  // signal) would otherwise stack a second server.close() and a second
  // force-exit timer, racing $disconnect() against the first run's work.
  if (shutdownInProgress) {
    serverLogger.info(`${signal} received but shutdown already in progress — ignoring`);
    return;
  }
  shutdownInProgress = true;
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
      // Stop GDPR audit log cleanup service
      const { GdprAuditLogCleanupService } = await import("./gdpr-audit-cleanup.service.js");
      GdprAuditLogCleanupService.getInstance().stop();
      serverLogger.info("GDPR audit log cleanup service stopped");
    } catch (error) {
      serverLogger.error("Error stopping GDPR audit log cleanup service", { error: String(error) });
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

    if (process.env.APP_ENV !== "production") {
      try {
        // Stop stale image cleanup service
        const { StaleImageCleanupService } = await import("./stale-image-cleanup.service.js");
        StaleImageCleanupService.getInstance().stop();
        serverLogger.info("Stale image cleanup service stopped");
      } catch (error) {
        serverLogger.error("Error stopping stale image cleanup service", { error: String(error) });
      }
    }

    try {
      // Stop the WebP conversion processor (no new polls; in-flight finishes)
      const { WebPProcessorService } = await import("./webp-processor.service.js");
      WebPProcessorService.getInstance().stop();
      serverLogger.info("WebP processor stopped");
    } catch (error) {
      serverLogger.error("Error stopping WebP processor", { error: String(error) });
    }

    try {
      // Stop AI queue dispatch + cancel retry timers, then drain in-flight
      // provider calls BEFORE closing the DB. Otherwise running AI jobs keep
      // writing to a $disconnect()-ed Prisma client and tasks stay "running".
      // The singleton lives inside the React Router bundle, so it's reached via the
      // process-wide globalThis bridge (set in AIQueueService.getInstance()),
      // not a module import. If no AI request ran yet, __aiQueue is undefined
      // and there is nothing to drain.
      const aiQueue = globalThis.__aiQueue;
      if (aiQueue) {
        aiQueue.stop();
        await aiQueue.drain(8000);
        serverLogger.info("AI queue drained");
      } else {
        serverLogger.info("AI queue not initialized — nothing to drain");
      }
    } catch (error) {
      serverLogger.error("Error draining AI queue", { error: String(error) });
    }

    try {
      // Close the shared PrismaClient (used by the app + background services)
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

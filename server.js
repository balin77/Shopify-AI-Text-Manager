import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

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

// Trust proxy - required for Railway/Heroku/etc behind reverse proxy
// This allows express-rate-limit to correctly identify client IPs
app.set('trust proxy', 1);

app.use(compression());

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable("x-powered-by");

// Security: Set Content Security Policy headers
app.use((req, res, next) => {
  // CSP to prevent XSS attacks
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.shopify.com; " +
    "style-src 'self' 'unsafe-inline' https://cdn.shopify.com; " +
    "img-src 'self' data: https: blob:; " +
    "font-src 'self' data: https://cdn.shopify.com; " +
    "connect-src 'self' https://cdn.shopify.com https://*.myshopify.com; " +
    "frame-ancestors 'self' https://*.myshopify.com; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );

  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  next();
});

// General rate limiter: 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
  },
});

// Strict rate limiter for expensive operations: 10 requests per minute
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Rate limit exceeded for this operation.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Please wait before trying again.',
    });
  },
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Apply strict rate limiting to expensive operations
app.use('/api/sync-products', strictLimiter);
app.use('/api/sync-content', strictLimiter);
app.use('/api/setup-webhooks', strictLimiter);

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

app.listen(port, host, async () => {
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

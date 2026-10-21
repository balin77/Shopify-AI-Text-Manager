/**
 * CommonJS Wrapper for Rate Limiting Middleware
 *
 * This file provides CommonJS exports for use in server.js which runs as a
 * CommonJS module. All rate limiters use express-rate-limit with in-memory
 * MemoryStore (single instance). For multi-instance deployments, swap
 * MemoryStore for a shared Redis store (rate-limit-redis).
 *
 * Upgrade note: express-rate-limit ≥ 8.2.2 fixes the IPv4-mapped IPv6
 * address bypass (CVE-like issue reported in npm audit).
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Normalise an IP address so that IPv4-mapped IPv6 addresses
 * (e.g. ::ffff:1.2.3.4) are treated the same as their plain IPv4 form.
 * This closes the dual-stack bypass that affected express-rate-limit < 8.2.2
 * and is retained here as a defence-in-depth measure.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function normalizedIpKey(req) {
  // ipKeyGenerator expects an IP string, not a request object
  const raw = req.ip ? ipKeyGenerator(req.ip) : 'unknown';
  // Strip ::ffff: prefix from IPv4-mapped IPv6 addresses
  return typeof raw === 'string' && raw.startsWith('::ffff:') ? raw.slice(7) : String(raw);
}

/**
 * Standard 429 handler — returns JSON with a correct `retryAfter` value.
 *
 * express-rate-limit sets `req.rateLimit.resetTime` (a Date) when the window
 * resets. When that field is absent (edge case during startup) we fall back to
 * the window duration rather than returning 0.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const standardHandler = (req, res) => {
  const resetTime = req.rateLimit?.resetTime;
  const retryAfter = resetTime
    ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : 60; // safe fallback: 60 seconds

  res.status(429).json({
    error: 'Too many requests, please try again later',
    retryAfter,
  });
};

/**
 * General API Rate Limit — 100 requests per minute per IP.
 * Applied as a catch-all to /api/* (excluding explicitly excluded paths in server.js).
 */
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many API requests, please try again later',
  keyGenerator: normalizedIpKey,
});

/**
 * AI Action Rate Limit — 30 requests per minute per IP.
 * Applied to /api/ai routes only (direct AI API calls).
 */
const aiActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many AI requests, please try again later',
  keyGenerator: normalizedIpKey,
});

/**
 * Content Action Rate Limit — 200 requests per minute per IP.
 * Applied to form submissions on content pages (products, collections, etc.).
 * These pages mix AI and non-AI operations (save, copy, translate) so the
 * limit must be high enough not to throttle routine save/copy clicks.
 */
const contentActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many requests, please try again later',
  keyGenerator: normalizedIpKey,
});

/**
 * Webhook guard — throttles only requests that FAIL verification, per IP.
 *
 * History, because both earlier shapes were wrong. The first SKIPPED every
 * request carrying an `x-shopify-hmac-sha256` header — unverified, so a junk
 * value bypassed it. The second counted EVERY request in a bucket keyed on the
 * `x-shopify-shop-domain` header — also unverified, so ~1000 junk requests a
 * minute naming `victim.myshopify.com` had every REAL delivery for that shop
 * answered 429 (app/uninstalled and the GDPR topics included), and a large
 * legitimate bulk import could trip it on its own.
 *
 * So valid deliveries are never counted at all. The HMAC is verified by the
 * route (`authenticate.webhook`, which reads the body React Router needs, so it
 * cannot be verified here without buffering the raw body first); a failure
 * surfaces as a thrown Response — 401 for a bad HMAC, 400 for missing Shopify
 * headers, 405 for a non-POST. This middleware watches the RESPONSE status on
 * `finish` and counts exactly those per client IP (`trust proxy` is 1, so
 * `req.ip` is the address Railway's edge saw, not a header the sender wrote).
 * An IP past `WEBHOOK_FAILURE_LIMIT` failures in the window is refused with 429
 * BEFORE the route runs. Shopify's own addresses never fail the HMAC check, so
 * they are never blocked, however many deliveries they carry. 404 is NOT
 * counted: a stale subscription pointing at a removed route would otherwise get
 * Shopify's shared IPs blocked for every shop. In-memory, per instance, like
 * every limiter in this file.
 */
const WEBHOOK_FAILURE_WINDOW_MS = 60 * 1000;
const WEBHOOK_FAILURE_LIMIT = 60;
const WEBHOOK_FAILURE_STATUSES = new Set([400, 401, 405]);
const WEBHOOK_FAILURE_MAX_KEYS = 50000;

function createWebhookFailureLimiter(options = {}) {
  const windowMs = options.windowMs ?? WEBHOOK_FAILURE_WINDOW_MS;
  const limit = options.limit ?? WEBHOOK_FAILURE_LIMIT;
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();

  function prune(t) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= t) failures.delete(key);
    }
  }

  function current(key, t) {
    const entry = failures.get(key);
    if (!entry) return null;
    if (entry.resetAt <= t) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  function recordFailure(key) {
    const t = now();
    let entry = current(key, t);
    if (!entry) {
      if (failures.size >= WEBHOOK_FAILURE_MAX_KEYS) prune(t);
      // Still full after pruning: drop the oldest key rather than grow without bound.
      if (failures.size >= WEBHOOK_FAILURE_MAX_KEYS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      entry = { count: 0, resetAt: t + windowMs };
      failures.set(key, entry);
    }
    entry.count += 1;
  }

  function middleware(req, res, next) {
    const key = normalizedIpKey(req);
    const t = now();
    const entry = current(key, t);
    if (entry && entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many failed webhook requests', retryAfter });
      return;
    }
    res.on('finish', () => {
      if (WEBHOOK_FAILURE_STATUSES.has(res.statusCode)) recordFailure(key);
    });
    next();
  }

  middleware.recordFailure = recordFailure;
  middleware.failureCount = (key) => current(key, now())?.count ?? 0;
  return middleware;
}

const webhookRateLimit = createWebhookFailureLimiter();

/**
 * Auth Rate Limit — 5 requests per 15 minutes per IP.
 * Protects OAuth callback and login flows against brute-force.
 */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: normalizedIpKey,
  skipSuccessfulRequests: true, // only count failed/redirect attempts
});

/**
 * Strict Rate Limit — 10 requests per minute per IP.
 * Applied to sensitive mutation endpoints (e.g. /app/settings).
 */
const strictRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many requests to this endpoint, please slow down',
  keyGenerator: normalizedIpKey,
});

/**
 * Bulk Operation Rate Limit — 5 requests per minute per IP.
 * Applied to sync-products and sync-content which trigger Shopify API bursts.
 */
const bulkOperationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many bulk operations, please wait before trying again',
  keyGenerator: normalizedIpKey,
});

module.exports = {
  apiRateLimit,
  aiActionRateLimit,
  contentActionRateLimit,
  webhookRateLimit,
  createWebhookFailureLimiter,
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
};

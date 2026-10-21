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
 * Webhook failure OBSERVER — counts requests that FAIL verification, per IP,
 * and only ever LOGS. It never refuses, delays or 429s anything.
 *
 * /webhooks deliberately has NO throttle at all, and every earlier shape of
 * one was an attack surface:
 *  - a skip for requests carrying `x-shopify-hmac-sha256` (unverified, so a
 *    junk value bypassed it);
 *  - a bucket keyed on `x-shopify-shop-domain` (unverified, so junk requests
 *    naming `victim.myshopify.com` got that shop's REAL deliveries 429'd —
 *    app/uninstalled and the GDPR topics included);
 *  - a per-IP block after N failed verifications. Shopify delivers every app's
 *    webhooks from SHARED egress IPs, so an attacker with their own Partner app
 *    can subscribe a webhook to our URL, signed with THEIR secret: every one of
 *    those deliveries fails our HMAC check, arrives from Shopify's IPs, and the
 *    block then refuses Shopify's genuine deliveries for every merchant.
 *
 * Any IP- or header-keyed throttle can be aimed at Shopify's shared delivery
 * IPs or at a victim shop, and none is needed: every unverified request is
 * rejected cheaply by the route's `authenticate.webhook` HMAC check (one HMAC
 * over the body, no DB work). The same goes for an edge/CDN layer in front of
 * this app: it must not rate-limit /webhooks by IP either (the deployment
 * assumes Railway's edge passes /webhooks straight through, `trust proxy` 1,
 * so `req.ip` is the address that edge saw). And a misconfiguration on OUR
 * side — a rotated API secret, the platform-adapter regression described in
 * CLAUDE.md ("Deploy-critical gotchas", every delivery answered 400) — must
 * keep surfacing as 401/400 in the Partner Dashboard's delivery log; a 429
 * would hide the real cause behind "rate limited".
 *
 * What this middleware does: on the response's `finish` (or `close` when the
 * connection dropped before `finish`, counted once), a 400/401/405 increments
 * a per-IP counter in a bounded in-memory map, and the FIRST time an IP crosses
 * `threshold` within a window one warn line is written — so a spike is visible
 * in the logs without being acted on. 404 and 5xx are not counted.
 */
const WEBHOOK_FAILURE_WINDOW_MS = 60 * 1000;
const WEBHOOK_FAILURE_WARN_THRESHOLD = 60;
const WEBHOOK_FAILURE_STATUSES = new Set([400, 401, 405]);
const WEBHOOK_FAILURE_MAX_KEYS = 50000;

function defaultWebhookWarn(message) {
  try {
    // Lazily, so a broken logger can never take the middleware down.
    const { serverLogger } = require('./server-logger.cjs');
    serverLogger.warn(message);
  } catch {
    console.warn(message);
  }
}

function createWebhookFailureObserver(options = {}) {
  const windowMs = options.windowMs ?? WEBHOOK_FAILURE_WINDOW_MS;
  const threshold = options.threshold ?? WEBHOOK_FAILURE_WARN_THRESHOLD;
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? defaultWebhookWarn;
  /** @type {Map<string, { count: number, resetAt: number, warned: boolean }>} */
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

  function recordFailure(key, status) {
    const t = now();
    let entry = current(key, t);
    if (!entry) {
      if (failures.size >= WEBHOOK_FAILURE_MAX_KEYS) prune(t);
      // Still full after pruning: drop the oldest key rather than grow without bound.
      if (failures.size >= WEBHOOK_FAILURE_MAX_KEYS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      entry = { count: 0, resetAt: t + windowMs, warned: false };
      failures.set(key, entry);
    }
    entry.count += 1;
    if (!entry.warned && entry.count >= threshold) {
      entry.warned = true;
      try {
        warn(
          `[webhooks] ${entry.count} failed webhook verifications (last status ${status}) from ${key} ` +
            `within ${Math.round(windowMs / 1000)}s — observed only, nothing is throttled`,
        );
      } catch {
        // Logging must never affect the request.
      }
    }
  }

  function middleware(req, res, next) {
    const key = normalizedIpKey(req);
    let counted = false;
    const observe = () => {
      if (counted) return;
      counted = true;
      if (WEBHOOK_FAILURE_STATUSES.has(res.statusCode)) recordFailure(key, res.statusCode);
    };
    res.on('finish', observe);
    res.on('close', observe);
    next();
  }

  middleware.recordFailure = recordFailure;
  middleware.failureCount = (key) => current(key, now())?.count ?? 0;
  return middleware;
}

const webhookFailureObserver = createWebhookFailureObserver();

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
  webhookFailureObserver,
  createWebhookFailureObserver,
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
};

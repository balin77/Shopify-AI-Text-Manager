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
 * Returns true for Shopify webhook requests that carry a valid HMAC header.
 * The actual HMAC verification is done by the webhook handler; here we only
 * gate on header presence so legitimate Shopify bursts are not throttled.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const skipVerifiedWebhook = (req) => !!req.headers['x-shopify-hmac-sha256'];

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
 * Webhook Rate Limit — 1 000 requests per minute per shop domain.
 * Requests from Shopify that carry an HMAC header are skipped entirely;
 * the webhook handler verifies the HMAC, making double-counting unnecessary.
 */
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many webhook requests',
  skip: skipVerifiedWebhook,
  keyGenerator: (req) => {
    // Prefer shop-domain key; fall back to normalised IP so the limiter
    // still applies when the header is absent (e.g. during load testing).
    const shop = req.headers['x-shopify-shop-domain'];
    return shop ? `shop:${shop}` : normalizedIpKey(req);
  },
});

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
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
};

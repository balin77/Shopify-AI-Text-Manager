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
 * Webhook Rate Limit — 1 000 requests per minute per shop domain.
 *
 * It used to SKIP every request carrying an `x-shopify-hmac-sha256` header,
 * on the reasoning that the webhook handler verifies the HMAC. But the skip
 * checked only that the header was PRESENT, so anyone could bypass the
 * limiter by sending a junk value — and every such request still reached the
 * route, read its body and ran the HMAC check. Verifying here would mean
 * buffering the raw body in express before React Router reads it, so the
 * limiter applies to every request instead.
 *
 * Why that does not throttle legitimate bursts: the key is the SHOP domain,
 * not the IP (Shopify delivers from a shared pool of addresses, so one IP
 * carries many shops), and 1 000 per minute per shop is far above what one
 * shop's admin activity produces. A delivery that is refused anyway gets a
 * 429, which Shopify RETRIES with back-off — a delay, not a lost event.
 * Stated residual: a sender that rotates the (unverified) shop header gets a
 * fresh bucket per value; each such request still fails the HMAC check.
 */
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many webhook requests',
  keyGenerator: (req) => {
    // Prefer shop-domain key; fall back to normalised IP so the limiter
    // still applies when the header is absent.
    const shop = req.headers['x-shopify-shop-domain'];
    return typeof shop === 'string' && shop.trim()
      ? `shop:${shop.trim().toLowerCase()}`
      : normalizedIpKey(req);
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

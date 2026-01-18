/**
 * CommonJS Wrapper for Rate Limiting Middleware
 *
 * This file provides CommonJS exports for use in server.js
 * which runs as a CommonJS module.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Standard handler for rate limit exceeded
 */
const standardHandler = (req, res) => {
  res.status(429).json({
    error: 'Too many requests, please try again later',
    retryAfter: Math.ceil((req.rateLimit.resetTime || Date.now()) / 1000),
  });
};

/**
 * Skip rate limiting for verified Shopify webhooks
 */
const skipWebhookVerification = (req) => {
  if (req.path.startsWith('/webhooks/')) {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    return !!hmac;
  }
  return false;
};

/**
 * General API Rate Limit (100 requests per minute)
 */
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many API requests, please try again later',
  keyGenerator: ipKeyGenerator,
});

/**
 * AI Action Rate Limit (30 requests per minute)
 */
const aiActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many AI requests, please try again later',
  keyGenerator: ipKeyGenerator,
});

/**
 * Webhook Rate Limit (1000 requests per minute)
 */
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  skip: skipWebhookVerification,
  message: 'Too many webhook requests',
  keyGenerator: (req) => {
    const shop = req.headers['x-shopify-shop-domain'];
    if (shop) {
      return shop;
    }
    return ipKeyGenerator(req);
  },
});

/**
 * Auth Rate Limit (5 requests per 15 minutes)
 */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: ipKeyGenerator,
});

/**
 * Strict Rate Limit (10 requests per minute)
 */
const strictRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many requests to this endpoint, please slow down',
  keyGenerator: ipKeyGenerator,
});

/**
 * Bulk Operation Rate Limit (5 requests per minute)
 */
const bulkOperationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many bulk operations, please wait before trying again',
  keyGenerator: ipKeyGenerator,
});

module.exports = {
  apiRateLimit,
  aiActionRateLimit,
  webhookRateLimit,
  authRateLimit,
  strictRateLimit,
  bulkOperationRateLimit,
};

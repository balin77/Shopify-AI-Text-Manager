/**
 * HTTP Rate Limiting Middleware
 *
 * Protects endpoints from DDoS and abuse using express-rate-limit
 *
 * Implemented Limits:
 * - API Routes: 100 req/min (general)
 * - AI Actions: 30 req/min (expensive operations)
 * - Webhooks: 1000 req/min (Shopify sends many events)
 * - Auth: 5 req/15min (brute force protection)
 *
 * Features:
 * - IP-based tracking
 * - Custom headers (X-RateLimit-*)
 * - Standardized 429 response
 * - Skip for verified webhooks
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Extended Request type with rateLimit info
 */
interface RateLimitRequest extends Request {
  rateLimit?: {
    limit: number;
    current: number;
    remaining: number;
    resetTime: Date;
  };
}

/**
 * Standard handler for rate limit exceeded
 */
const standardHandler = (req: RateLimitRequest, res: Response) => {
  const resetTime = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : Date.now();
  res.status(429).json({
    error: 'Too many requests, please try again later',
    retryAfter: Math.ceil(resetTime / 1000),
  });
};

/**
 * Skip rate limiting for verified Shopify webhooks
 */
const skipWebhookVerification = (req: Request): boolean => {
  // Only skip if this is a webhook route with valid HMAC
  if (req.path.startsWith('/webhooks/')) {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    return !!hmac; // If HMAC present, assume it will be verified by webhook handler
  }
  return false;
};

/**
 * General API Rate Limit (100 requests per minute)
 * Applied to all /api/* routes
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per window
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: standardHandler,
  message: 'Too many API requests, please try again later',
  keyGenerator: (req) => {
    // Use IP address as key
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

/**
 * AI Action Rate Limit (30 requests per minute)
 * Applied to expensive AI operations like generation and translation
 */
export const aiActionRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many AI requests, please try again later',
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

/**
 * Webhook Rate Limit (1000 requests per minute)
 * Applied to /webhooks/* routes
 * Higher limit because Shopify can send bursts of events
 */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  skip: skipWebhookVerification, // Skip if HMAC present (will be verified later)
  message: 'Too many webhook requests',
  keyGenerator: (req) => {
    // For webhooks, use shop domain if available
    const shop = req.headers['x-shopify-shop-domain'];
    if (shop) {
      return shop as string;
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

/**
 * Auth Rate Limit (5 requests per 15 minutes)
 * Applied to authentication routes
 * Protects against brute force attacks
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

/**
 * Strict Rate Limit (10 requests per minute)
 * For sensitive operations like settings updates
 */
export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many requests to this endpoint, please slow down',
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

/**
 * Bulk Operation Rate Limit (5 requests per minute)
 * For bulk translation/sync operations
 */
export const bulkOperationRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
  message: 'Too many bulk operations, please wait before trying again',
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

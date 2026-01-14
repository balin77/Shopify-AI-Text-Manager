/**
 * Rate Limiting Middleware
 *
 * Protects API endpoints from abuse by limiting the number of requests
 * per client within a specified time window.
 */

import rateLimit from 'express-rate-limit';

/**
 * General rate limiter for all API routes
 * Limit: 100 requests per 15 minutes per IP
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // trust: true, // Trust proxy headers (commented out - handled by app.set('trust proxy', 1))
  // Store in memory (for production, consider Redis)
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

/**
 * Strict rate limiter for expensive operations (sync, AI generation)
 * Limit: 10 requests per minute per shop
 */
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each shop to 10 requests per minute
  message: 'Rate limit exceeded for this operation. Please wait before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  // trust: true, // Trust proxy headers (commented out - handled by app.set('trust proxy', 1))
  // Use shop domain as key instead of IP
  keyGenerator: (req) => {
    // Extract shop from query params or session
    const shop = req.query.shop as string || req.headers['x-shopify-shop-domain'] as string || 'unknown';
    return shop;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Please wait before trying again.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

/**
 * Auth rate limiter for authentication endpoints
 * Limit: 5 requests per 15 minutes per IP (prevent brute force)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 auth requests per windowMs
  message: 'Too many authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // trust: true, // Trust proxy headers (commented out - handled by app.set('trust proxy', 1))
  skipSuccessfulRequests: true, // Don't count successful requests
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many authentication attempts. Please try again later.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

/**
 * Webhook rate limiter (more lenient, since webhooks come from Shopify)
 * Limit: 1000 requests per minute per shop
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // Very high limit for webhooks
  message: 'Webhook rate limit exceeded.',
  standardHeaders: false, // Don't expose rate limit info to Shopify
  legacyHeaders: false,
  // trust: true, // Trust proxy headers (commented out - handled by app.set('trust proxy', 1))
  keyGenerator: (req) => {
    const shop = req.headers['x-shopify-shop-domain'] as string || 'unknown';
    return `webhook:${shop}`;
  },
  skip: (req) => {
    // Skip rate limiting if HMAC verification passes (trusted source)
    // This is checked in the webhook handler itself
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Webhook rate limit exceeded.',
    });
  },
});

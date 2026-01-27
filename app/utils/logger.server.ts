/**
 * Structured Logging Utility using Winston
 *
 * Replaces console.log statements with structured logging
 * - Environment-based log levels (debug in dev, info in prod)
 * - JSON format for structured data
 * - Context support for categorization
 * - File and console output
 *
 * Usage:
 *
 * import { logger } from '~/utils/logger.server';
 *
 * logger.info('Product updated', {
 *   context: 'ProductSync',
 *   productId: 'gid://123'
 * });
 *
 * logger.error('Translation failed', {
 *   context: 'TranslationService',
 *   error: err.message
 * });
 *
 * logger.debug('Queue processing', {
 *   context: 'AIQueue',
 *   queueLength: 5
 * });
 */

import winston from 'winston';
import path from 'path';

// Determine log level based on environment
// APP_ENV can be used to enable debug logging even in NODE_ENV=production
const getLogLevel = () => {
  // Allow explicit LOG_LEVEL override
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  // Use debug level if APP_ENV is development (even if NODE_ENV is production)
  if (process.env.APP_ENV === 'development') {
    return 'debug';
  }
  // Default: info in production, debug otherwise
  if (process.env.NODE_ENV === 'production') {
    return 'info';
  }
  return 'debug';
};

// Custom format for console output with colors
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
    let logMessage = `${timestamp} [${level}]`;

    if (context) {
      logMessage += ` [${context}]`;
    }

    logMessage += `: ${message}`;

    // Add metadata if present
    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
      logMessage += ` ${JSON.stringify(meta)}`;
    }

    return logMessage;
  })
);

// JSON format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');

// Create transports array
const transports: winston.transport[] = [
  // Console output (always enabled)
  new winston.transports.Console({
    format: consoleFormat,
  }),
];

// File output (only in production)
if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Create logger instance
export const logger = winston.createLogger({
  level: getLogLevel(),
  transports,
  // Don't exit on uncaught exceptions
  exitOnError: false,
});

/**
 * Context-specific loggers for common areas
 */
export const loggers = {
  ai: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'AIService', ...meta }),

  queue: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'AIQueue', ...meta }),

  product: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'ProductSync', ...meta }),

  translation: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'Translation', ...meta }),

  webhook: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'Webhook', ...meta }),

  auth: (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, any>) =>
    logger.log(level, message, { context: 'Auth', ...meta }),
};

/**
 * Helper to log performance metrics
 */
export const logPerformance = (operation: string, startTime: number, meta?: Record<string, any>) => {
  const duration = Date.now() - startTime;
  logger.info(`Performance: ${operation}`, {
    context: 'Performance',
    duration: `${duration}ms`,
    ...meta,
  });
};

/**
 * Helper to log API calls
 */
export const logApiCall = (
  provider: string,
  endpoint: string,
  status: 'success' | 'error',
  duration?: number,
  meta?: Record<string, any>
) => {
  const level = status === 'error' ? 'error' : 'info';
  logger.log(level, `API Call: ${provider} ${endpoint}`, {
    context: 'API',
    provider,
    endpoint,
    status,
    duration: duration ? `${duration}ms` : undefined,
    ...meta,
  });
};

// Log when logger is initialized
logger.info('Logger initialized', {
  context: 'System',
  level: getLogLevel(),
  NODE_ENV: process.env.NODE_ENV || 'development',
  APP_ENV: process.env.APP_ENV || 'not set',
});

/**
 * CommonJS Logger for server.js
 *
 * server.js is an ESM module that runs before the TypeScript build, so it
 * cannot import from app/utils/logger.server.ts directly. This CJS wrapper
 * provides a minimal Winston logger with the same format used in the app.
 *
 * Loaded via createRequire(import.meta.url) in server.js.
 */

'use strict';

const winston = require('winston');

const serverLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level}]: [server] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error', 'warn'],
    }),
  ],
});

module.exports = { serverLogger };

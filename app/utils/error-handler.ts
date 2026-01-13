/**
 * Error Handling Utility
 *
 * Provides safe error handling that doesn't leak sensitive information
 * to end users while maintaining detailed server-side logging.
 */

/**
 * Generic error messages for different error types
 */
const SAFE_ERROR_MESSAGES = {
  validation: 'The provided data is invalid. Please check your input and try again.',
  authentication: 'Authentication failed. Please log in again.',
  authorization: 'You do not have permission to perform this action.',
  notFound: 'The requested resource was not found.',
  rateLimit: 'Too many requests. Please try again later.',
  database: 'A database error occurred. Please try again later.',
  external: 'An error occurred while communicating with an external service.',
  network: 'A network error occurred. Please check your connection.',
  server: 'An internal server error occurred. Please try again later.',
  unknown: 'An unexpected error occurred. Please try again later.',
};

/**
 * Error types for categorization
 */
export type ErrorType = keyof typeof SAFE_ERROR_MESSAGES;

/**
 * Custom error class with safe public messages
 */
export class SafeError extends Error {
  public readonly type: ErrorType;
  public readonly publicMessage: string;
  public readonly statusCode: number;
  public readonly details?: any;

  constructor(
    type: ErrorType,
    internalMessage: string,
    statusCode: number = 500,
    details?: any
  ) {
    super(internalMessage);
    this.name = 'SafeError';
    this.type = type;
    this.publicMessage = SAFE_ERROR_MESSAGES[type];
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Log error with full details (server-side only)
 */
export function logError(error: Error | SafeError, context?: Record<string, any>) {
  const timestamp = new Date().toISOString();

  console.error(`[ERROR] ${timestamp}`, {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error instanceof SafeError && {
      type: error.type,
      statusCode: error.statusCode,
      details: error.details,
    }),
    context,
  });
}

/**
 * Convert any error to a safe response object
 *
 * This function ensures that sensitive information (stack traces, internal paths, etc.)
 * is never sent to the client.
 */
export function toSafeErrorResponse(error: unknown, context?: Record<string, any>): {
  message: string;
  type?: ErrorType;
  statusCode: number;
} {
  // Handle SafeError instances
  if (error instanceof SafeError) {
    logError(error, context);
    return {
      message: error.publicMessage,
      type: error.type,
      statusCode: error.statusCode,
    };
  }

  // Handle standard Error instances
  if (error instanceof Error) {
    logError(error, context);

    // Try to categorize the error
    const errorType = categorizeError(error);

    return {
      message: SAFE_ERROR_MESSAGES[errorType],
      type: errorType,
      statusCode: getStatusCodeForType(errorType),
    };
  }

  // Handle unknown error types
  console.error('[ERROR] Unknown error type:', error, context);
  return {
    message: SAFE_ERROR_MESSAGES.unknown,
    type: 'unknown',
    statusCode: 500,
  };
}

/**
 * Attempt to categorize a standard Error based on its message
 */
function categorizeError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (message.includes('validation') || message.includes('invalid')) {
    return 'validation';
  }

  if (message.includes('unauthorized') || message.includes('authentication')) {
    return 'authentication';
  }

  if (message.includes('forbidden') || message.includes('permission')) {
    return 'authorization';
  }

  if (message.includes('not found') || message.includes('does not exist')) {
    return 'notFound';
  }

  if (message.includes('rate limit') || message.includes('too many')) {
    return 'rateLimit';
  }

  if (message.includes('database') || message.includes('prisma')) {
    return 'database';
  }

  if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
    return 'network';
  }

  if (message.includes('api') || message.includes('external')) {
    return 'external';
  }

  return 'server';
}

/**
 * Get appropriate HTTP status code for error type
 */
function getStatusCodeForType(type: ErrorType): number {
  switch (type) {
    case 'validation':
      return 400;
    case 'authentication':
      return 401;
    case 'authorization':
      return 403;
    case 'notFound':
      return 404;
    case 'rateLimit':
      return 429;
    case 'database':
    case 'external':
    case 'server':
    case 'unknown':
    default:
      return 500;
  }
}

/**
 * Create a validation error
 */
export function createValidationError(message: string, details?: any): SafeError {
  return new SafeError('validation', message, 400, details);
}

/**
 * Create a not found error
 */
export function createNotFoundError(resource: string): SafeError {
  return new SafeError('notFound', `${resource} not found`, 404);
}

/**
 * Create a rate limit error
 */
export function createRateLimitError(retryAfter?: number): SafeError {
  return new SafeError('rateLimit', 'Rate limit exceeded', 429, { retryAfter });
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context?: Record<string, any>
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      const safeError = toSafeErrorResponse(error, context);
      throw new SafeError(
        safeError.type || 'unknown',
        error instanceof Error ? error.message : 'Unknown error',
        safeError.statusCode
      );
    }
  }) as T;
}

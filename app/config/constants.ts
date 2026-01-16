/**
 * Centralized Configuration Constants
 *
 * All magic numbers, timeouts, and configuration values are defined here
 * for easy maintenance and documentation.
 */

// ============================================================================
// TASK CONFIGURATION
// ============================================================================

/**
 * Task-related configuration
 */
export const TASK_CONFIG = {
  /**
   * Number of days before a task expires and can be deleted
   * Used in: task cleanup, expiration checks
   */
  EXPIRY_DAYS: 3,

  /**
   * Progress percentage values for different task states
   */
  PROGRESS: {
    /**
     * Initial progress when task is created
     */
    INITIAL: 10,

    /**
     * Progress when task is queued for processing
     */
    QUEUED: 10,

    /**
     * Progress range while task is running (10-90%)
     */
    RUNNING_START: 10,
    RUNNING_END: 90,

    /**
     * Progress when task is completed
     */
    COMPLETED: 100,
  },

  /**
   * Maximum length limits for task result/error messages
   */
  LIMITS: {
    /**
     * Maximum characters in task result field
     * Longer results will be truncated
     */
    RESULT_MAX_LENGTH: 500,

    /**
     * Maximum characters in task error field
     * Longer errors will be truncated
     */
    ERROR_MAX_LENGTH: 1000,
  },
} as const;

// ============================================================================
// QUEUE CONFIGURATION
// ============================================================================

/**
 * AI Queue service configuration
 */
export const QUEUE_CONFIG = {
  /**
   * Interval (in milliseconds) to check queue for new tasks
   * Lower = more responsive, higher = less CPU usage
   */
  CHECK_INTERVAL_MS: 100,

  /**
   * Maximum number of retry attempts for failed requests
   */
  MAX_RETRIES: 3,

  /**
   * Exponential backoff delays for retries (in milliseconds)
   * [1s, 2s, 5s]
   */
  RETRY_DELAYS: [1000, 2000, 5000],
} as const;

// ============================================================================
// UI CONFIGURATION
// ============================================================================

/**
 * User interface timing configuration
 */
export const UI_CONFIG = {
  /**
   * Delay (in milliseconds) before auto-refreshing UI after action
   * Gives time for server to process and update state
   */
  AUTO_REFRESH_DELAY_MS: 1500,

  /**
   * Debounce delay for input fields (in milliseconds)
   */
  DEBOUNCE_DELAY_MS: 300,

  /**
   * Polling interval for task status updates (in milliseconds)
   */
  TASK_POLL_INTERVAL_MS: 2000,
} as const;

// ============================================================================
// AI PROVIDER RATE LIMITS
// ============================================================================

/**
 * Default rate limits for AI providers
 * These are fallback values - actual limits can be configured per shop
 */
export const RATE_LIMITS = {
  /**
   * HuggingFace rate limits (Free tier)
   */
  HUGGINGFACE: {
    requests: 100,
    window: 60000, // 1 minute
    maxTokensPerMinute: 1000000,
    maxRequestsPerMinute: 100,
  },

  /**
   * Google Gemini rate limits (Free tier)
   */
  GEMINI: {
    requests: 60,
    window: 60000, // 1 minute
    maxTokensPerMinute: 1000000,
    maxRequestsPerMinute: 15,
  },

  /**
   * Anthropic Claude rate limits
   */
  CLAUDE: {
    requests: 50,
    window: 60000, // 1 minute
    maxTokensPerMinute: 40000,
    maxRequestsPerMinute: 5,
  },

  /**
   * OpenAI rate limits
   */
  OPENAI: {
    requests: 60,
    window: 60000, // 1 minute
    maxTokensPerMinute: 200000,
    maxRequestsPerMinute: 500,
  },

  /**
   * X.AI Grok rate limits
   */
  GROK: {
    requests: 50,
    window: 60000, // 1 minute
    maxTokensPerMinute: 100000,
    maxRequestsPerMinute: 60,
  },

  /**
   * DeepSeek rate limits
   */
  DEEPSEEK: {
    requests: 50,
    window: 60000, // 1 minute
    maxTokensPerMinute: 100000,
    maxRequestsPerMinute: 60,
  },
} as const;

// ============================================================================
// AI GENERATION SETTINGS
// ============================================================================

/**
 * AI content generation configuration
 */
export const AI_CONFIG = {
  /**
   * Default token estimation (chars / tokens ratio)
   */
  CHARS_PER_TOKEN: 4,

  /**
   * Maximum output tokens for generation
   */
  MAX_OUTPUT_TOKENS: 2000,

  /**
   * Maximum input length for different field types (in characters)
   */
  MAX_INPUT_LENGTH: {
    title: 200,
    description: 5000,
    seoTitle: 60,
    metaDescription: 160,
    imageAlt: 125,
  },

  /**
   * Timeout for AI requests (in milliseconds)
   */
  REQUEST_TIMEOUT_MS: 30000, // 30 seconds
} as const;

// ============================================================================
// DATABASE CLEANUP
// ============================================================================

/**
 * Database maintenance configuration
 */
export const DB_CONFIG = {
  /**
   * Days to keep completed tasks before deletion
   */
  COMPLETED_TASK_RETENTION_DAYS: 3,

  /**
   * Days to keep failed tasks before deletion
   */
  FAILED_TASK_RETENTION_DAYS: 7,

  /**
   * Batch size for bulk operations
   */
  BATCH_SIZE: 100,
} as const;

// ============================================================================
// ENCRYPTION SETTINGS
// ============================================================================

/**
 * Encryption configuration
 */
export const ENCRYPTION_CONFIG = {
  /**
   * AES-256-GCM algorithm
   */
  ALGORITHM: 'aes-256-gcm' as const,

  /**
   * Initialization Vector length (bytes)
   */
  IV_LENGTH: 12,

  /**
   * Authentication Tag length (bytes)
   */
  AUTH_TAG_LENGTH: 16,

  /**
   * Encryption key length (bytes)
   */
  KEY_LENGTH: 32,
} as const;

// ============================================================================
// WEBHOOK SETTINGS
// ============================================================================

/**
 * Webhook configuration
 */
export const WEBHOOK_CONFIG = {
  /**
   * Maximum retry attempts for failed webhooks
   */
  MAX_RETRY_ATTEMPTS: 5,

  /**
   * Initial retry delay (in milliseconds)
   */
  INITIAL_RETRY_DELAY_MS: 1000,

  /**
   * Maximum retry delay (in milliseconds)
   */
  MAX_RETRY_DELAY_MS: 60000, // 1 minute

  /**
   * Exponential backoff multiplier
   */
  BACKOFF_MULTIPLIER: 2,

  /**
   * Exponential backoff delays for webhook retries (in milliseconds)
   * [1s, 2s, 4s, 8s, 16s, 60s max]
   */
  RETRY_DELAYS: [1000, 2000, 4000, 8000, 16000, 60000],
} as const;

// ============================================================================
// PAGINATION SETTINGS
// ============================================================================

/**
 * Pagination configuration
 */
export const PAGINATION_CONFIG = {
  /**
   * Default page size for product lists
   */
  DEFAULT_PAGE_SIZE: 50,

  /**
   * Maximum items per page
   */
  MAX_PAGE_SIZE: 250,

  /**
   * Shopify API maximum per request
   */
  SHOPIFY_MAX_PER_REQUEST: 250,
} as const;

// ============================================================================
// LOGGING SETTINGS
// ============================================================================

/**
 * Logging configuration
 */
export const LOGGING_CONFIG = {
  /**
   * Log level based on environment
   */
  LEVEL: {
    DEVELOPMENT: 'debug' as const,
    PRODUCTION: 'info' as const,
    TEST: 'warn' as const,
  },

  /**
   * Maximum log file size (in bytes)
   * 10MB
   */
  MAX_FILE_SIZE: 10 * 1024 * 1024,

  /**
   * Maximum number of log files to keep
   */
  MAX_FILES: 5,
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate task expiration date from now
 * @returns Date object representing when task expires
 */
export function getTaskExpirationDate(): Date {
  return new Date(Date.now() + TASK_CONFIG.EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Get retry delay based on attempt number (exponential backoff)
 * @param attempt - Current retry attempt (0-indexed)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attempt: number): number {
  if (attempt < QUEUE_CONFIG.RETRY_DELAYS.length) {
    return QUEUE_CONFIG.RETRY_DELAYS[attempt];
  }
  // Use last delay for attempts beyond configured delays
  return QUEUE_CONFIG.RETRY_DELAYS[QUEUE_CONFIG.RETRY_DELAYS.length - 1];
}

/**
 * Calculate webhook retry delay with exponential backoff
 * @param attempt - Current retry attempt (0-indexed)
 * @returns Delay in milliseconds
 */
export function getWebhookRetryDelay(attempt: number): number {
  const delay = WEBHOOK_CONFIG.INITIAL_RETRY_DELAY_MS * Math.pow(WEBHOOK_CONFIG.BACKOFF_MULTIPLIER, attempt);
  return Math.min(delay, WEBHOOK_CONFIG.MAX_RETRY_DELAY_MS);
}

/**
 * Check if a task has expired
 * @param createdAt - Task creation date
 * @returns true if task has expired
 */
export function isTaskExpired(createdAt: Date): boolean {
  const expirationTime = TASK_CONFIG.EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - createdAt.getTime() > expirationTime;
}

/**
 * Truncate text to maximum length
 * @param text - Text to truncate
 * @param maxLength - Maximum length
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Truncate task result
 * @param result - Task result to truncate
 * @returns Truncated result
 */
export function truncateTaskResult(result: string): string {
  return truncateText(result, TASK_CONFIG.LIMITS.RESULT_MAX_LENGTH);
}

/**
 * Truncate task error
 * @param error - Error message to truncate
 * @returns Truncated error
 */
export function truncateTaskError(error: string): string {
  return truncateText(error, TASK_CONFIG.LIMITS.ERROR_MAX_LENGTH);
}

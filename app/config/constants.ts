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
     * Maximum characters in task result field.
     * The queue's crash-recovery path (`completeRecoveredTask` in
     * ai-queue.service.ts) truncates the blob it writes back to this length.
     * It is the only reader left — `truncateTaskResult()` was the other one
     * and had no callers at all — and it spelled the number out inline until
     * this constant got pointed at it, so the value keeps a name.
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
// BATCH TRANSLATION
// ============================================================================

/**
 * Tuning for the batched/chunked translation path
 * (AIService.translateFieldsToLocalesChunked).
 *
 * The goal is to collapse N fields × M locales into a SINGLE AI call whenever
 * the estimated output stays small enough, and to split into the fewest
 * possible additional calls otherwise.
 */
export const TRANSLATION_BATCH = {
  /**
   * Estimated output-size ceiling (in characters) for a single AI call.
   *
   * Why 40 000: the providers are run with `max_tokens: 8192`. At roughly
   * 4 characters per output token that is ~32 000 characters of model output;
   * 40 000 is the rounded practical ceiling we allow per call before splitting
   * (the OUTPUT_EXPANSION_FACTOR below already adds head-room on the estimate,
   * and most real payloads are short fields that never reach this threshold).
   * Tune here — no code search required.
   */
  CHUNK_THRESHOLD_CHARS: 40_000,

  /**
   * Multiplier applied to the source character count to estimate translated
   * output size. Translations are typically longer than the source; 1.3 is a
   * conservative average expansion across the supported languages.
   */
  OUTPUT_EXPANSION_FACTOR: 1.3,

  /**
   * Maximum number of chunk calls issued in parallel. Bounded to avoid
   * tripping provider rate limits while still overlapping latency.
   */
  MAX_CONCURRENCY: 3,

  /**
   * A translated cell equal to its source is normally fine — many short words
   * and proper nouns are spelled identically across languages (e.g.
   * "Schadenfreude", "Hotel", "Information", brand names), so such values are
   * kept and used. Only a value at least this long that comes back
   * byte-identical is treated as a failed translation (a full paragraph never
   * legitimately equals its source) and dropped rather than persisted as
   * source-as-translation (N-H3).
   */
  ECHO_FAILURE_MIN_CHARS: 200,
} as const;

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * TEMPLATE PRIMARY LOCALE EDITING
 *
 * Controls whether users can edit theme template content in the shop's primary locale.
 * Shopify's `translationsRegister` API only works for foreign/secondary locales.
 * Updating primary locale theme content requires `themeFilesUpsert`, which needs
 * a "Protected Scope Exemption" from Shopify.
 *
 * When `false` (default):
 *   - Template fields are read-only in the primary locale
 *   - AI buttons (Improve, Generate, Format, Translate) are hidden
 *   - Save/Discard buttons are hidden for primary locale templates
 *   - Server rejects primary locale template save requests
 *
 * When `true`:
 *   - Full editing is enabled for primary locale templates
 *   - Server uses `themeFilesUpsert` to push changes to Shopify
 *
 * HOW TO ENABLE:
 *   1. Submit "Protected Scope Exemption" request via Shopify Partner Dashboard
 *   2. Add `write_themes` to scopes in shopify.app.toml
 *   3. Set this flag to `true`
 *   4. Reinstall the app to acquire the new scope
 *
 * Related code:
 *   - GraphQL mutation: UPSERT_THEME_FILES in app/graphql/content.mutations.ts
 *   - UI gating: UnifiedContentEditor.tsx, AIEditableField.tsx
 *   - Server gating: app.templates.tsx, api.templates.$.tsx
 */
export const ENABLE_THEME_PRIMARY_EDIT = true;

// ============================================================================
// AI USER INSTRUCTIONS (per-request, ad-hoc)
// ============================================================================

/**
 * Maximum length of the ad-hoc instruction a merchant can type into the
 * "Improve/Generate with AI" prompt box before the request is sent.
 *
 * Enforced on BOTH sides: the input's `maxLength` (AIInstructionPrompt) and the
 * server-side read in `ai-user-instruction.server.ts` — the AI endpoints are
 * directly POST-reachable, so the client cap is cosmetic on its own.
 */
export const AI_USER_INSTRUCTION_MAX_LENGTH = 1000;

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
 * Get date range for filtering tasks
 * @param hours Number of hours to look back (1, 6, 12, 24 - max 24 = 1 day)
 */
export function getTaskDateRange(hours: number = 24): Date {
  const maxHours = Math.min(hours, 24); // Enforce max 24 hours (1 day)
  const dateFrom = new Date();
  dateFrom.setHours(dateFrom.getHours() - maxHours);
  return dateFrom;
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
 * Truncate task error
 * @param error - Error message to truncate
 * @returns Truncated error
 */
export function truncateTaskError(error: string): string {
  return truncateText(error, TASK_CONFIG.LIMITS.ERROR_MAX_LENGTH);
}

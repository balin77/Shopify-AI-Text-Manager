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
/**
 * The three numbers the batching budget is built from, declared before the
 * object so `CHUNK_THRESHOLD_CHARS` can be DERIVED from them in one expression
 * instead of restated. See `TRANSLATION_BATCH` below for what each one means.
 */
const AI_MAX_OUTPUT_TOKENS = 8192;
const CHARS_PER_OUTPUT_TOKEN = 3;
const JSON_STRUCTURE_RESERVE = 0.15;

export const TRANSLATION_BATCH = {
  /**
   * The `max_tokens` every provider call is made with — the OUTPUT ceiling, and
   * the number every batching decision in this app is derived from
   * ([translation-budget.shared.ts](../services/ai/translation-budget.shared.ts)).
   *
   * It is small, and it is not a conservative guess that could be raised: the
   * merchant picks the model out of six providers' lists
   * ([ai-models.config.ts](./ai-models.config.ts)) and the app sends ONE
   * `max_tokens` to all of them, so this has to hold for the weakest selectable
   * one — `gpt-4-turbo` caps output at 4096, `deepseek-chat` and the Gemini
   * Flash models at 8192, and a HuggingFace endpoint can be lower still.
   * Raising it is a per-provider, per-model capability lookup, not an edit here.
   *
   * Every provider branch in `ai.service.ts` reads it (and so does the queue's
   * token estimate), so the number the requests really carry and the number the
   * budget is derived from cannot drift — which is the whole point: the threshold
   * this replaces was a hand-rounded value against this same cap, and it
   * promised a third more output than the model could emit.
   */
  AI_MAX_OUTPUT_TOKENS,

  /**
   * Characters of model output per output token, for the languages this app
   * translates into — deliberately PESSIMISTIC. English is roughly 4; German,
   * Spanish, French and Italian are closer to 3 because their longer words split
   * into more sub-word tokens, and HTML markup (`<strong>`, `&nbsp;`,
   * `href="..."`) tokenizes worse than prose. Estimating with 4 over-promises by
   * a third on exactly the shops that reach the limit.
   */
  CHARS_PER_OUTPUT_TOKEN,

  /**
   * Share of the output budget reserved for everything that is not translated
   * text: the JSON skeleton, the locale and field keys, and the escaping the
   * prompts ask for (a `\"` inside an HTML attribute is two characters where the
   * source had one, and a body full of `href="..."` pays it per attribute).
   */
  JSON_STRUCTURE_RESERVE,

  /**
   * Estimated output-size ceiling (in characters) for a single AI call.
   *
   * DERIVED from `AI_MAX_OUTPUT_TOKENS` rather than written down, because the
   * two drifting apart is a truncated response: this used to be a hand-rounded
   * 40 000 against the same 8 192-token cap, i.e. ~13 000 output tokens' worth
   * of text asked of a model that can emit 8 192 — the estimate said "fits" for
   * payloads that could not. The conversion rate and the structural reserve live
   * in the budget module; see its header for why the rate is 3 and not 4.
   *
   * Kept as a named constant because it is what the chunker compares against,
   * and because a test can then pin the relationship instead of the number.
   */
  CHUNK_THRESHOLD_CHARS: Math.floor(
    AI_MAX_OUTPUT_TOKENS * CHARS_PER_OUTPUT_TOKEN * (1 - JSON_STRUCTURE_RESERVE),
  ),

  /**
   * Multiplier applied to the source character count to estimate translated
   * output size. Translations are typically longer than the source; 1.3 is a
   * conservative average expansion across the supported languages.
   */
  OUTPUT_EXPANSION_FACTOR: 1.3,

  /**
   * How many bare VALUES go into one prompt, whatever the character budget says.
   *
   * The values are NUMBERED into a single request and the answer is mapped back
   * by index, so the list itself is the fragile part: past a few dozen entries a
   * model starts merging, renumbering or dropping items, and the strict length
   * assertion then rejects the whole chunk. A budget in characters cannot see
   * that — sixty short metafield values are a rounding error in characters and
   * exactly the payload that comes back miscounted.
   *
   * It lives here because BOTH value paths must honour it: the per-locale one in
   * the stale-translation repair (which had it as a local `VALUE_BATCH`) and the
   * batched `translateBatchValuesToLocales`, which bypassed it and asked one
   * request for 760 numbered strings on an eight-language shop.
   */
  VALUE_BATCH_MAX_ITEMS: 40,

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

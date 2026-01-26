/**
 * Debug Logging Utility for Content Editor
 *
 * Provides conditional logging that only outputs in development mode.
 * All logs are stripped in production builds.
 */

const DEBUG_ENABLED = process.env.NODE_ENV === 'development';

type LogArgs = unknown[];

const createLogger = (prefix: string) => (message: string, ...args: LogArgs) => {
  if (DEBUG_ENABLED) {
    console.log(`[${prefix}] ${message}`, ...args);
  }
};

export const debugLog = {
  /** Data loading operations */
  dataLoad: createLogger('DATA-LOAD'),

  /** Save operations */
  save: createLogger('SAVE'),

  /** Auto-save operations */
  autoSave: createLogger('AUTO-SAVE'),

  /** Alt-text operations */
  altText: createLogger('ALT-TEXT'),

  /** Translation operations */
  translate: createLogger('TRANSLATE'),
  translateAll: createLogger('TRANSLATE-ALL'),
  translateAllForLocale: createLogger('TRANSLATE-ALL-FOR-LOCALE'),

  /** Retry mechanism */
  retry: createLogger('RETRY'),

  /** Form submission */
  submit: createLogger('SAFE-SUBMIT'),

  /** Changed fields detection */
  fields: createLogger('getChangedFields'),

  /** Save response handling */
  response: createLogger('SAVE-RESPONSE'),

  /** Revalidation */
  revalidate: createLogger('REVALIDATE'),

  /** Accept and translate flow */
  acceptAndTranslate: createLogger('ACCEPT-AND-TRANSLATE'),

  /** Translation clearing */
  translationClear: createLogger('TRANSLATION-CLEAR'),
};

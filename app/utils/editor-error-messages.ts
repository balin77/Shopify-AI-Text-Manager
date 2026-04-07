/**
 * Editor Error Message Utilities
 *
 * Pure utility functions for translating server error messages to localized strings.
 * Extracted from useUnifiedContentEditor.ts for reusability.
 */

import type { TranslationStrings } from "../types/content-editor.types";

/**
 * Translates server error messages to localized strings.
 * Maps technical error messages from server to i18n translation keys.
 */
export function translateErrorMessage(errorMessage: string, t: TranslationStrings): string {
  const errors = t.errors as Record<string, string> | undefined;
  if (!errorMessage) return errors?.unknownError || "Unknown error";

  const lowerError = errorMessage.toLowerCase();

  // Map common error patterns to translation keys
  if (lowerError.includes("graphql error")) {
    return errors?.graphqlError || errorMessage;
  }
  if (lowerError.includes("invalid field type")) {
    return errors?.invalidFieldType || errorMessage;
  }
  if (lowerError.includes("no fields to translate")) {
    return errors?.noFieldsToTranslate || errorMessage;
  }
  if (lowerError.includes("no source text") && !lowerError.includes("alt")) {
    return errors?.noSourceText || errorMessage;
  }
  if (lowerError.includes("no source alt-text") || lowerError.includes("no source alt text")) {
    return errors?.noSourceAltText || errorMessage;
  }
  if (lowerError.includes("no target locale") && lowerError.includes("image")) {
    return errors?.noTargetLocalesOrImages || errorMessage;
  }
  if (lowerError.includes("no target locale")) {
    return errors?.noTargetLocales || errorMessage;
  }
  if (lowerError.includes("no images data") || lowerError.includes("no image data")) {
    return errors?.noImagesData || errorMessage;
  }
  if (lowerError.includes("no images to process")) {
    return errors?.noImagesToProcess || errorMessage;
  }
  if (lowerError.includes("no alt-text data") || lowerError.includes("no alt text data")) {
    return errors?.noAltTextData || errorMessage;
  }
  if (lowerError.includes("unknown action")) {
    return errors?.unknownAction || errorMessage;
  }
  if (lowerError.includes("invalid url slug") || lowerError.includes("invalid handle") || lowerError.includes("alphanumeric character")) {
    return errors?.invalidUrlSlug || errorMessage;
  }
  if (lowerError.includes("network") || lowerError.includes("fetch")) {
    return errors?.networkError || errorMessage;
  }
  if (lowerError.includes("quota") || lowerError.includes("limit exceeded")) {
    return errors?.quotaExceeded || errorMessage;
  }
  if (lowerError.includes("rate limit") || lowerError.includes("too many requests")) {
    return errors?.rateLimitExceeded || errorMessage;
  }
  if (lowerError.includes("translation") && lowerError.includes("failed")) {
    return errors?.translationFailed || errorMessage;
  }
  if (lowerError.includes("generation") && lowerError.includes("failed")) {
    return errors?.generationFailed || errorMessage;
  }
  if (lowerError.includes("save") && lowerError.includes("failed")) {
    return errors?.saveFailed || errorMessage;
  }
  if (lowerError.includes("load") && lowerError.includes("failed")) {
    return errors?.loadFailed || errorMessage;
  }

  // If no specific translation found, return the original error message
  // (it might be a descriptive message that's already helpful)
  return errorMessage;
}

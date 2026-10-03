/**
 * Editor Error Message Utilities
 *
 * Pure utility functions for translating server error messages to localized strings.
 * Extracted from useUnifiedContentEditor.ts for reusability.
 */

import type { TranslationStrings } from "../types/content-editor.types";
import { taskErrorText } from "./task-error-text";

/**
 * Translates server error messages to localized strings.
 * Maps technical error messages from server to i18n translation keys.
 */
export function translateErrorMessage(errorMessage: string, t: TranslationStrings): string {
  const errors = t.errors as Record<string, string> | undefined;
  if (!errorMessage) return errors?.unknownError || "Unknown error";

  // A managed-AI refusal travels as its machine code
  // (`managed_ai_refused:<reason>` — ManagedAiRefusedError's message), so a
  // toast renders the same localized sentence the Tasks tab does. Delegated
  // rather than restated: one refusal, one sentence, wherever it surfaces.
  // Matched ANYWHERE in the text: a handler that prefixes its own context
  // ("Translation failed: …") must not push the code back to raw English.
  const refusal = /managed_ai_refused:([A-Za-z]+)/.exec(errorMessage);
  if (refusal) {
    return taskErrorText(refusal[0], t) ?? errorMessage;
  }

  // The embedded session token could not be (re)established -- app-fetch.ts's
  // SessionExpiredError, or the server's 401 for an /api fetch that arrived
  // without one (api-auth-bounce.server.ts). Never raw "Expected JSON" text.
  if (errorMessage === "sessionExpired") {
    return errors?.sessionExpired || "Your session has expired. Please reload the page.";
  }
  // Shopify asked for the app's access to be confirmed again (a 401 carrying
  // X-Shopify-API-Request-Failure-Reauthorize-Url) -- app-fetch.ts's
  // ReauthorizeRequiredError. Not an expired session: reloading alone does
  // not end it, the merchant has to approve the request.
  if (errorMessage === "reauthorizeRequired") {
    return errors?.reauthorizeRequired || "Shopify asks you to confirm the app's access again. Please reload the page and approve the request.";
  }

  // The image an alt-text action named no longer exists on the product.
  if (errorMessage === "Image not found on this product") {
    const im = (t as unknown as { imageManager?: Record<string, string> }).imageManager;
    return im?.altImageNotFound || errorMessage;
  }

  // A plan refusal travels as the code "gated" (planGateRefusal, 403).
  if (errorMessage === "gated") {
    const content = t.content as Record<string, string> | undefined;
    return content?.upgradeRequired || "Upgrade required";
  }

  // An AI path refused a theme image/video value (themeMediaRefusalBody).
  if (errorMessage === "themeMediaValue") {
    const li = (t as unknown as { localizedImages?: { errors?: Record<string, string> } }).localizedImages;
    return li?.errors?.themeMediaValue || errorMessage;
  }

  // Every locale was translated but Shopify confirmed none of the writes.
  if (errorMessage === "translateStoreFailedAll") {
    return errors?.translateStoreFailedAll || "Shopify did not store the translation for any language";
  }

  const lowerError = errorMessage.toLowerCase();

  // Map common error patterns to translation keys
  // Shopify blocks editing a policy while "automatic management" is on
  // (e.g. "Automatic management for Privacy Policy must be turned off in order to make changes.")
  if (lowerError.includes("automatic management") && lowerError.includes("turned off")) {
    return errors?.policyAutomaticManagement || errorMessage;
  }
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

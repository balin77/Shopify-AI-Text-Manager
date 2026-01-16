/**
 * Translation Helpers
 *
 * Shared utilities for handling Shopify translation operations
 * including translatableContent fetching, digest management,
 * and database synchronization.
 */

import { logger } from "~/utils/logger.server";
import type { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";

interface TranslatableContentDigest {
  key: string;
  digest: string;
}

interface TranslationInput {
  key: string;
  value: string;
  locale: string;
  translatableContentDigest?: string;
}

interface TranslationResult {
  success: boolean;
  errors: string[];
  savedTranslations: number;
}

/**
 * Fetches translatable content from Shopify and creates digest map
 */
export async function fetchTranslatableContent(
  gateway: ShopifyApiGateway,
  resourceId: string
): Promise<{
  digestMap: Record<string, string>;
  content: TranslatableContentDigest[];
}> {
  logger.debug("Fetching translatable content", {
    context: "TranslationHelper",
    resourceId,
  });

  const QUERY_TRANSLATABLE_CONTENT = `
    query translatableContent($resourceId: ID!) {
      translatableResource(resourceId: $resourceId) {
        resourceId
        translatableContent {
          key
          digest
          value
        }
      }
    }
  `;

  const response = await gateway.graphql(QUERY_TRANSLATABLE_CONTENT, {
    variables: { resourceId },
  });

  const content = response?.translatableResource?.translatableContent || [];

  // Create digest map for quick lookup
  const digestMap: Record<string, string> = {};
  content.forEach((item: TranslatableContentDigest) => {
    digestMap[item.key] = item.digest;
  });

  logger.debug("Translatable content fetched", {
    context: "TranslationHelper",
    resourceId,
    contentCount: content.length,
  });

  return { digestMap, content };
}

/**
 * Saves translation to Shopify via translationsRegister mutation
 */
export async function saveTranslationToShopify(
  gateway: ShopifyApiGateway,
  resourceId: string,
  translations: TranslationInput[]
): Promise<TranslationResult> {
  logger.debug("Saving translations to Shopify", {
    context: "TranslationHelper",
    resourceId,
    translationCount: translations.length,
  });

  const TRANSLATE_MUTATION = `
    mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
      translationsRegister(resourceId: $resourceId, translations: $translations) {
        userErrors {
          message
          field
        }
        translations {
          key
          locale
        }
      }
    }
  `;

  try {
    const response = await gateway.graphql(TRANSLATE_MUTATION, {
      variables: {
        resourceId,
        translations,
      },
    });

    const userErrors = response?.translationsRegister?.userErrors || [];
    const savedTranslations = response?.translationsRegister?.translations || [];

    if (userErrors.length > 0) {
      const errorMessages = userErrors.map((e: any) => e.message);
      logger.warn("Translation save had errors", {
        context: "TranslationHelper",
        resourceId,
        errors: errorMessages,
      });

      return {
        success: false,
        errors: errorMessages,
        savedTranslations: savedTranslations.length,
      };
    }

    logger.info("Translations saved successfully", {
      context: "TranslationHelper",
      resourceId,
      savedCount: savedTranslations.length,
    });

    return {
      success: true,
      errors: [],
      savedTranslations: savedTranslations.length,
    };
  } catch (error: any) {
    logger.error("Failed to save translations", {
      context: "TranslationHelper",
      resourceId,
      error: error.message,
    });

    return {
      success: false,
      errors: [error.message],
      savedTranslations: 0,
    };
  }
}

/**
 * Synchronizes translations to local database
 */
export async function syncTranslationsToDB(
  shop: string,
  productId: string,
  locale: string,
  translations: Array<{ key: string; value: string }>
): Promise<void> {
  const { db } = await import("~/db.server");

  logger.debug("Syncing translations to database", {
    context: "TranslationHelper",
    productId,
    locale,
    translationCount: translations.length,
  });

  try {
    // Delete existing translations for this locale
    await db.contentTranslation.deleteMany({
      where: {
        resourceId: productId,
        resourceType: "Product",
        locale,
      },
    });

    // Create new translations
    const translationData = translations.map((t) => ({
      resourceId: productId,
      resourceType: "Product",
      locale,
      key: t.key,
      value: t.value,
    }));

    await db.contentTranslation.createMany({
      data: translationData,
    });

    logger.info("Translations synced to database", {
      context: "TranslationHelper",
      productId,
      locale,
      translationCount: translations.length,
    });
  } catch (error: any) {
    logger.error("Failed to sync translations to database", {
      context: "TranslationHelper",
      productId,
      locale,
      error: error.message,
    });
    // Don't throw - DB sync failure shouldn't block Shopify success
  }
}

/**
 * Maps field types to Shopify translatable content keys
 */
export function getTranslationKey(fieldType: string): string {
  const keyMap: Record<string, string> = {
    title: "title",
    description: "body_html",
    handle: "handle",
    seoTitle: "meta_title",
    metaDescription: "meta_description",
  };

  return keyMap[fieldType] || fieldType;
}

/**
 * Builds translation input for Shopify API
 */
export function buildTranslationInput(
  key: string,
  value: string,
  locale: string,
  digest?: string
): TranslationInput {
  const input: TranslationInput = {
    key,
    value,
    locale,
  };

  if (digest) {
    input.translatableContentDigest = digest;
  }

  return input;
}

/**
 * Validates translation data before saving
 */
export function validateTranslation(
  key: string,
  value: string,
  locale: string
): { valid: boolean; error?: string } {
  if (!key || typeof key !== "string") {
    return { valid: false, error: "Invalid key" };
  }

  if (!value || typeof value !== "string") {
    return { valid: false, error: "Invalid value" };
  }

  if (!locale || typeof locale !== "string" || locale.length !== 2) {
    return { valid: false, error: "Invalid locale format (expected 2-letter code)" };
  }

  // Check max lengths
  const maxLengths: Record<string, number> = {
    title: 200,
    handle: 100,
    meta_title: 70,
    meta_description: 160,
  };

  const maxLength = maxLengths[key];
  if (maxLength && value.length > maxLength) {
    return {
      valid: false,
      error: `Value exceeds maximum length of ${maxLength} characters`,
    };
  }

  return { valid: true };
}

/**
 * Batch translations into chunks for API limits
 * Shopify accepts up to 25 translations per request
 */
export function chunkTranslations<T>(
  translations: T[],
  chunkSize: number = 25
): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < translations.length; i += chunkSize) {
    chunks.push(translations.slice(i, i + chunkSize));
  }

  return chunks;
}

/**
 * Unified Content Actions
 *
 * Generic action handlers for all content types
 * Based on the products implementation with all bug fixes
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { AIService, type AIProvider } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import { sanitizeSlug } from "../utils/slug.utils";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import type { ContentEditorConfig } from "../types/content-editor.types";
import { logger } from "../utils/logger.server";
import { getFormString, getFormInt, getFormJSON } from "../utils/form-data.utils";
import { isValidShopifyGID, safeJsonParse } from "../utils/validation";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import type { PrismaClient } from "@prisma/client";
import type { AISettings, AIInstructions } from "@prisma/client";

interface UnifiedContentActionsConfig {
  admin: AdminApiContext;
  session: Session;
  formData: FormData;
  contentConfig: ContentEditorConfig;
  db: PrismaClient;
  aiSettings: AISettings | null;
  aiInstructions: AIInstructions | null;
}

export async function handleUnifiedContentActions(config: UnifiedContentActionsConfig) {
  const { admin, session, formData, contentConfig, db, aiSettings, aiInstructions } = config;

  const action = getFormString(formData, "action");
  const itemId = getFormString(formData, "itemId") || getFormString(formData, "productId");

  // Validate resource GID before using it in any query
  if (itemId && !isValidShopifyGID(itemId)) {
    return json({ success: false, error: "Invalid resource ID format" }, { status: 400 });
  }

  // Initialize services
  const provider = (aiSettings?.preferredProvider || process.env.AI_PROVIDER || "huggingface") as AIProvider;
  // Cast aiInstructions to indexable type for dynamic field access
  const instructions = aiInstructions as Record<string, string | null> | null;
  const serviceConfig = {
    huggingfaceApiKey: decryptApiKey(aiSettings?.huggingfaceApiKey) || undefined,
    geminiApiKey: decryptApiKey(aiSettings?.geminiApiKey) || undefined,
    claudeApiKey: decryptApiKey(aiSettings?.claudeApiKey) || undefined,
    openaiApiKey: decryptApiKey(aiSettings?.openaiApiKey) || undefined,
    grokApiKey: decryptApiKey(aiSettings?.grokApiKey) || undefined,
    deepseekApiKey: decryptApiKey(aiSettings?.deepseekApiKey) || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };

  // Update queue rate limits from settings
  const { AIQueueService } = await import("../../src/services/ai-queue.service");
  const queue = AIQueueService.getInstance();
  await queue.updateRateLimits(aiSettings);

  const aiService = new AIService(provider, serviceConfig);
  const translationService = new TranslationService(provider, serviceConfig);
  const shopifyContentService = new ShopifyContentService(admin);

  // ============================================================================
  // LOAD TRANSLATIONS
  // ============================================================================

  if (action === "loadTranslations") {
    const locale = getFormString(formData, "locale");

    try {
      const translations = await shopifyContentService.loadTranslations(itemId, locale);
      return json({ success: true, translations, locale });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE AI TEXT
  // ============================================================================

  if (action === "generateAIText") {
    const fieldType = getFormString(formData, "fieldType");
    const currentValue = getFormString(formData, "currentValue");
    const contextTitle = getFormString(formData, "contextTitle");
    const contextDescription = getFormString(formData, "contextDescription");
    const mainLanguage = getFormString(formData, "mainLanguage");

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "aiGeneration",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: contextTitle,
        fieldType,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const field = contentConfig.fieldDefinitions.find((f) => f.key === fieldType);
      if (!field) {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: "Invalid field type",
          },
        });
        return json({ success: false, error: "Invalid field type" }, { status: 400 });
      }

      // Create AI service with shop and taskId for queue management
      const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

      let generatedContent = "";

      // Update task to queued (queue will update to running)
      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      // Get AI instructions for this field
      const instructionsKey = field.aiInstructionsKey;
      const formatKey = `${instructionsKey}Format`;
      const instructionsTextKey = `${instructionsKey}Instructions`;

      if (field.type === "text" || field.type === "slug") {
        let prompt = `Create an optimized ${field.label}.`;

        if (instructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${instructions[formatKey]}`;
        }
        if (instructions?.[instructionsTextKey]) {
          prompt += `\n\nInstructions:\n${instructions[instructionsTextKey]}`;
        }

        if (field.type === "slug") {
          prompt += `\n\nIMPORTANT - The URL slug MUST follow this format:`;
          prompt += `\n- ONLY lowercase letters (a-z)`;
          prompt += `\n- ONLY digits (0-9)`;
          prompt += `\n- ONLY hyphens (-) as separators`;
          prompt += `\n- NO spaces, NO underscores, NO special characters`;
          prompt += `\n- Umlauts MUST be converted (ä→ae, ö→oe, ü→ue, ß→ss)`;
          prompt += `\n- 2-5 words, separated by hyphens`;
          prompt += `\n\nExamples:`;
          prompt += `\n- "Über Uns" → "ueber-uns"`;
          prompt += `\n- "Kontakt & Impressum" → "kontakt-impressum"`;
        }

        prompt += `\n\nContext:\n${contextDescription || currentValue}\n\nReturn ONLY the ${field.label}, without explanations. Output the result in ${mainLanguage}.`;
        generatedContent = await aiServiceWithTask.generateProductTitle(prompt);

        if (field.type === "slug") {
          generatedContent = sanitizeSlug(generatedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        let prompt = `Create an optimized ${field.label} for: ${contextTitle}`;

        if (instructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${instructions[formatKey]}`;
        }
        if (instructions?.[instructionsTextKey]) {
          prompt += `\n\nInstructions:\n${instructions[instructionsTextKey]}`;
        }

        prompt += `\n\nContext:\n${contextDescription || currentValue}\n\nCurrent Content:\n${currentValue}\n\nReturn ONLY the ${field.label}, without explanations. Output the result in ${mainLanguage}.`;
        generatedContent = await aiServiceWithTask.generateProductDescription(contextTitle, prompt);
      }

      // Update task to completed
      let resultString = "";
      try {
        resultString = JSON.stringify({ generatedContent: generatedContent.substring(0, 500), fieldType });
      } catch (e) {
        resultString = JSON.stringify({ fieldType, success: true });
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: resultString,
        },
      });

      return json({ success: true, generatedContent, fieldType });
    } catch (error: unknown) {
      // Update task to failed
      const errorMessage = (error instanceof Error ? error.message : String(error)).substring(0, 1000);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
      });
      return json({ success: false, error: errorMessage }, { status: 500 });
    }
  }

  // ============================================================================
  // FORMAT AI TEXT
  // ============================================================================

  if (action === "formatAIText") {
    const fieldType = getFormString(formData, "fieldType");
    const currentValue = getFormString(formData, "currentValue");
    const contextTitle = getFormString(formData, "contextTitle");
    const contextDescription = getFormString(formData, "contextDescription");
    const mainLanguage = getFormString(formData, "mainLanguage");

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "aiFormatting",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: contextTitle,
        fieldType,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const field = contentConfig.fieldDefinitions.find((f) => f.key === fieldType);
      if (!field) {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: "Invalid field type",
          },
        });
        return json({ success: false, error: "Invalid field type" }, { status: 400 });
      }

      // Create AI service with shop and taskId for queue management
      const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

      let formattedContent = "";

      // Update task to queued (queue will update to running)
      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      // Get AI instructions for this field
      const instructionsKey = field.aiInstructionsKey;
      const formatKey = `${instructionsKey}Format`;
      const instructionsTextKey = `${instructionsKey}Instructions`;

      // Default formatting instruction
      const defaultPreserveInstruction = `CRITICAL: You must PRESERVE the original text content. DO NOT rewrite, rephrase, or generate new content.
Only apply formatting changes such as:
- Adding separators (| or - or :)
- Adjusting capitalization
- Adding HTML tags for structure (<strong>, <em>, <h2>, <h3>, <ul>, <li>, <p>)
- Fixing punctuation and spacing
- Removing redundant characters

The meaning, words, and information must stay the same. Only the presentation/formatting changes.`;

      // Use custom instructions if provided, otherwise use default
      const preserveTextInstruction = aiInstructions?.formatPreserveInstructions || defaultPreserveInstruction;

      if (field.type === "text" || field.type === "slug") {
        let prompt = "";

        if (field.type === "slug") {
          prompt = `Format the following URL slug. Keep the core words intact.

Original Slug:
${currentValue}

${preserveTextInstruction}

Allowed formatting changes for handles:
- Convert to lowercase
- Replace spaces with hyphens
- Convert umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
- Remove special characters
- Remove excessive hyphens`;
          if (instructions?.[formatKey]) {
            prompt += `\n\nFormat Style Example:\n${instructions![formatKey]}`;
          }
          prompt += `\n\nReturn ONLY the formatted URL slug. Keep the original keywords.`;
        } else {
          prompt = `Apply formatting to the following ${field.label}. Keep all words and meaning intact.

Original ${field.label} (preserve this content):
${currentValue}

${preserveTextInstruction}

Allowed formatting changes:
- Add separators like | or - or – between parts
- Adjust capitalization (e.g., Title Case)
- Remove excessive punctuation
- Fix spacing issues`;
          if (instructions?.[formatKey]) {
            prompt += `\n\nFormat Style Example (for structure reference only, do NOT copy the content):\n${instructions![formatKey]}`;
          }
          prompt += `\n\nReturn ONLY the formatted ${field.label}. Keep the original language. Do NOT add new information or rewrite the text. Output the result in ${mainLanguage}.`;
        }

        formattedContent = await aiServiceWithTask.generateProductTitle(prompt);

        if (field.type === "slug") {
          formattedContent = sanitizeSlug(formattedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        let prompt = `Apply HTML formatting to the following ${field.label}. Keep all words, sentences, and information intact.

Original ${field.label} (preserve this content):
${currentValue}

${preserveTextInstruction}

Allowed formatting changes:
- Add HTML structure tags: <h2>, <h3>, <p>, <ul>, <li>
- Add emphasis: <strong>, <em>
- Convert plain lists to <ul>/<li> format
- Add paragraph breaks with <p> tags
- Fix spacing and punctuation`;

        if (instructions?.[formatKey]) {
          prompt += `\n\nFormat Style Example (for HTML structure reference only):\n${instructions![formatKey]}`;
        }

        prompt += `\n\nReturn ONLY the formatted HTML ${field.label}. Keep the original language and all original content. Do NOT add new sentences or rewrite existing ones. Output the result in ${mainLanguage}.`;
        formattedContent = await aiServiceWithTask.generateProductDescription(currentValue, prompt);
      }

      // Update task to completed
      let resultString = "";
      try {
        resultString = JSON.stringify({ formattedContent: formattedContent.substring(0, 500), fieldType });
      } catch (e) {
        resultString = JSON.stringify({ fieldType, success: true });
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: resultString,
        },
      });

      return json({ success: true, generatedContent: formattedContent, fieldType });
    } catch (error: unknown) {
      // Update task to failed
      const errorMessage = (error instanceof Error ? error.message : String(error)).substring(0, 1000);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
      });
      return json({ success: false, error: errorMessage }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE FIELD
  // ============================================================================

  if (action === "translateField") {
    const fieldType = getFormString(formData, "fieldType");
    const sourceText = getFormString(formData, "sourceText");
    const targetLocale = getFormString(formData, "targetLocale");

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "translation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        fieldType,
        targetLocale,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      // Create translation service with shop and taskId for queue management
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      const changedFields: Record<string, string> = {};
      changedFields[fieldType] = sourceText;

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const translations = await translationServiceWithTask.translateProduct(
        changedFields,
        [targetLocale],
        contentConfig.contentType,
        aiInstructions?.translateInstructions || undefined
      );
      const translatedValue = translations[targetLocale]?.[fieldType] || "";

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
        },
      });

      return json({ success: true, translatedValue, fieldType, targetLocale });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALL (to ALL enabled locales)
  // ============================================================================

  if (action === "translateAll") {
    const targetLocalesStr = getFormString(formData, "targetLocales");
    const contextTitle = getFormString(formData, "title");
    const sourceLocale = getFormString(formData, "sourceLocale") || "en";

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "bulkTranslation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: contextTitle,
        fieldType: "all",
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const changedFields: Record<string, string> = {};

      // Collect all field values
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = getFormString(formData, field.key);
        if (value) {
          changedFields[field.key] = value;
        }
      });

      if (Object.keys(changedFields).length === 0) {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: "No fields to translate",
          },
        });
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      // Create translation service with shop and taskId for queue management
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const result = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
        customInstructions: aiInstructions?.translateInstructions || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales, rejectedFields } = result;

      await db.task.update({
        where: { id: task.id },
        data: {
          status: failedLocales.length > 0 ? "completed" : "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            success: true,
            locales: Object.keys(allTranslations),
            failedLocales,
            rejectedFields,
          }),
        },
      });

      return json({ success: true, translations: allTranslations, failedLocales, rejectedFields });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALL FOR LOCALE (to ONE specific locale)
  // ============================================================================

  if (action === "translateAllForLocale") {
    const targetLocale = getFormString(formData, "targetLocale");
    const contextTitle = getFormString(formData, "title");
    const sourceLocale = getFormString(formData, "sourceLocale") || "en";

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "bulkTranslation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: contextTitle,
        targetLocale,
        fieldType: "all",
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const changedFields: Record<string, string> = {};

      // Collect all field values
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = getFormString(formData, field.key);
        if (value) {
          changedFields[field.key] = value;
        }
      });

      if (Object.keys(changedFields).length === 0) {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: "No fields to translate",
          },
        });
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      // Create translation service with shop and taskId for queue management
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      // Translate to only ONE specific locale
      const result = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: [targetLocale],
        contentType: contentConfig.contentType,
        taskId: task.id,
        customInstructions: aiInstructions?.translateInstructions || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales, rejectedFields } = result;

      // Extract translations for the target locale
      const translations = allTranslations[targetLocale] || {};

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            success: true,
            targetLocale,
            translations,
            failedLocales,
            rejectedFields,
          }),
        },
      });

      return json({ success: true, translations, targetLocale, failedLocales, rejectedFields });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE FIELD TO ALL LOCALES
  // ============================================================================

  if (action === "translateFieldToAllLocales") {
    const fieldType = getFormString(formData, "fieldType");
    const sourceText = getFormString(formData, "sourceText");
    const targetLocalesStr = getFormString(formData, "targetLocales");
    const contextTitle = getFormString(formData, "contextTitle");
    const sourceLocale = getFormString(formData, "sourceLocale") || "en";

    logger.debug('[UnifiedContent] [translateFieldToAllLocales] Starting...');
    logger.debug('[UnifiedContent] fieldType:', fieldType);
    logger.debug('[UnifiedContent] targetLocales:', targetLocalesStr);

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "bulkTranslation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: contextTitle,
        fieldType,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const changedFields: Record<string, string> = {};
      changedFields[fieldType] = sourceText;

      if (!sourceText) {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: "No source text to translate",
          },
        });
        return json({ success: false, error: "No source text to translate" }, { status: 400 });
      }

      // Create translation service with shop and taskId for queue management
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const result = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
        customInstructions: aiInstructions?.translateInstructions || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales } = result;

      // Extract just the field value for each locale (frontend expects Record<locale, string>)
      // allTranslations is Record<locale, Record<fieldType, string>>
      // We need to flatten it to Record<locale, string>
      logger.debug('[UnifiedContent] [translateFieldToAllLocales] allTranslations from service:', Object.keys(allTranslations));
      logger.debug('[UnifiedContent] [translateFieldToAllLocales] allTranslations detail:', JSON.stringify(allTranslations, null, 2));

      const flattenedTranslations: Record<string, string> = {};
      for (const [locale, fields] of Object.entries(allTranslations)) {
        const value = (fields as Record<string, string>)[fieldType] || "";
        flattenedTranslations[locale] = value;
        logger.debug(`[UnifiedContent] [translateFieldToAllLocales] Extracted ${locale}.${fieldType} = "${value.substring(0, 50)}..."`);
      }

      logger.debug('[UnifiedContent] [translateFieldToAllLocales] RETURNING locales:', Object.keys(flattenedTranslations));

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translations: flattenedTranslations, fieldType, failedLocales }),
        },
      });

      return json({ success: true, translations: flattenedTranslations, fieldType, failedLocales });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // UPDATE CONTENT
  // ============================================================================

  if (action === "updateContent") {
    const locale = getFormString(formData, "locale");
    const primaryLocale = getFormString(formData, "primaryLocale");
    const changedFieldsDebug = getFormString(formData, "changedFields");

    logger.debug('[UnifiedContent] ==================== updateContent received ====================');
    logger.debug('[UnifiedContent] [UNIFIED-ACTION] updateContent received');
    logger.debug('[UnifiedContent] ResourceType:', contentConfig.resourceType);
    logger.debug('[UnifiedContent] ItemId:', itemId);
    logger.debug('[UnifiedContent] Locale:', locale);
    logger.debug('[UnifiedContent] PrimaryLocale:', primaryLocale);
    logger.debug('[UnifiedContent] ChangedFields:', changedFieldsDebug);
    logger.debug('[UnifiedContent] ==================== updateContent received ====================');

    try {
      // Special handling for Products - use dedicated product update handler
      if (contentConfig.resourceType === "Product") {
        const { handleUpdateProduct } = await import("./product/update.actions");
        const { prepareActionContext } = await import("./product/shared/action-context");

        // Prepare context for product update
        const context = await prepareActionContext(admin, session);

        // Map unified field names to product-specific names
        const productFormData = new FormData();
        productFormData.set("action", "updateProduct");
        productFormData.set("productId", itemId);
        productFormData.set("locale", locale);
        productFormData.set("primaryLocale", primaryLocale);

        // Map field names
        const fieldMapping: Record<string, string> = {
          title: "title",
          description: "descriptionHtml",
          handle: "handle",
          seoTitle: "seoTitle",
          metaDescription: "metaDescription",
          productType: "productType",
        };

        contentConfig.fieldDefinitions.forEach((field) => {
          const value = getFormString(formData, field.key);
          const productFieldName = fieldMapping[field.key] || field.key;
          if (value) {
            productFormData.set(productFieldName, value);
          }
        });

        // Pass changedFields for translation deletion when primary locale changes
        const changedFieldsStr = getFormString(formData, "changedFields");
        logger.debug('[UnifiedContent] [UNIFIED-ACTION] Passing changedFields to product handler:', changedFieldsStr);
        if (changedFieldsStr && locale === primaryLocale) {
          productFormData.set("changedFields", changedFieldsStr);
          logger.debug('[UnifiedContent] [UNIFIED-ACTION] changedFields SET in productFormData');
        } else {
          logger.debug('[UnifiedContent] [UNIFIED-ACTION] changedFields NOT set (locale !== primaryLocale or empty)');
        }

        // Pass imageAltTexts if present
        const imageAltTextsStr = getFormString(formData, "imageAltTexts");
        if (imageAltTextsStr) {
          productFormData.set("imageAltTexts", imageAltTextsStr);
          logger.debug('[UnifiedContent] [UNIFIED-ACTION] imageAltTexts SET in productFormData:', imageAltTextsStr);
        }

        // Pass changedAltTextIndices for alt-text translation deletion when primary locale changes
        const changedAltTextIndicesStr = getFormString(formData, "changedAltTextIndices");
        if (changedAltTextIndicesStr && locale === primaryLocale) {
          productFormData.set("changedAltTextIndices", changedAltTextIndicesStr);
          logger.debug('[UnifiedContent] [UNIFIED-ACTION] changedAltTextIndices SET in productFormData:', changedAltTextIndicesStr);
        }

        logger.debug('[UnifiedContent] [UNIFIED-ACTION] Calling handleUpdateProduct...');
        return handleUpdateProduct(context, productFormData, itemId);
      }

      // For other content types (Collections, Pages, Blogs, Policies), use unified service
      const updates: Record<string, string> = {};
      contentConfig.fieldDefinitions.forEach((field) => {
        let value = getFormString(formData, field.key);

        // Sanitize slug fields
        if (field.type === "slug" && value) {
          value = sanitizeSlug(value);
          if (!value) {
            throw new Error("Invalid URL slug: Handle must contain at least one alphanumeric character");
          }
        }

        updates[field.key] = value;
      });

      // Handle featured image alt text for Collections and Blogs
      if (contentConfig.resourceType === "Collection" || contentConfig.resourceType === "Article") {
        const imageAltTextsStr = getFormString(formData, "imageAltTexts");
        if (imageAltTextsStr) {
          try {
            const imageAltTexts = JSON.parse(imageAltTextsStr) as string[];
            // Featured image alt text is at index 0
            if (imageAltTexts[0] !== undefined) {
              updates.imageAltText = imageAltTexts[0];
              logger.debug('[UnifiedContent] Setting featured image alt text:', imageAltTexts[0]);
            }
          } catch (e) {
            logger.error('Failed to parse imageAltTexts:', e);
          }
        }
      }

      // Get changed fields (for translation deletion when saving primary locale)
      const changedFieldsStr = getFormString(formData, "changedFields");
      const changedFields: string[] | undefined = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : undefined;

      // Use unified content service
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        locale,
        primaryLocale,
        updates,
        db,
        shop: session.shop,
        changedFields: locale === primaryLocale ? changedFields : undefined, // Only pass for primary locale
      });

      return json(result);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Unified content update error', {
        context: 'UnifiedContent',
        action: 'updateContent',
        itemId,
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE ALT-TEXT (single image)
  // ============================================================================

  if (action === "generateAltText") {
    const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
    const imageUrl = getFormString(formData, "imageUrl");
    const productTitle = getFormString(formData, "productTitle");
    const mainLanguage = getFormString(formData, "mainLanguage");

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "aiGeneration",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: productTitle,
        fieldType: `altText_${imageIndex}`,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      let prompt = `Create an optimized alt text for a product image.
Product: ${productTitle}
Image URL: ${imageUrl}`;

      if (aiInstructions?.productAltTextFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
      }

      if (aiInstructions?.productAltTextInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
      }

      prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${mainLanguage}.`;

      const altText = await aiServiceWithTask.generateImageAltText(imageUrl, productTitle, prompt);

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ altText, imageIndex }),
        },
      });

      return json({ success: true, altText, imageIndex });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE ALL ALT-TEXTS (bulk)
  // ============================================================================

  if (action === "generateAllAltTexts") {
    const imagesData = getFormJSON<Array<{ url: string }>>(formData, "imagesData");
    if (!imagesData) {
      return json({ success: false, error: "Invalid imagesData format" }, { status: 400 });
    }
    const productTitle = getFormString(formData, "productTitle");
    const mainLanguage = getFormString(formData, "mainLanguage");
    const totalImages = imagesData.length;

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "bulkAIGeneration",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: productTitle,
        fieldType: "allAltTexts",
        progress: 0,
        total: totalImages,
        processed: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const generatedAltTexts: Record<number, string> = {};

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

      for (let i = 0; i < imagesData.length; i++) {
        const image = imagesData[i];
        try {
          let prompt = `Create an optimized alt text for a product image.
Product: ${productTitle}
Image URL: ${image.url}`;

          if (aiInstructions?.productAltTextFormat) {
            prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
          }

          if (aiInstructions?.productAltTextInstructions) {
            prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
          }

          prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${mainLanguage}.`;

          const altText = await aiServiceWithTask.generateImageAltText(image.url, productTitle, prompt);
          generatedAltTexts[i] = altText;

          const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
          await db.task.update({
            where: { id: task.id },
            data: { progress: progressPercent, processed: i + 1 },
          });
        } catch (error: unknown) {
          logger.error("Failed to generate alt-text for image", {
            context: "UnifiedContent",
            imageIndex: i,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ generatedAltTexts }),
        },
      });

      return json({ success: true, generatedAltTexts });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALT-TEXT
  // ============================================================================

  if (action === "translateAltText") {
    const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
    const sourceAltText = getFormString(formData, "sourceAltText");
    const targetLocale = getFormString(formData, "targetLocale");

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "translation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        fieldType: `altText_${imageIndex}`,
        targetLocale,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      const changedFields: Record<string, string> = {};
      changedFields[`altText_${imageIndex}`] = sourceAltText;

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const translations = await translationServiceWithTask.translateProduct(
        changedFields,
        [targetLocale],
        "product"
      );
      const translatedAltText = translations[targetLocale]?.[`altText_${imageIndex}`] || "";

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translatedAltText, imageIndex, targetLocale }),
        },
      });

      return json({
        success: true,
        translatedAltText,
        imageIndex,
        targetLocale,
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALT-TEXT TO ALL LOCALES
  // ============================================================================

  if (action === "translateAltTextToAllLocales") {
    const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
    const sourceAltText = getFormString(formData, "sourceAltText");
    const targetLocales = getFormJSON<string[]>(formData, "targetLocales");
    if (!targetLocales) {
      return json({ success: false, error: "Invalid targetLocales format" }, { status: 400 });
    }

    // Create task entry
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "translation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        fieldType: `altText_${imageIndex}`,
        targetLocale: targetLocales.join(","),
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

      const changedFields: Record<string, string> = {};
      changedFields[`altText_${imageIndex}`] = sourceAltText;

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const translations = await translationServiceWithTask.translateProduct(
        changedFields,
        targetLocales,
        "product"
      );

      // Extract translated alt-texts for each locale
      const translatedAltTexts: Record<string, string> = {};
      for (const locale of targetLocales) {
        translatedAltTexts[locale] = translations[locale]?.[`altText_${imageIndex}`] || "";
      }

      await db.task.update({
        where: { id: task.id },
        data: { status: "running", progress: 50 },
      });

      // Save translations to Shopify first, then DB only on success
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      // Get DB product image to find mediaId
      const dbProduct = await db.product.findUnique({
        where: { id: itemId },
        include: {
          images: {
            orderBy: { position: 'asc' },
          },
        },
      });

      const dbImage = dbProduct?.images?.[imageIndex];
      const failedLocales: string[] = [];
      const savedLocales: string[] = [];

      if (!dbImage?.mediaId) {
        // No mediaId = cannot save to Shopify, so don't save to DB either
        logger.warn("[UnifiedContent] No mediaId for image - cannot save alt-text translations to Shopify", {
          context: "UnifiedContent", imageIndex, productId: itemId,
        });
        failedLocales.push(...targetLocales);
      } else {
        // Fetch digest once (shared for all locales)
        let altDigest: string | undefined;
        try {
          const translatableResponse = await gateway.graphql(
            `#graphql
              query translatableContent($resourceId: ID!) {
                translatableResource(resourceId: $resourceId) {
                  resourceId
                  translatableContent {
                    key
                    digest
                    value
                  }
                }
              }`,
            { variables: { resourceId: dbImage.mediaId } }
          );
          const translatableData = await translatableResponse.json();
          const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
          altDigest = translatableContent.find((c: { key: string; digest: string }) => c.key === "alt")?.digest;
        } catch (err: unknown) {
          logger.error("[UnifiedContent] Error fetching translatable content for alt-text", {
            context: "UnifiedContent", imageIndex, error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!altDigest) {
          logger.warn("[UnifiedContent] No digest for alt-text - cannot save to Shopify", {
            context: "UnifiedContent", imageIndex, mediaId: dbImage.mediaId,
          });
          failedLocales.push(...targetLocales);
        } else {
          // Save each locale to Shopify, then DB
          for (const locale of targetLocales) {
            const altText = translatedAltTexts[locale];
            if (!altText) continue;

            let shopifySaved = false;
            try {
              const shopifyResult = await gateway.graphql(
                `#graphql
                  mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                    translationsRegister(resourceId: $resourceId, translations: $translations) {
                      userErrors { field message }
                      translations { locale key value }
                    }
                  }`,
                {
                  variables: {
                    resourceId: dbImage.mediaId,
                    translations: [{
                      key: "alt",
                      value: altText,
                      locale: locale,
                      translatableContentDigest: altDigest,
                    }],
                  },
                }
              );
              const shopifyData = await shopifyResult.json();
              const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
              if (userErrors.length === 0) {
                shopifySaved = true;
              } else {
                logger.error("[UnifiedContent] Shopify translationsRegister userErrors for alt-text", {
                  context: "UnifiedContent", imageIndex, locale, errors: userErrors,
                });
              }
            } catch (shopifyError: unknown) {
              logger.error("[UnifiedContent] Error saving alt-text to Shopify", {
                context: "UnifiedContent", imageIndex, locale, error: shopifyError instanceof Error ? shopifyError.message : String(shopifyError),
              });
            }

            // Only save to DB if Shopify succeeded
            if (shopifySaved) {
              try {
                const existing = await db.productImageAltTranslation.findUnique({
                  where: { imageId_locale: { imageId: dbImage.id, locale } },
                });
                if (existing) {
                  await db.productImageAltTranslation.update({ where: { id: existing.id }, data: { altText } });
                } else {
                  await db.productImageAltTranslation.create({ data: { imageId: dbImage.id, locale, altText } });
                }
                savedLocales.push(locale);
              } catch (dbError: unknown) {
                const dbErr = dbError instanceof Error ? dbError : new Error(String(dbError));
                const dbErrCode = (dbError as { code?: string })?.code;
                if (dbErrCode === 'P2003' || dbErr.message?.includes('Foreign key constraint')) {
                  logger.warn("[UnifiedContent] Image deleted during translation save (concurrent sync)", {
                    context: "UnifiedContent", imageIndex, productId: itemId, error: dbErr.message,
                  });
                } else {
                  throw dbError;
                }
              }
            } else {
              failedLocales.push(locale);
            }
          }
        }
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translatedAltTexts, imageIndex, targetLocales, savedLocales, failedLocales }),
        },
      });

      return json({
        success: true,
        translatedAltTexts,
        imageIndex,
        targetLocales,
        failedLocales,
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return json({ success: false, error: errorMsg }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

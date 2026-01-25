/**
 * Unified Content Actions
 *
 * Generic action handlers for all content types
 * Based on the products implementation with all bug fixes
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import { sanitizeSlug } from "../utils/slug.utils";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "../../src/utils/task.utils";
import type { ContentEditorConfig } from "../types/content-editor.types";
import { logger } from "../utils/logger.server";

interface UnifiedContentActionsConfig {
  admin: any;
  session: any;
  formData: FormData;
  contentConfig: ContentEditorConfig;
  db: any;
  aiSettings: any;
  aiInstructions: any;
}

export async function handleUnifiedContentActions(config: UnifiedContentActionsConfig) {
  const { admin, session, formData, contentConfig, db, aiSettings, aiInstructions } = config;

  const action = formData.get("action") as string;
  const itemId = formData.get("itemId") as string || formData.get("productId") as string;

  // Initialize services
  const provider = (aiSettings?.preferredProvider as any) || process.env.AI_PROVIDER || "huggingface";
  const serviceConfig = {
    huggingfaceApiKey: decryptApiKey(aiSettings?.huggingfaceApiKey) || undefined,
    geminiApiKey: decryptApiKey(aiSettings?.geminiApiKey) || undefined,
    claudeApiKey: decryptApiKey(aiSettings?.claudeApiKey) || undefined,
    openaiApiKey: decryptApiKey(aiSettings?.openaiApiKey) || undefined,
    grokApiKey: decryptApiKey(aiSettings?.grokApiKey) || undefined,
    deepseekApiKey: decryptApiKey(aiSettings?.deepseekApiKey) || undefined,
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
    const locale = formData.get("locale") as string;

    try {
      const translations = await shopifyContentService.loadTranslations(itemId, locale);
      return json({ success: true, translations, locale });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE AI TEXT
  // ============================================================================

  if (action === "generateAIText") {
    const fieldType = formData.get("fieldType") as string;
    const currentValue = formData.get("currentValue") as string;
    const contextTitle = formData.get("contextTitle") as string;
    const contextDescription = formData.get("contextDescription") as string;
    const mainLanguage = formData.get("mainLanguage") as string;

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

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nInstructions:\n${aiInstructions[instructionsTextKey]}`;
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

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nInstructions:\n${aiInstructions[instructionsTextKey]}`;
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
    } catch (error: any) {
      // Update task to failed
      const errorMessage = (error.message || String(error)).substring(0, 1000);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // FORMAT AI TEXT
  // ============================================================================

  if (action === "formatAIText") {
    const fieldType = formData.get("fieldType") as string;
    const currentValue = formData.get("currentValue") as string;
    const contextTitle = formData.get("contextTitle") as string;
    const contextDescription = formData.get("contextDescription") as string;
    const mainLanguage = formData.get("mainLanguage") as string;

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

      if (field.type === "text" || field.type === "slug") {
        let prompt = `Format the following ${field.label} according to the formatting guidelines:\n\nCurrent ${field.label}:\n${currentValue}`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nFormatting Instructions:\n${aiInstructions[instructionsTextKey]}`;
        }

        if (field.type === "slug") {
          prompt += `\n\nIMPORTANT - The URL slug MUST follow this format:`;
          prompt += `\n- ONLY lowercase letters (a-z), ONLY digits (0-9), ONLY hyphens (-)`;
          prompt += `\n- Umlauts MUST be converted (ä→ae, ö→oe, ü→ue, ß→ss)`;
        }

        prompt += `\n\nReturn ONLY the formatted ${field.label}, without explanations. Output the result in ${mainLanguage}.`;
        formattedContent = await aiServiceWithTask.generateProductTitle(prompt);

        if (field.type === "slug") {
          formattedContent = sanitizeSlug(formattedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        let prompt = `Format the following ${field.label} according to the formatting guidelines:\n\nCurrent ${field.label}:\n${currentValue}`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormat Example:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nFormatting Instructions:\n${aiInstructions[instructionsTextKey]}`;
        }

        prompt += `\n\nKeep the content but format according to the guidelines. Return only the formatted text. Output the result in ${mainLanguage}.`;
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
    } catch (error: any) {
      // Update task to failed
      const errorMessage = (error.message || String(error)).substring(0, 1000);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE FIELD
  // ============================================================================

  if (action === "translateField") {
    const fieldType = formData.get("fieldType") as string;
    const sourceText = formData.get("sourceText") as string;
    const targetLocale = formData.get("targetLocale") as string;

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

      const changedFields: any = {};
      changedFields[fieldType] = sourceText;

      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      const translations = await translationServiceWithTask.translateProduct(changedFields, [targetLocale], contentConfig.contentType);
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
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALL (to ALL enabled locales)
  // ============================================================================

  if (action === "translateAll") {
    const targetLocalesStr = formData.get("targetLocales") as string;
    const contextTitle = formData.get("title") as string;

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
      const changedFields: any = {};

      // Collect all field values
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = formData.get(field.key) as string;
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

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? JSON.parse(targetLocalesStr) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
      });

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            success: true,
            locales: Object.keys(allTranslations),
          }),
        },
      });

      return json({ success: true, translations: allTranslations });
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALL FOR LOCALE (to ONE specific locale)
  // ============================================================================

  if (action === "translateAllForLocale") {
    const targetLocale = formData.get("targetLocale") as string;
    const contextTitle = formData.get("title") as string;

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
      const changedFields: any = {};

      // Collect all field values
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = formData.get(field.key) as string;
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
      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: [targetLocale],
        contentType: contentConfig.contentType,
        taskId: task.id,
      });

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
          }),
        },
      });

      return json({ success: true, translations, targetLocale });
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE FIELD TO ALL LOCALES
  // ============================================================================

  if (action === "translateFieldToAllLocales") {
    const fieldType = formData.get("fieldType") as string;
    const sourceText = formData.get("sourceText") as string;
    const targetLocalesStr = formData.get("targetLocales") as string;
    const contextTitle = formData.get("contextTitle") as string;

    console.log('🟠🟠🟠 [translateFieldToAllLocales] Starting...');
    console.log('🟠 fieldType:', fieldType);
    console.log('🟠 targetLocales:', targetLocalesStr);

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
      const changedFields: any = {};
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

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? JSON.parse(targetLocalesStr) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
      });

      // Extract just the field value for each locale (frontend expects Record<locale, string>)
      // allTranslations is Record<locale, Record<fieldType, string>>
      // We need to flatten it to Record<locale, string>
      console.log('🟠 [translateFieldToAllLocales] allTranslations from service:', Object.keys(allTranslations));
      console.log('🟠 [translateFieldToAllLocales] allTranslations detail:', JSON.stringify(allTranslations, null, 2));

      const flattenedTranslations: Record<string, string> = {};
      for (const [locale, fields] of Object.entries(allTranslations)) {
        const value = (fields as any)[fieldType] || "";
        flattenedTranslations[locale] = value;
        console.log(`🟠 [translateFieldToAllLocales] Extracted ${locale}.${fieldType} = "${value.substring(0, 50)}..."`);
      }

      console.log('🟠🟠🟠 [translateFieldToAllLocales] RETURNING locales:', Object.keys(flattenedTranslations));

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translations: flattenedTranslations, fieldType }),
        },
      });

      return json({ success: true, translations: flattenedTranslations, fieldType });
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // UPDATE CONTENT
  // ============================================================================

  if (action === "updateContent") {
    const locale = formData.get("locale") as string;
    const primaryLocale = formData.get("primaryLocale") as string;
    const changedFieldsDebug = formData.get("changedFields") as string;

    console.log('🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣');
    console.log('🟣 [UNIFIED-ACTION] updateContent received');
    console.log('🟣 ResourceType:', contentConfig.resourceType);
    console.log('🟣 ItemId:', itemId);
    console.log('🟣 Locale:', locale);
    console.log('🟣 PrimaryLocale:', primaryLocale);
    console.log('🟣 ChangedFields:', changedFieldsDebug);
    console.log('🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣');

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
        };

        contentConfig.fieldDefinitions.forEach((field) => {
          const value = formData.get(field.key) as string;
          const productFieldName = fieldMapping[field.key] || field.key;
          if (value !== null) {
            productFormData.set(productFieldName, value);
          }
        });

        // Pass changedFields for translation deletion when primary locale changes
        const changedFieldsStr = formData.get("changedFields") as string;
        console.log('🟣 [UNIFIED-ACTION] Passing changedFields to product handler:', changedFieldsStr);
        if (changedFieldsStr && locale === primaryLocale) {
          productFormData.set("changedFields", changedFieldsStr);
          console.log('🟣 [UNIFIED-ACTION] changedFields SET in productFormData');
        } else {
          console.log('🟣 [UNIFIED-ACTION] changedFields NOT set (locale !== primaryLocale or empty)');
        }

        console.log('🟣 [UNIFIED-ACTION] Calling handleUpdateProduct...');
        return handleUpdateProduct(context, productFormData, itemId);
      }

      // For other content types (Collections, Pages, Blogs, Policies), use unified service
      const updates: any = {};
      contentConfig.fieldDefinitions.forEach((field) => {
        let value = formData.get(field.key) as string;

        // Sanitize slug fields
        if (field.type === "slug" && value) {
          value = sanitizeSlug(value);
          if (!value) {
            throw new Error("Invalid URL slug: Handle must contain at least one alphanumeric character");
          }
        }

        updates[field.key] = value;
      });

      // Get changed fields (for translation deletion when saving primary locale)
      const changedFieldsStr = formData.get("changedFields") as string;
      const changedFields = changedFieldsStr ? JSON.parse(changedFieldsStr) : undefined;

      // Use unified content service
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        locale,
        primaryLocale,
        updates,
        db,
        shop: session.shop,
        changedFields: locale === primaryLocale ? changedFields : undefined, // Only pass for primary locale
      });

      return json(result);
    } catch (error: any) {
      logger.error('Unified content update error', {
        context: 'UnifiedContent',
        action: 'updateContent',
        itemId,
        error: error.message,
        stack: error.stack
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE ALT-TEXT (single image)
  // ============================================================================

  if (action === "generateAltText") {
    const imageIndex = parseInt(formData.get("imageIndex") as string);
    const imageUrl = formData.get("imageUrl") as string;
    const productTitle = formData.get("productTitle") as string;

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

      prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in the main language of the product.`;

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
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // GENERATE ALL ALT-TEXTS (bulk)
  // ============================================================================

  if (action === "generateAllAltTexts") {
    const imagesData = JSON.parse(formData.get("imagesData") as string);
    const productTitle = formData.get("productTitle") as string;
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

          prompt += `\n\nReturn ONLY the alt text, without explanations.`;

          const altText = await aiServiceWithTask.generateImageAltText(image.url, productTitle, prompt);
          generatedAltTexts[i] = altText;

          const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
          await db.task.update({
            where: { id: task.id },
            data: { progress: progressPercent, processed: i + 1 },
          });
        } catch (error: any) {
          logger.error("Failed to generate alt-text for image", {
            context: "UnifiedContent",
            imageIndex: i,
            error: error.message,
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
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALT-TEXT
  // ============================================================================

  if (action === "translateAltText") {
    const imageIndex = parseInt(formData.get("imageIndex") as string);
    const sourceAltText = formData.get("sourceAltText") as string;
    const targetLocale = formData.get("targetLocale") as string;

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

      const changedFields: any = {};
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
    } catch (error: any) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: error.message,
        },
      });
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

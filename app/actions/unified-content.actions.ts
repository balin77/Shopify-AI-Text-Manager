/**
 * Unified Content Actions
 *
 * Generic action handlers for all content types
 * Based on the products implementation with all bug fixes
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { AIService, toValidProvider } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import { sanitizeSlug } from "../utils/slug.utils";
import { decryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import type { ContentEditorConfig } from "../types/content-editor.types";
import { logger } from "../utils/logger.server";
import { ShopifyApiGateway } from "../services/shopify-api-gateway.service";
import { getFormString, getFormInt, getFormJSON } from "../utils/form-data.utils";
import { isValidShopifyGID, isValidLocale, safeJsonParse } from "../utils/validation";
import { sanitizePromptInput } from "../utils/prompt-sanitizer";
import { getFullErrorMessage } from "../utils/error-handler";
import { getInstructionWithDefault, getWritingStyleInstructions, getCharacterLimitRequirement } from "~/utils/ai-instructions.utils";
import { findMetaobjectLabelField } from "../constants/shopifyFields";
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
  // Metaobject type IDs use a custom format (e.g. "metaobject_type_color"), not a Shopify GID
  const isMetaobjectTypeId = itemId?.startsWith("metaobject_type_");
  if (itemId && !isMetaobjectTypeId && !isValidShopifyGID(itemId)) {
    return json({ success: false, error: "Invalid resource ID format" }, { status: 400 });
  }

  const actionsRequiringItemId = ["loadTranslations", "generateAIText", "formatAIText", "translateField", "translateAll", "translateAllForLocale", "translateFieldToAllLocales", "updateContent", "generateAltText", "generateAllAltTexts", "translateAltText", "translateAltTextToAllLocales"];
  if (actionsRequiringItemId.includes(action) && !itemId) {
    return json({ success: false, error: "Missing required itemId" }, { status: 400 });
  }

  // Initialize services
  const provider = toValidProvider(aiSettings?.preferredProvider || process.env.AI_PROVIDER || "huggingface");
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

  const gateway = new ShopifyApiGateway(admin, session.shop);
  const shopifyContentService = new ShopifyContentService(gateway as any);

  // ============================================================================
  // LOAD TRANSLATIONS
  // ============================================================================

  if (action === "loadTranslations") {
    const locale = getFormString(formData, "locale");
    if (!locale || !isValidLocale(locale)) {
      return json({ success: false, error: "Invalid locale format" }, { status: 400 });
    }

    try {
      const translations = await shopifyContentService.loadTranslations(itemId, locale);
      return json({ actionType: "loadTranslations", success: true, translations, locale });
    } catch (error: unknown) {
      const msg = getFullErrorMessage(error);
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
    const sanitizedContextTitle = sanitizePromptInput(contextTitle || "", { fieldType: "title" });
    const contextDescription = getFormString(formData, "contextDescription");
    const sanitizedContextDescription = sanitizePromptInput(contextDescription || "", { fieldType: "description", allowNewlines: true });
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
        // Get instructions (with default fallback)
        const writingStyle = getWritingStyleInstructions(instructions);
        const formatExample = getInstructionWithDefault(instructions, formatKey);
        const fieldInstructions = getInstructionWithDefault(instructions, instructionsTextKey);

        let prompt = `Create an improved ${field.label} for the following content.`;

        // Add context information
        if (sanitizedContextTitle) {
          prompt += `\n\nContext - Title: ${sanitizedContextTitle}`;
        }
        if (sanitizedContextDescription) {
          prompt += `\nContext - Description: ${sanitizedContextDescription}`;
        }
        if (currentValue) {
          prompt += `\nCurrent ${field.label}: ${currentValue}`;
        }
        prompt += `\nLanguage: ${mainLanguage}`;

        // Add requirements section
        prompt += `\n\nRequirements:`;

        // Add character limit if available
        const charLimit = getCharacterLimitRequirement(instructionsKey || "");
        if (charLimit) {
          prompt += `\n- Length: ${charLimit}`;
        }

        if (field.type === "slug") {
          prompt += `\n- Use only lowercase letters (a-z), digits (0-9), and hyphens (-)`;
          prompt += `\n- No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss)`;
          prompt += `\n- No spaces, underscores, or special characters`;
          prompt += `\n- 2-5 words, separated by hyphens`;
          prompt += `\n\nSlug Examples:`;
          prompt += `\n- "Über Uns" → "ueber-uns"`;
          prompt += `\n- "Kontakt & Impressum" → "kontakt-impressum"`;
        } else {
          prompt += `\n- Clear and concise`;
          prompt += `\n- SEO-friendly where applicable`;
          prompt += `\n- Customer-focused language`;
        }

        // Add writing style (compact)
        if (writingStyle) {
          prompt += `\n\nWriting Style:\n${writingStyle}`;
        }

        // Add format example (compact)
        if (formatExample) {
          prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;
        }

        // Add field-specific instructions (compact)
        if (fieldInstructions) {
          prompt += `\n\nGuidelines:\n${fieldInstructions}`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the ${field.label}, nothing else. Output in ${mainLanguage}.`;
        generatedContent = await aiServiceWithTask.generateProductTitle(prompt);
        if (!generatedContent || !generatedContent.trim()) throw new Error("AI returned empty response");

        if (field.type === "slug") {
          generatedContent = sanitizeSlug(generatedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        // Get instructions (with default fallback)
        const writingStyle = getWritingStyleInstructions(instructions);
        const formatExample = getInstructionWithDefault(instructions, formatKey);
        const fieldInstructions = getInstructionWithDefault(instructions, instructionsTextKey);

        let prompt = `Create an improved ${field.label} for the following content.`;

        // Add context information
        if (sanitizedContextTitle) {
          prompt += `\n\nContext - Title: ${sanitizedContextTitle}`;
        }
        if (sanitizedContextDescription) {
          prompt += `\nContext - Description: ${sanitizedContextDescription}`;
        }
        if (currentValue) {
          prompt += `\nCurrent ${field.label}: ${currentValue}`;
        }
        prompt += `\nLanguage: ${mainLanguage}`;

        // Add requirements section
        prompt += `\n\nRequirements:`;

        // Add character limit if available
        const charLimitHtml = getCharacterLimitRequirement(instructionsKey || "");
        if (charLimitHtml) {
          prompt += `\n- Length: ${charLimitHtml}`;
        }

        // Add HTML-specific requirements
        if (field.type === "html") {
          prompt += `\n- Use HTML formatting (<h2>, <h3>, <p>, <strong>, <em>, <ul>, <li>)`;
          prompt += `\n- Structure content with headings and paragraphs`;
          prompt += `\n- Focus on readability and user engagement`;
        } else {
          prompt += `\n- Clear and concise`;
          prompt += `\n- SEO-friendly where applicable`;
          prompt += `\n- Customer-focused language`;
        }

        // Add writing style (compact)
        if (writingStyle) {
          prompt += `\n\nWriting Style:\n${writingStyle}`;
        }

        // Add format example (compact)
        if (formatExample) {
          prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;
        }

        // Add field-specific instructions (compact)
        if (fieldInstructions) {
          prompt += `\n\nGuidelines:\n${fieldInstructions}`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the ${field.label}, nothing else. Output in ${mainLanguage}.`;
        generatedContent = await aiServiceWithTask.generateProductDescription(sanitizedContextTitle, prompt);
        if (!generatedContent || !generatedContent.trim()) throw new Error("AI returned empty response");
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

      return json({ actionType: "generateAIText", success: true, generatedContent, fieldType });
    } catch (error: unknown) {
      // Update task to failed
      const errorMessage = (getFullErrorMessage(error)).substring(0, 1000);
      try {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: errorMessage,
          },
        });
      } catch (updateErr) {
        console.error("Failed to update task status:", updateErr);
      }
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
    const sanitizedContextTitle = sanitizePromptInput(contextTitle || "", { fieldType: "title" });
    const contextDescription = getFormString(formData, "contextDescription");
    const sanitizedContextDescription = sanitizePromptInput(contextDescription || "", { fieldType: "description", allowNewlines: true });
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

      // Get format preserve instructions (from DB or default)
      const preserveTextInstruction = getInstructionWithDefault(aiInstructions, "formatPreserveInstructions");

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
          const formatExample = getInstructionWithDefault(instructions, formatKey);
          if (formatExample) {
            prompt += `\n\nFormat Style Example:\n${formatExample}`;
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
          const formatExample2 = getInstructionWithDefault(instructions, formatKey);
          if (formatExample2) {
            prompt += `\n\nFormat Style Example (for structure reference only, do NOT copy the content):\n${formatExample2}`;
          }
          prompt += `\n\nReturn ONLY the formatted ${field.label}. Keep the original language. Do NOT add new information or rewrite the text. Output the result in ${mainLanguage}.`;
        }

        formattedContent = await aiServiceWithTask.generateProductTitle(prompt);
        if (!formattedContent || !formattedContent.trim()) throw new Error("AI returned empty response");

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

        const formatExample3 = getInstructionWithDefault(instructions, formatKey);
        if (formatExample3) {
          prompt += `\n\nFormat Style Example (for HTML structure reference only):\n${formatExample3}`;
        }

        prompt += `\n\nReturn ONLY the formatted HTML ${field.label}. Keep the original language and all original content. Do NOT add new sentences or rewrite existing ones. Output the result in ${mainLanguage}.`;
        formattedContent = await aiServiceWithTask.generateProductDescription(currentValue, prompt);
        if (!formattedContent || !formattedContent.trim()) throw new Error("AI returned empty response");
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

      return json({ actionType: "formatAIText", success: true, generatedContent: formattedContent, fieldType });
    } catch (error: unknown) {
      // Update task to failed
      const errorMessage = (getFullErrorMessage(error)).substring(0, 1000);
      try {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: errorMessage,
          },
        });
      } catch (updateErr) {
        console.error("Failed to update task status:", updateErr);
      }
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
    if (!targetLocale || !isValidLocale(targetLocale)) {
      return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
    }

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

      // Get translate instructions (from DB or default)
      const translateInstructions = getInstructionWithDefault(aiInstructions, "translateInstructions");

      const translations = await translationServiceWithTask.translateProduct(
        changedFields,
        [targetLocale],
        contentConfig.contentType,
        translateInstructions || undefined
      );
      const translatedValue = translations[targetLocale]?.[fieldType] || "";
      if (!translatedValue || !translatedValue.trim()) {
        throw new Error(`AI returned empty translation for field "${fieldType}"`);
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
        },
      });

      return json({ actionType: "translateField", success: true, translatedValue, fieldType, targetLocale });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
      try {
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: errorMsg,
          },
        });
      } catch (updateErr) {
        console.error("Failed to update task status:", updateErr);
      }
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
    if (!isValidLocale(sourceLocale)) {
      return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
    }

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

      // Collect field values - for metaobjects, extract GID-based keys from formData
      if (contentConfig.resourceType === "Metaobject") {
        for (const [key, value] of formData.entries()) {
          if (key.startsWith("gid://shopify/Metaobject/") && String(value).trim()) {
            changedFields[key] = String(value);
          }
        }
      } else {
        contentConfig.fieldDefinitions.forEach((field) => {
          const value = getFormString(formData, field.key);
          if (value) {
            changedFields[field.key] = value;
          }
        });
      }

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

      // Get translate instructions (from DB or default)
      const translateInstructionsAll = getInstructionWithDefault(aiInstructions, "translateInstructions");

      // Metaobjects need custom translation flow: each entry is a separate Shopify resource
      if (contentConfig.resourceType === "Metaobject") {
        const targetLocales = targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : [];
        const result = await translateMetaobjectEntries({
          admin, session, db, itemId,
          metaobjectFields: changedFields,
          targetLocales,
          translationService: translationServiceWithTask,
          customInstructions: translateInstructionsAll || undefined,
        });

        await db.task.update({
          where: { id: task.id },
          data: {
            status: result.failedLocales.length > 0 ? "completed_with_errors" : "completed",
            progress: 100,
            completedAt: new Date(),
            result: JSON.stringify({
              success: true,
              locales: Object.keys(result.translations),
              failedLocales: result.failedLocales,
            }),
          },
        });

        return json({ actionType: "translateAll", success: true, translations: result.translations, failedLocales: result.failedLocales, rejectedFields: {}, skippedFields: {} });
      }

      const result = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
        customInstructions: translateInstructionsAll || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

      await db.task.update({
        where: { id: task.id },
        data: {
          status: failedLocales.length > 0 ? "completed_with_errors" : "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            success: true,
            locales: Object.keys(allTranslations),
            failedLocales,
            rejectedFields,
            skippedFields,
          }),
        },
      });

      return json({ actionType: "translateAll", success: true, translations: allTranslations, failedLocales, rejectedFields, skippedFields });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
    if (!targetLocale || !isValidLocale(targetLocale)) {
      return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
    }
    if (!isValidLocale(sourceLocale)) {
      return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
    }

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

      // Collect field values - for metaobjects, extract GID-based keys from formData
      if (contentConfig.resourceType === "Metaobject") {
        for (const [key, value] of formData.entries()) {
          if (key.startsWith("gid://shopify/Metaobject/") && String(value).trim()) {
            changedFields[key] = String(value);
          }
        }
      } else {
        contentConfig.fieldDefinitions.forEach((field) => {
          const value = getFormString(formData, field.key);
          if (value) {
            changedFields[field.key] = value;
          }
        });
      }

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

      // Get translate instructions (from DB or default)
      const translateInstructionsForLocale = getInstructionWithDefault(aiInstructions, "translateInstructions");

      // Metaobjects need custom translation flow
      if (contentConfig.resourceType === "Metaobject") {
        const result = await translateMetaobjectEntries({
          admin, session, db, itemId,
          metaobjectFields: changedFields,
          targetLocales: [targetLocale],
          translationService: translationServiceWithTask,
          customInstructions: translateInstructionsForLocale || undefined,
        });

        const translations = result.translations[targetLocale] || {};

        await db.task.update({
          where: { id: task.id },
          data: {
            status: result.failedLocales.length > 0 ? "completed_with_errors" : "completed",
            progress: 100,
            completedAt: new Date(),
            result: JSON.stringify({ success: true, targetLocale, translations, failedLocales: result.failedLocales }),
          },
        });

        return json({ actionType: "translateAllForLocale", success: true, translations, targetLocale, failedLocales: result.failedLocales, rejectedFields: {}, skippedFields: {} });
      }

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
        customInstructions: translateInstructionsForLocale || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

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
            skippedFields,
          }),
        },
      });

      return json({ actionType: "translateAllForLocale", success: true, translations, targetLocale, failedLocales, rejectedFields, skippedFields });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
    if (!isValidLocale(sourceLocale)) {
      return json({ success: false, error: "Invalid source locale format" }, { status: 400 });
    }

    logger.debug('[UnifiedContent] translateFieldToAllLocales', { fieldType, targetLocales: targetLocalesStr });

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

      // Get translate instructions (from DB or default)
      const translateInstructionsFieldToAll = getInstructionWithDefault(aiInstructions, "translateInstructions");

      const result = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        fields: changedFields,
        translationService: translationServiceWithTask,
        db,
        targetLocales: targetLocalesStr ? safeJsonParse<string[]>(targetLocalesStr, []) : undefined,
        contentType: contentConfig.contentType,
        taskId: task.id,
        customInstructions: translateInstructionsFieldToAll || undefined,
        sourceLocale,
      });

      const { translations: allTranslations, failedLocales, rejectedFields, skippedFields } = result;

      // Extract just the field value for each locale (frontend expects Record<locale, string>)
      // allTranslations is Record<locale, Record<fieldType, string>>
      // We need to flatten it to Record<locale, string>
      const flattenedTranslations: Record<string, string> = {};
      for (const [locale, fields] of Object.entries(allTranslations)) {
        flattenedTranslations[locale] = (fields as Record<string, string>)[fieldType] || "";
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translations: flattenedTranslations, fieldType, failedLocales, rejectedFields, skippedFields }),
        },
      });

      return json({ actionType: "translateFieldToAllLocales", success: true, translations: flattenedTranslations, fieldType, failedLocales, rejectedFields, skippedFields });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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

    logger.debug('[UnifiedContent] updateContent', { resourceType: contentConfig.resourceType, itemId, locale, primaryLocale });

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

        // Only forward fields that were actually sent by the client.
        // buildFieldsForSave only includes changed fields for foreign locales,
        // so absent fields mean "not changed" — NOT "clear this field".
        // Using formData.has() preserves empty strings (user cleared the field)
        // while skipping fields the client never sent.
        contentConfig.fieldDefinitions.forEach((field) => {
          if (!formData.has(field.key)) return;
          const value = getFormString(formData, field.key);
          const productFieldName = fieldMapping[field.key] || field.key;
          productFormData.set(productFieldName, value);
        });

        // Pass changedFields for translation deletion when primary locale changes
        const changedFieldsStr = getFormString(formData, "changedFields");
        if (changedFieldsStr && locale === primaryLocale) {
          productFormData.set("changedFields", changedFieldsStr);
        }

        // Pass imageAltTexts if present
        const imageAltTextsStr = getFormString(formData, "imageAltTexts");
        if (imageAltTextsStr) {
          productFormData.set("imageAltTexts", imageAltTextsStr);
        }

        // Pass changedAltTextIndices for alt-text translation deletion when primary locale changes
        const changedAltTextIndicesStr = getFormString(formData, "changedAltTextIndices");
        if (changedAltTextIndicesStr && locale === primaryLocale) {
          productFormData.set("changedAltTextIndices", changedAltTextIndicesStr);
        }

        const productResult = await handleUpdateProduct(context, productFormData, itemId);
        // Inject actionType into the response for discriminated union matching
        const productBody = await productResult.json();
        return json({ ...productBody, actionType: "updateContent" }, { status: productResult.status });
      }

      // Special handling for Metaobjects
      // Each field key is a metaobject ID (gid://shopify/Metaobject/...).
      // We iterate over all changed fields and update each metaobject individually.
      if (contentConfig.resourceType === "Metaobject") {
        const { METAOBJECT_UPDATE, TRANSLATE_CONTENT, REMOVE_TRANSLATIONS } = await import("../graphql/content.mutations");
        const { GET_TRANSLATABLE_CONTENT } = await import("../graphql/content.queries");

        // Collect changed metaobject fields from formData
        const metaobjectUpdates: Array<{ id: string; value: string }> = [];
        for (const [key, value] of formData.entries()) {
          if (key.startsWith("gid://shopify/Metaobject/")) {
            metaobjectUpdates.push({ id: key, value: String(value) });
          }
        }

        if (metaobjectUpdates.length === 0) {
          return json({ success: true, actionType: "updateContent" });
        }

        // Block empty primary-locale fields (same protection as templates)
        if (locale === primaryLocale) {
          const emptyEntries = metaobjectUpdates.filter(u => u.value.trim() === "");
          if (emptyEntries.length > 0) {
            logger.warn("[UnifiedContent] Blocked metaobject save — empty primary-locale fields", {
              context: "Metaobjects",
              locale,
              emptyIds: emptyEntries.map(e => e.id),
            });
            return json({
              success: false,
              errorKey: "emptyPrimaryFieldsError",
            }, { status: 400 });
          }
        }

        const errors: string[] = [];

        for (const update of metaobjectUpdates) {
          try {
            // Query metaobject to find the label field key
            const metaobjectResponse = await admin.graphql(
              `#graphql
                query getMetaobject($id: ID!) {
                  metaobject(id: $id) {
                    id
                    fields { key type }
                  }
                }`,
              { variables: { id: update.id } }
            );
            const metaobjectData = await metaobjectResponse.json();
            const fields = metaobjectData.data?.metaobject?.fields || [];
            const labelField = findMetaobjectLabelField(fields);

            if (!labelField) {
              errors.push(`No label field found for ${update.id}`);
              continue;
            }

            if (locale === primaryLocale) {
              // Update metaobject field directly
              const updateResponse = await admin.graphql(METAOBJECT_UPDATE, {
                variables: {
                  id: update.id,
                  metaobject: {
                    fields: [{ key: labelField.key, value: update.value }]
                  }
                }
              });
              const updateData = await updateResponse.json();
              if (updateData.data?.metaobjectUpdate?.userErrors?.length > 0) {
                errors.push(updateData.data.metaobjectUpdate.userErrors[0].message);
              } else {
                // Update DB
                await db.metaobject.update({
                  where: { shop_id: { shop: session.shop, id: update.id } },
                  data: { displayName: update.value, lastSyncedAt: new Date() }
                });
              }
            } else if (update.value.trim() === "") {
              // Empty value in foreign locale → remove the translation
              const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
                variables: {
                  resourceId: update.id,
                  translationKeys: [labelField.key],
                  locales: [locale]
                }
              });
              const removeData = await removeResponse.json();
              if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
                errors.push(removeData.data.translationsRemove.userErrors[0].message);
              } else {
                // Remove from DB
                await db.metaobjectTranslation.deleteMany({
                  where: {
                    shop: session.shop,
                    metaobjectId: update.id,
                    key: labelField.key,
                    locale
                  }
                });
              }
            } else {
              // Non-empty value in foreign locale → fetch digest then register translation
              const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
                variables: { resourceId: update.id }
              });
              const digestData = await digestResponse.json();
              const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
              const digestEntry = translatableContent.find((c: any) => c.key === labelField.key);

              if (!digestEntry?.digest) {
                errors.push(`No digest found for ${update.id} field ${labelField.key}`);
                continue;
              }

              const translationResponse = await admin.graphql(TRANSLATE_CONTENT, {
                variables: {
                  resourceId: update.id,
                  translations: [{
                    key: labelField.key,
                    value: update.value,
                    locale,
                    translatableContentDigest: digestEntry.digest
                  }]
                }
              });
              const translationData = await translationResponse.json();
              if (translationData.data?.translationsRegister?.userErrors?.length > 0) {
                errors.push(translationData.data.translationsRegister.userErrors[0].message);
              } else {
                // Update DB translation
                const typeId = itemId; // itemId is the metaobject type ID
                await db.metaobjectTranslation.upsert({
                  where: {
                    shop_metaobjectId_key_locale: {
                      shop: session.shop,
                      metaobjectId: update.id,
                      key: labelField.key,
                      locale
                    }
                  },
                  create: {
                    shop: session.shop,
                    metaobjectId: update.id,
                    type: typeId,
                    key: labelField.key,
                    value: update.value,
                    locale,
                    outdated: false
                  },
                  update: {
                    value: update.value,
                    outdated: false,
                    updatedAt: new Date()
                  }
                });
              }
            }
          } catch (err: any) {
            errors.push(`${update.id}: ${err.message}`);
          }
        }

        if (errors.length > 0) {
          logger.error("[UnifiedContent] Metaobject update errors", { context: "Metaobjects", errors });
          return json({
            success: false,
            error: `Some updates failed: ${errors.join("; ")}`,
            actionType: "updateContent"
          }, { status: 500 });
        }

        logger.info("[UnifiedContent] Metaobjects updated successfully", {
          context: "Metaobjects",
          count: metaobjectUpdates.length,
          locale
        });

        return json({ success: true, actionType: "updateContent" });
      }

      // For other content types (Collections, Pages, Blogs, Policies), use unified service
      // Only include fields that were actually sent by the client.
      // buildFieldsForSave only includes changed fields for foreign locales,
      // so absent fields mean "not changed" — NOT "clear this field".
      const updates: Record<string, string> = {};
      contentConfig.fieldDefinitions.forEach((field) => {
        if (!formData.has(field.key)) return;
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
            }
          } catch (e) {
            logger.error('Failed to parse imageAltTexts:', e);
          }
        }
      }

      // Get changed fields (for translation deletion when saving primary locale)
      const changedFieldsStr = getFormString(formData, "changedFields");
      const changedFields: string[] | undefined = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : undefined;

      // Extract policyType for ShopPolicy primary locale updates
      const policyType = contentConfig.resourceType === "ShopPolicy"
        ? getFormString(formData, "policyType") || undefined
        : undefined;

      // Use unified content service
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType,
        locale,
        primaryLocale,
        updates,
        db,
        shop: session.shop,
        policyType,
        changedFields: locale === primaryLocale ? changedFields : undefined, // Only pass for primary locale
      });

      return json({ ...result, actionType: "updateContent" });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
    const sanitizedProductTitle = sanitizePromptInput(productTitle || "", { fieldType: "title" });
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
Product: ${sanitizedProductTitle}
Image URL: ${imageUrl}`;

      if (aiInstructions?.productAltTextFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
      }

      if (aiInstructions?.productAltTextInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
      }

      prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${mainLanguage}.`;

      const altText = await aiServiceWithTask.generateImageAltText(imageUrl, sanitizedProductTitle, prompt);

      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ altText, imageIndex }),
        },
      });

      return json({ actionType: "generateAltText", success: true, altText, imageIndex });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
    const sanitizedProductTitle = sanitizePromptInput(productTitle || "", { fieldType: "title" });
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
Product: ${sanitizedProductTitle}
Image URL: ${image.url}`;

          if (aiInstructions?.productAltTextFormat) {
            prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
          }

          if (aiInstructions?.productAltTextInstructions) {
            prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
          }

          prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${mainLanguage}.`;

          const altText = await aiServiceWithTask.generateImageAltText(image.url, sanitizedProductTitle, prompt);
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
            error: getFullErrorMessage(error),
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

      return json({ actionType: "generateAllAltTexts", success: true, generatedAltTexts });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
    if (!targetLocale || !isValidLocale(targetLocale)) {
      return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
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
        contentConfig.contentType
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
        actionType: "translateAltText",
        success: true,
        translatedAltText,
        imageIndex,
        targetLocale,
      });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
        contentConfig.contentType
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
        actionType: "translateAltTextToAllLocales",
        success: true,
        translatedAltTexts,
        imageIndex,
        targetLocales,
        failedLocales,
      });
    } catch (error: unknown) {
      const errorMsg = getFullErrorMessage(error);
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
  // LOAD SUB-RESOURCE TRANSLATIONS (Options + Metafields)
  // ============================================================================

  if (action === "loadSubResourceTranslations") {
    const locale = getFormString(formData, "locale");
    if (!locale || !isValidLocale(locale)) {
      return json({ success: false, error: "Invalid locale format" }, { status: 400 });
    }

    try {
      const resourceIdsJson = getFormString(formData, "resourceIds");
      const resourceIds: string[] = resourceIdsJson ? JSON.parse(resourceIdsJson) : [];

      if (resourceIds.length === 0) {
        return json({
          actionType: "loadSubResourceTranslations",
          success: true,
          translations: {},
        });
      }

      // Validate all GIDs
      for (const rid of resourceIds) {
        if (!isValidShopifyGID(rid)) {
          return json({ success: false, error: `Invalid resource ID: ${rid}` }, { status: 400 });
        }
      }

      // Load translations from Shopify for each sub-resource
      const translations: Record<string, Record<string, string>> = {};

      // Batch: load from local DB first (faster)
      const dbTranslations = await db.contentTranslation.findMany({
        where: {
          resourceId: { in: resourceIds },
          locale,
        },
      });

      for (const t of dbTranslations) {
        if (!translations[t.resourceId]) translations[t.resourceId] = {};
        translations[t.resourceId][t.key] = t.value;
      }

      // Also load from Shopify for any missing (in parallel, max 10 concurrent)
      const missingIds = resourceIds.filter(id => !translations[id]);
      if (missingIds.length > 0) {
        const dbWrites: Array<Promise<any>> = [];
        const batchSize = 10;
        for (let i = 0; i < missingIds.length; i += batchSize) {
          const batch = missingIds.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map(rid => shopifyContentService.loadTranslations(rid, locale))
          );
          results.forEach((result, idx) => {
            if (result.status === "fulfilled" && result.value) {
              const rid = batch[idx];
              if (!translations[rid]) translations[rid] = {};
              // Derive resourceType from GID (e.g. gid://shopify/ProductOption/123 → ProductOption)
              const gidMatch = rid.match(/gid:\/\/shopify\/(\w+)\//);
              const resourceType = gidMatch ? gidMatch[1] : "Unknown";
              for (const t of result.value) {
                translations[rid][t.key] = t.value;
                // Persist to DB so next navigation finds it via the loader pipeline
                dbWrites.push(
                  db.contentTranslation.upsert({
                    where: { resourceId_key_locale: { resourceId: rid, key: t.key, locale } },
                    create: { resourceId: rid, resourceType, key: t.key, value: t.value, locale },
                    update: { value: t.value },
                  })
                );
              }
            }
          });
        }
        // Fire DB writes in parallel (non-blocking for the response)
        if (dbWrites.length > 0) {
          await Promise.allSettled(dbWrites);
        }
      }

      return json({
        actionType: "loadSubResourceTranslations",
        success: true,
        translations,
      });
    } catch (error: unknown) {
      const msg = getFullErrorMessage(error);
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  // ============================================================================
  // SAVE SUB-RESOURCE TRANSLATIONS (Options + Metafields)
  // ============================================================================

  if (action === "saveSubResourceTranslations") {
    const locale = getFormString(formData, "locale");
    if (!locale || !isValidLocale(locale)) {
      return json({ success: false, error: "Invalid locale format" }, { status: 400 });
    }

    try {
      // translationsData format: { resourceId: { key: value } }
      const translationsDataJson = getFormString(formData, "translationsData");
      const translationsData: Record<string, Record<string, string>> = translationsDataJson
        ? JSON.parse(translationsDataJson) : {};

      const resourceTypesJson = getFormString(formData, "resourceTypes");
      const resourceTypes: Record<string, string> = resourceTypesJson
        ? JSON.parse(resourceTypesJson) : {};

      const savedResources: string[] = [];
      const failedResources: string[] = [];

      logger.info('[UnifiedContent] saveSubResourceTranslations - Starting save operation', {
        context: "UnifiedContent",
        locale,
        resourceCount: Object.keys(translationsData).length,
        translationsData: JSON.stringify(translationsData), // Log full data to see what's missing
        resourceIds: Object.keys(translationsData),
      });

      for (const [resourceId, fields] of Object.entries(translationsData)) {
        if (!isValidShopifyGID(resourceId)) continue;

        try {
          const resourceType = resourceTypes[resourceId] || "Unknown";

          // Separate empty and non-empty values
          // For ProductOption and ProductOptionValue, Shopify API rejects empty strings
          // ("Value can't be blank" / "Name can't be blank")
          // So we delete the translation instead of setting it to empty
          const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
          const keysToDelete: string[] = [];

          for (const [key, value] of Object.entries(fields)) {
            if (value === "" && (resourceType === "ProductOptionValue" || resourceType === "ProductOption")) {
              // Empty value for ProductOption/ProductOptionValue - delete the translation instead
              keysToDelete.push(key);
            } else {
              // Non-empty value OR empty value for other resource types
              translationInputs.push({ key, value, locale });
            }
          }

          logger.info(`[UnifiedContent] Saving translations for resource ${resourceId}`, {
            context: "UnifiedContent",
            resourceId,
            resourceType,
            locale,
            translationInputs: JSON.stringify(translationInputs),
            keysToDelete: JSON.stringify(keysToDelete),
          });

          // Save non-empty translations to Shopify
          if (translationInputs.length > 0) {
            await shopifyContentService.saveTranslations(resourceId, translationInputs);
          }

          // Delete empty translations for ProductOptionValue
          if (keysToDelete.length > 0) {
            await gateway.graphql(
              `#graphql
                mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                  translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                    userErrors { field message }
                  }
                }`,
              {
                variables: {
                  resourceId,
                  translationKeys: keysToDelete,
                  locales: [locale],
                },
              }
            );
            logger.info(`[UnifiedContent] Deleted translations for ${resourceId}`, {
              context: "UnifiedContent",
              resourceId,
              locale,
              keysToDelete: JSON.stringify(keysToDelete),
            });
          }

          // Save to local DB (including empty strings - user explicitly cleared the field)
          // This allows tracking that the field was intentionally cleared
          for (const [key, value] of Object.entries(fields)) {
            if (value === "" && (resourceType === "ProductOptionValue" || resourceType === "ProductOption")) {
              // For ProductOption/ProductOptionValue with empty value, delete from DB too
              // since there's no translation in Shopify (we removed it)
              await db.contentTranslation.deleteMany({
                where: { resourceId, key, locale },
              });
            } else {
              // For all other cases, save to DB
              await db.contentTranslation.upsert({
                where: { resourceId_key_locale: { resourceId, key, locale } },
                create: { resourceId, resourceType, key, value, locale },
                update: { value },
              });
            }
          }

          savedResources.push(resourceId);
          logger.info(`[UnifiedContent] Successfully saved translations for ${resourceId}`, {
            context: "UnifiedContent",
            resourceId,
            locale,
          });
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to save sub-resource translation for ${resourceId}`, {
            context: "UnifiedContent",
            resourceId,
            locale,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          failedResources.push(resourceId);
        }
      }

      logger.info('[UnifiedContent] saveSubResourceTranslations - Completed save operation', {
        context: "UnifiedContent",
        locale,
        savedCount: savedResources.length,
        failedCount: failedResources.length,
        savedResources,
        failedResources,
      });

      return json({
        actionType: "saveSubResourceTranslations",
        success: true,
        savedResources,
        failedResources,
      });
    } catch (error: unknown) {
      const msg = getFullErrorMessage(error);
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE SUB-RESOURCES (AI translate options + metafields)
  // ============================================================================

  if (action === "translateSubResources") {
    const targetLocale = getFormString(formData, "targetLocale");
    if (!targetLocale || !isValidLocale(targetLocale)) {
      return json({ success: false, error: "Invalid target locale" }, { status: 400 });
    }

    const sourceDataJson = getFormString(formData, "sourceData");
    const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> =
      sourceDataJson ? JSON.parse(sourceDataJson) : [];

    if (sourceData.length === 0) {
      return json({ actionType: "translateSubResources", success: true, translations: {} });
    }

    const primaryLocale = getFormString(formData, "primaryLocale") || "en";

    // Build a descriptive task title based on what's being translated
    const resourceLabels = sourceData.map(s => s.label).join(", ");
    const taskTitle = resourceLabels.length > 50
      ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
      : resourceLabels;

    // Create task entry for tracking
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "translation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: taskTitle,
        fieldType: "sub-resources",
        targetLocale,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      // Update task to queued (queue will update to running)
      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      // Create AI service with shop and taskId for queue management
      const aiService = new AIService(provider, serviceConfig, session.shop, task.id);

      // Group by small batches for AI translation
      const translations: Record<string, Record<string, string>> = {};
      const fieldsToTranslate: Record<string, string> = {};

      for (const item of sourceData) {
        fieldsToTranslate[`${item.resourceId}::${item.key}`] = item.value;
      }

      // Use batch translation: send all values at once
      const values = Object.values(fieldsToTranslate);
      const keys = Object.keys(fieldsToTranslate);

      if (values.length > 0) {
        const translatedValues = await aiService.translateBatchValues(
          values,
          primaryLocale,
          targetLocale,
          "product options and metafield values"
        );

        for (let i = 0; i < keys.length; i++) {
          const [resourceId, key] = keys[i].split("::");
          if (!translations[resourceId]) translations[resourceId] = {};
          translations[resourceId][key] = translatedValues[i] || values[i];
        }
      }

      // Update progress after translation
      await db.task.update({
        where: { id: task.id },
        data: { progress: 60 },
      });

      // Save translations to Shopify + DB
      const savedResources: string[] = [];
      const failedResources: string[] = [];

      for (const [resourceId, fields] of Object.entries(translations)) {
        try {
          // Build translation inputs (saveTranslations handles digest internally)
          const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
          for (const [key, value] of Object.entries(fields)) {
            translationInputs.push({ key, value, locale: targetLocale });
          }

          if (translationInputs.length > 0) {
            await shopifyContentService.saveTranslations(resourceId, translationInputs);
          }

          // Save to DB
          const sourceItem = sourceData.find(s => s.resourceId === resourceId);
          const resourceType = sourceItem?.resourceType || "Unknown";
          for (const [key, value] of Object.entries(fields)) {
            await db.contentTranslation.upsert({
              where: { resourceId_key_locale: { resourceId, key, locale: targetLocale } },
              create: { resourceId, resourceType, key, value, locale: targetLocale },
              update: { value },
            });
          }

          savedResources.push(resourceId);
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to translate sub-resource ${resourceId}`, {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
          failedResources.push(resourceId);
        }
      }

      // Update task to completed
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            translatedCount: savedResources.length,
            failedCount: failedResources.length,
            targetLocale,
          }),
        },
      });

      return json({
        actionType: "translateSubResources",
        success: true,
        translations,
        savedResources,
        failedResources,
        fieldId: getFormString(formData, "fieldId"), // Echo back fieldId for client state management
      });
    } catch (error: unknown) {
      // Update task to failed
      const msg = getFullErrorMessage(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: msg.substring(0, 1000),
        },
      });
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE SUB-RESOURCES TO ALL LOCALES (from primary language)
  // ============================================================================

  if (action === "translateSubResourceToAllLocales") {
    const sourceDataJson = getFormString(formData, "sourceData");
    const sourceData: Array<{ resourceId: string; resourceType: string; key: string; value: string; label: string }> =
      sourceDataJson ? JSON.parse(sourceDataJson) : [];

    if (sourceData.length === 0) {
      return json({ actionType: "translateSubResourceToAllLocales", success: true, translations: {} });
    }

    const primaryLocale = getFormString(formData, "primaryLocale") || "en";

    // Get target locales (all published foreign locales)
    const localesResponse = await gateway.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            primary
            published
          }
        }`
    );
    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const targetLocales = shopLocales
      .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
      .map((l: { locale: string }) => l.locale);

    if (targetLocales.length === 0) {
      return json({ actionType: "translateSubResourceToAllLocales", success: true, translations: {} });
    }

    // Build a descriptive task title
    const resourceLabels = sourceData.map(s => s.label).join(", ");
    const taskTitle = resourceLabels.length > 50
      ? `${sourceData.length} sub-resource${sourceData.length > 1 ? 's' : ''}`
      : resourceLabels;

    // Create task entry for tracking
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "bulkTranslation",
        status: "pending",
        resourceType: contentConfig.resourceType,
        resourceId: itemId,
        resourceTitle: taskTitle,
        fieldType: "sub-resources",
        targetLocale: targetLocales.join(","),
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    try {
      // Update task to queued
      await db.task.update({
        where: { id: task.id },
        data: { status: "queued", progress: 10 },
      });

      // Create AI service with shop and taskId for queue management
      const aiService = new AIService(provider, serviceConfig, session.shop, task.id);

      // Translate to each target locale
      const allTranslations: Record<string, Record<string, Record<string, string>>> = {}; // locale → resourceId → { key: value }
      const failedLocales: string[] = [];

      for (let localeIdx = 0; localeIdx < targetLocales.length; localeIdx++) {
        const targetLocale = targetLocales[localeIdx];

        try {
          const fieldsToTranslate: Record<string, string> = {};
          for (const item of sourceData) {
            fieldsToTranslate[`${item.resourceId}::${item.key}`] = item.value;
          }

          const values = Object.values(fieldsToTranslate);
          const keys = Object.keys(fieldsToTranslate);

          if (values.length > 0) {
            const translatedValues = await aiService.translateBatchValues(
              values,
              primaryLocale,
              targetLocale,
              "product options and metafield values"
            );

            const translations: Record<string, Record<string, string>> = {};
            for (let i = 0; i < keys.length; i++) {
              const [resourceId, key] = keys[i].split("::");
              if (!translations[resourceId]) translations[resourceId] = {};
              translations[resourceId][key] = translatedValues[i] || values[i];
            }

            allTranslations[targetLocale] = translations;

            // Update progress
            const progressPercent = Math.round(10 + ((localeIdx + 1) / targetLocales.length) * 50);
            await db.task.update({
              where: { id: task.id },
              data: { progress: progressPercent },
            });
          }
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to translate sub-resources to ${targetLocale}`, {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
          failedLocales.push(targetLocale);
        }
      }

      // Save all translations to Shopify + DB
      for (const [locale, translations] of Object.entries(allTranslations)) {
        for (const [resourceId, fields] of Object.entries(translations)) {
          try {
            const translationInputs: Array<{ key: string; value: string; locale: string }> = [];
            for (const [key, value] of Object.entries(fields)) {
              translationInputs.push({ key, value, locale });
            }

            if (translationInputs.length > 0) {
              await shopifyContentService.saveTranslations(resourceId, translationInputs);
            }

            // Save to DB
            const sourceItem = sourceData.find(s => s.resourceId === resourceId);
            const resourceType = sourceItem?.resourceType || "Unknown";
            for (const [key, value] of Object.entries(fields)) {
              await db.contentTranslation.upsert({
                where: { resourceId_key_locale: { resourceId, key, locale } },
                create: { resourceId, resourceType, key, value, locale },
                update: { value },
              });
            }
          } catch (err) {
            logger.error(`[UnifiedContent] Failed to save sub-resource translation for ${resourceId} in ${locale}`, {
              context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Update task to completed
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            translatedLocales: targetLocales.filter((l: string) => !failedLocales.includes(l)),
            failedLocales,
          }),
        },
      });

      // Return translations in the format expected by the hook (for current locale only - we return empty since already saved)
      return json({
        actionType: "translateSubResourceToAllLocales",
        success: true,
        translations: {}, // Already saved to Shopify, no need to return
        failedLocales,
        fieldId: getFormString(formData, "fieldId"), // Echo back fieldId for client state management
      });
    } catch (error: unknown) {
      const msg = getFullErrorMessage(error);
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: msg.substring(0, 1000),
        },
      });
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  // ============================================================================
  // SAVE PRIMARY SUB-RESOURCES (Options + Metafields - main language values)
  // ============================================================================

  if (action === "savePrimarySubResources") {
    const productId = getFormString(formData, "productId");

    if (!productId || !isValidShopifyGID(productId)) {
      return json({ success: false, error: "Invalid product ID" }, { status: 400 });
    }

    try {
      const optionsChangesJson = getFormString(formData, "optionsChanges");
      const metafieldChangesJson = getFormString(formData, "metafieldChanges");

      const optionsChanges: Record<string, { name?: string; valueUpdates?: { id: string; name: string }[] }> = optionsChangesJson
        ? JSON.parse(optionsChangesJson) : {};
      const metafieldChanges: Record<string, string> = metafieldChangesJson
        ? JSON.parse(metafieldChangesJson) : {};

      const { PRODUCT_OPTION_UPDATE, METAFIELDS_SET } = await import("~/graphql/content.mutations");

      const savedOptions: string[] = [];
      const failedOptions: string[] = [];
      const savedMetafields: string[] = [];
      const failedMetafields: string[] = [];

      // 1. Update option names and/or values using productOptionUpdate mutation
      for (const [optionId, changes] of Object.entries(optionsChanges)) {
        if (!isValidShopifyGID(optionId)) continue;

        const hasNameChange = changes.name !== undefined;
        const hasValueChanges = changes.valueUpdates && changes.valueUpdates.length > 0;

        if (!hasNameChange && !hasValueChanges) continue;

        try {
          const optionInput: { id: string; name?: string } = { id: optionId };
          if (hasNameChange) {
            optionInput.name = changes.name;
          }

          const variables: { productId: string; option: typeof optionInput; optionValuesToUpdate?: { id: string; name: string }[] } = {
            productId,
            option: optionInput,
          };

          if (hasValueChanges) {
            variables.optionValuesToUpdate = changes.valueUpdates;
          }

          const updateResponse = await gateway.graphql(
            PRODUCT_OPTION_UPDATE,
            { variables }
          );

          const updateData = await updateResponse.json();

          if (updateData.data?.productOptionUpdate?.userErrors?.length > 0) {
            logger.error("[UnifiedContent] productOptionUpdate userErrors", {
              context: "UnifiedContent", optionId, errors: updateData.data.productOptionUpdate.userErrors,
            });
            failedOptions.push(optionId);
          } else {
            savedOptions.push(optionId);
          }
        } catch (err) {
          logger.error(`[UnifiedContent] Failed to update option ${optionId}`, {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
          failedOptions.push(optionId);
        }
      }

      // 3. Update metafields using metafieldsSet mutation
      if (Object.keys(metafieldChanges).length > 0) {
        try {
          const metafieldsInput = Object.entries(metafieldChanges).map(([metafieldId, value]) => ({
            id: metafieldId,
            value,
          }));

          const metafieldsResponse = await gateway.graphql(
            METAFIELDS_SET,
            {
              variables: {
                metafields: metafieldsInput,
              },
            }
          );

          const metafieldsData = await metafieldsResponse.json();
          if (metafieldsData.data?.metafieldsSet?.userErrors?.length > 0) {
            logger.error("[UnifiedContent] metafieldsSet userErrors", {
              context: "UnifiedContent", errors: metafieldsData.data.metafieldsSet.userErrors,
            });
            Object.keys(metafieldChanges).forEach(mfId => failedMetafields.push(mfId));
          } else {
            Object.keys(metafieldChanges).forEach(mfId => savedMetafields.push(mfId));
          }
        } catch (err) {
          logger.error("[UnifiedContent] Failed to update metafields", {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
          Object.keys(metafieldChanges).forEach(mfId => failedMetafields.push(mfId));
        }
      }

      // 4. Delete translations for changed fields in all foreign languages
      const changedOptionIds = [...new Set([...savedOptions, ...Object.keys(optionsChanges)])];
      const changedMetafieldIds = [...new Set([...savedMetafields, ...Object.keys(metafieldChanges)])];

      if (changedOptionIds.length > 0 || changedMetafieldIds.length > 0) {
        try {
          // Get all shop locales
          const localesResponse = await gateway.graphql(
            `#graphql
              query getShopLocales {
                shopLocales {
                  locale
                  primary
                  published
                }
              }`
          );
          const localesData = await localesResponse.json();
          const shopLocales = localesData.data?.shopLocales || [];

          // Filter out the primary locale, only keep published foreign locales
          const foreignLocales = shopLocales
            .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
            .map((l: { locale: string }) => l.locale);

          if (foreignLocales.length > 0) {
            // Delete option translations
            for (const optionId of changedOptionIds) {
              if (!isValidShopifyGID(optionId)) continue;

              const changes = optionsChanges[optionId];

              try {
                // Only delete option name translation if the name was actually changed
                if (changes?.name !== undefined) {
                  await gateway.graphql(
                    `#graphql
                      mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                        translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                          userErrors { field message }
                        }
                      }`,
                    {
                      variables: {
                        resourceId: optionId,
                        translationKeys: ["name"],
                        locales: foreignLocales,
                      },
                    }
                  );

                  // Delete from DB
                  await db.contentTranslation.deleteMany({
                    where: {
                      resourceId: optionId,
                      resourceType: "ProductOption",
                      key: "name",
                      locale: { in: foreignLocales },
                    },
                  });
                }

                // Only delete translations for values that actually changed
                if (changes?.valueUpdates !== undefined && changes.valueUpdates.length > 0) {
                  // Use value IDs from the changes payload directly
                  for (const valueUpdate of changes.valueUpdates) {
                    if (!valueUpdate.id) continue;

                    await gateway.graphql(
                      `#graphql
                        mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                          translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                            userErrors { field message }
                          }
                        }`,
                      {
                        variables: {
                          resourceId: valueUpdate.id,
                          translationKeys: ["name"],
                          locales: foreignLocales,
                        },
                      }
                    );

                    await db.contentTranslation.deleteMany({
                      where: {
                        resourceId: valueUpdate.id,
                        resourceType: "ProductOptionValue",
                        key: "name",
                        locale: { in: foreignLocales },
                      },
                    });
                  }
                }
              } catch (err) {
                logger.error(`[UnifiedContent] Failed to delete translations for option ${optionId}`, {
                  context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // Delete metafield translations
            for (const metafieldId of changedMetafieldIds) {
              if (!isValidShopifyGID(metafieldId)) continue;

              try {
                await gateway.graphql(
                  `#graphql
                    mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
                      translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
                        userErrors { field message }
                      }
                    }`,
                  {
                    variables: {
                      resourceId: metafieldId,
                      translationKeys: ["value"],
                      locales: foreignLocales,
                    },
                  }
                );

                await db.contentTranslation.deleteMany({
                  where: {
                    resourceId: metafieldId,
                    resourceType: "Metafield",
                    key: "value",
                    locale: { in: foreignLocales },
                  },
                });
              } catch (err) {
                logger.error(`[UnifiedContent] Failed to delete translations for metafield ${metafieldId}`, {
                  context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        } catch (err) {
          logger.error("[UnifiedContent] Failed to delete translations for changed sub-resources", {
            context: "UnifiedContent", error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return json({
        actionType: "savePrimarySubResources",
        success: true,
        savedOptions,
        failedOptions,
        savedMetafields,
        failedMetafields,
      });
    } catch (error: unknown) {
      const msg = getFullErrorMessage(error);
      logger.error("[UnifiedContent] savePrimarySubResources error", {
        context: "UnifiedContent", error: msg,
      });
      return json({ success: false, error: msg }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

// ============================================================================
// METAOBJECT TRANSLATION HELPER
// ============================================================================

/**
 * Translate metaobject entries and save to Shopify + DB.
 * Each metaobject entry is a separate Shopify resource requiring its own digest.
 * Uses short keys (entry_0, entry_1, ...) for the AI prompt, then maps back to GIDs.
 */
async function translateMetaobjectEntries(params: {
  admin: AdminApiContext;
  session: Session;
  db: PrismaClient;
  itemId: string; // metaobject type ID
  metaobjectFields: Record<string, string>; // gid -> primary value
  targetLocales: string[];
  translationService: TranslationService;
  customInstructions?: string;
}): Promise<{ translations: Record<string, Record<string, string>>; failedLocales: string[] }> {
  const { admin, session, db, itemId, metaobjectFields, targetLocales, translationService, customInstructions } = params;
  const { TRANSLATE_CONTENT } = await import("../graphql/content.mutations");
  const { GET_TRANSLATABLE_CONTENT } = await import("../graphql/content.queries");

  // Build short-key mapping for cleaner AI prompts
  const gids = Object.keys(metaobjectFields);
  const gidToShort: Record<string, string> = {};
  const shortToGid: Record<string, string> = {};
  const shortFields: Record<string, string> = {};

  gids.forEach((gid, i) => {
    const short = `entry_${i}`;
    gidToShort[gid] = short;
    shortToGid[short] = gid;
    shortFields[short] = metaobjectFields[gid];
  });

  // AI translation (all entries × all locales in one request)
  const aiResult = await translationService.translateProduct(
    shortFields,
    targetLocales,
    "metaobject",
    customInstructions
  );

  // Map AI results back to GID keys
  const allTranslations: Record<string, Record<string, string>> = {};
  const failedLocales: string[] = [];

  for (const locale of targetLocales) {
    const localeResult = aiResult[locale];
    if (!localeResult || Object.keys(localeResult).length === 0) {
      failedLocales.push(locale);
      continue;
    }
    allTranslations[locale] = {};
    for (const [shortKey, value] of Object.entries(localeResult)) {
      const gid = shortToGid[shortKey];
      if (gid && value) {
        allTranslations[locale][gid] = String(value);
      }
    }
  }

  // Save translations to Shopify + DB for each metaobject × locale
  for (const [locale, fieldMap] of Object.entries(allTranslations)) {
    for (const [gid, translatedValue] of Object.entries(fieldMap)) {
      try {
        // Find label field key for this metaobject
        const moResponse = await admin.graphql(
          `#graphql
            query getMetaobject($id: ID!) {
              metaobject(id: $id) { fields { key type } }
            }`,
          { variables: { id: gid } }
        );
        const moData = await moResponse.json();
        const fields = moData.data?.metaobject?.fields || [];
        const labelField = findMetaobjectLabelField(fields);
        if (!labelField) continue;

        // Fetch digest
        const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
          variables: { resourceId: gid },
        });
        const digestData = await digestResponse.json();
        const tc = digestData.data?.translatableResource?.translatableContent || [];
        const digestEntry = tc.find((c: any) => c.key === labelField.key);
        if (!digestEntry?.digest) continue;

        // Register translation
        await admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId: gid,
            translations: [{
              key: labelField.key,
              value: translatedValue,
              locale,
              translatableContentDigest: digestEntry.digest,
            }],
          },
        });

        // Upsert DB
        await db.metaobjectTranslation.upsert({
          where: {
            shop_metaobjectId_key_locale: {
              shop: session.shop,
              metaobjectId: gid,
              key: labelField.key,
              locale,
            },
          },
          create: {
            shop: session.shop,
            metaobjectId: gid,
            type: itemId,
            key: labelField.key,
            value: translatedValue,
            locale,
            outdated: false,
          },
          update: {
            value: translatedValue,
            outdated: false,
            updatedAt: new Date(),
          },
        });
      } catch (err: any) {
        logger.error("[translateMetaobjectEntries] Error saving translation", {
          context: "Metaobjects",
          gid,
          locale,
          error: err.message,
        });
      }
    }
  }

  return { translations: allTranslations, failedLocales };
}

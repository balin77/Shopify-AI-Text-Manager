/**
 * Unified Content Actions
 *
 * Generic action handlers for all content types
 * Based on the products implementation with all bug fixes
 */

import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { AIService, toValidProvider } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import { sanitizeSlug } from "../utils/slug.utils";
import { tryDecryptApiKey } from "../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import type { ContentEditorConfig } from "../types/content-editor.types";
import { logger } from "../utils/logger.server";
import { ShopifyApiGateway } from "../services/shopify-api-gateway.service";
import { getFormString, getFormInt, getFormJSON } from "../utils/form-data.utils";
import { isValidShopifyGID, isValidLocale, safeJsonParse } from "../utils/validation";
import { sanitizePromptInput } from "../utils/prompt-sanitizer";
import { withUserInstruction } from "../utils/ai-user-instruction.server";
import { getFullErrorMessage } from "../utils/error-handler";
import { getInstructionWithDefault, getWritingStyleInstructions, getCharacterLimitRequirement } from "~/utils/ai-instructions.utils";
import { resolveSeoContext } from "../routes/api-ai-handlers/shared";
import { findMetaobjectLabelField } from "../constants/shopifyFields";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-api";
import type { PrismaClient } from "@prisma/client";
import type { AISettings, AIInstructions } from "@prisma/client";
import type { ContentActionHandlerContext } from "./content/alt-text.action";
import {
  handleGenerateAltText,
  handleGenerateAllAltTexts,
  handleTranslateAltText,
  handleTranslateAltTextToAllLocales,
  handleGenerateAltTextFromSku,
  handleSaveImageAltText,
  handleLoadImageAltTranslations,
} from "./content/alt-text.action";
import {
  handleTranslateField,
  handleTranslateAll,
  handleTranslateAllForLocale,
  handleTranslateFieldToAllLocales,
} from "./content/translation.action";
import { handleUpdateContent } from "./content/content-update.action";
import { handleCreateContent } from "./content/create.actions";
import {
  handleLoadSubResourceTranslations,
  handleSaveSubResourceTranslations,
  handleTranslateSubResources,
  handleTranslateSubResourceToAllLocales,
  handleSavePrimarySubResources,
} from "./content/sub-resources.action";

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
  const provider = toValidProvider(aiSettings?.preferredProvider || "claude");
  // Cast aiInstructions to indexable type for dynamic field access
  const instructions = aiInstructions as Record<string, string | null> | null;
  const serviceConfig = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };

  // Update queue rate limits from settings
  const { AIQueueService } = await import("../../src/services/ai-queue.service");
  const queue = AIQueueService.getInstance();
  await queue.updateRateLimits(aiSettings);

  const gateway = new ShopifyApiGateway(admin, session.shop);
  const shopifyContentService = new ShopifyContentService(gateway as any);

  // Resolve merchant SEO knobs (title cap + limits blob + translation mode)
  // in one place so every downstream handler sees the same numbers.
  const { seoTitleMaxChars, seoLimits, translationMode } = resolveSeoContext(aiSettings);

  // Shared context for extracted handler modules
  const ctx: ContentActionHandlerContext = {
    admin,
    session,
    contentConfig,
    db,
    aiSettings,
    aiInstructions,
    itemId: itemId || "",
    seoTitleMaxChars,
    seoLimits,
    translationMode,
    shopifyContentService,
    provider,
    serviceConfig,
  };

  // ── Delegate to extracted handlers ──────────────────────────────────────────
  switch (action) {
    case "translateField":                   return handleTranslateField(ctx, formData);
    case "translateAll":                     return handleTranslateAll(ctx, formData);
    case "translateAllForLocale":            return handleTranslateAllForLocale(ctx, formData);
    case "translateFieldToAllLocales":       return handleTranslateFieldToAllLocales(ctx, formData);
    case "updateContent":                    return handleUpdateContent(ctx, formData);
    case "generateAltText":                  return handleGenerateAltText(ctx, formData);
    case "generateAllAltTexts":              return handleGenerateAllAltTexts(ctx, formData);
    case "translateAltText":                 return handleTranslateAltText(ctx, formData);
    case "translateAltTextToAllLocales":     return handleTranslateAltTextToAllLocales(ctx, formData);
    case "generateAltTextFromSku":           return handleGenerateAltTextFromSku(ctx, formData);
    case "saveImageAltText":                 return handleSaveImageAltText(ctx, formData);
    case "loadImageAltTranslations":         return handleLoadImageAltTranslations(ctx, formData);
    case "loadSubResourceTranslations":      return handleLoadSubResourceTranslations(ctx, formData);
    case "saveSubResourceTranslations":      return handleSaveSubResourceTranslations(ctx, formData);
    case "translateSubResources":            return handleTranslateSubResources(ctx, formData);
    case "translateSubResourceToAllLocales": return handleTranslateSubResourceToAllLocales(ctx, formData);
    case "savePrimarySubResources":          return handleSavePrimarySubResources(ctx, formData);
    // PLAN_CONTENT_CREATION §1.5 — a CASE here, never a parallel route.
    // Note it is the one action that runs WITHOUT an itemId: the resource it
    // writes does not exist yet.
    case "createContent":                    return handleCreateContent(ctx, formData);
  }

  // ── Remaining inline actions (loadTranslations, generateAIText, formatAIText) ─

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
        const charLimit = getCharacterLimitRequirement(instructionsKey || "", { seoTitleMaxChars, limits: seoLimits });
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

        // Hard length override — placed last so it wins over any conflicting instruction above
        if (charLimit) {
          prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimit}. This overrides any other length or character count instruction in this prompt.`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the ${field.label}, nothing else. Output in ${mainLanguage}.`;
        // Merchant's per-request instruction — last word, outranks everything above.
        prompt = withUserInstruction(prompt, formData);
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
        const charLimitHtml = getCharacterLimitRequirement(instructionsKey || "", { seoTitleMaxChars, limits: seoLimits });
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

        // Hard length override — placed last so it wins over any conflicting instruction above
        if (charLimitHtml) {
          prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimitHtml}. This overrides any other length or character count instruction in this prompt.`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the ${field.label}, nothing else. Do NOT wrap the output in markdown code fences (\`\`\`). Output in ${mainLanguage}.`;
        // Merchant's per-request instruction — last word, outranks everything above.
        prompt = withUserInstruction(prompt, formData);
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

        prompt += `\n\nReturn ONLY the formatted HTML ${field.label}. Do NOT wrap the output in markdown code fences (\`\`\`). Keep the original language and all original content. Do NOT add new sentences or rewrite existing ones. Output the result in ${mainLanguage}.`;
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
  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

// The former METAOBJECT TRANSLATION HELPER (translateMetaobjectEntries) was a
// dead duplicate of the identical function in content/translation.action.ts
// (extracted there, never un-wired here). Removed in Phase 5 of the bulk
// editor as the first step of consolidating the metaobject translation write
// sites (docs/plans/PLAN_BULK_EDITOR.md §7). Remaining writers:
// content/translation.action.ts (AI translate) and api.metaobjects.$.tsx
// (single-editor save); the bulk editor writes exclusively through the
// verified registerAndVerify/removeAndVerify path (bulk-editor/
// translations.server.ts). Folding the two remaining writers onto that
// verified path is documented follow-up work.

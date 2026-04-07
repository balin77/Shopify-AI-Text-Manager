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
import type { ContentActionHandlerContext } from "./content/alt-text.action";
import {
  handleGenerateAltText,
  handleGenerateAllAltTexts,
  handleTranslateAltText,
  handleTranslateAltTextToAllLocales,
} from "./content/alt-text.action";
import {
  handleTranslateField,
  handleTranslateAll,
  handleTranslateAllForLocale,
  handleTranslateFieldToAllLocales,
} from "./content/translation.action";
import { handleUpdateContent } from "./content/content-update.action";
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

  // Effective SEO title limit (accounts for shop name suffix appended by Shopify)
  const seoTitleMaxChars = aiSettings?.seoTitleSuffixEnabled && aiSettings.seoTitleSuffix
    ? 60 - aiSettings.seoTitleSuffix.length
    : 60;

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
    case "loadSubResourceTranslations":      return handleLoadSubResourceTranslations(ctx, formData);
    case "saveSubResourceTranslations":      return handleSaveSubResourceTranslations(ctx, formData);
    case "translateSubResources":            return handleTranslateSubResources(ctx, formData);
    case "translateSubResourceToAllLocales": return handleTranslateSubResourceToAllLocales(ctx, formData);
    case "savePrimarySubResources":          return handleSavePrimarySubResources(ctx, formData);
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
        const charLimit = getCharacterLimitRequirement(instructionsKey || "", seoTitleMaxChars);
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
        const charLimitHtml = getCharacterLimitRequirement(instructionsKey || "", seoTitleMaxChars);
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

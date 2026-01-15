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
import type { ContentEditorConfig } from "../types/content-editor.types";

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
  const itemId = formData.get("itemId") as string;

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

    try {
      const field = contentConfig.fieldDefinitions.find((f) => f.key === fieldType);
      if (!field) {
        return json({ success: false, error: "Invalid field type" }, { status: 400 });
      }

      let generatedContent = "";

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

        prompt += `\n\nContext:\n${contextDescription || currentValue}\n\nReturn ONLY the ${field.label}, without explanations. Output the result in the main language of the content.`;
        generatedContent = await aiService.generateProductTitle(prompt);

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

        prompt += `\n\nCurrent Content:\n${currentValue}\n\nReturn ONLY the ${field.label}, without explanations. Output the result in the main language of the content.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
      }

      return json({ success: true, generatedContent, fieldType });
    } catch (error: any) {
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

    try {
      const field = contentConfig.fieldDefinitions.find((f) => f.key === fieldType);
      if (!field) {
        return json({ success: false, error: "Invalid field type" }, { status: 400 });
      }

      let formattedContent = "";

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

        prompt += `\n\nReturn ONLY the formatted ${field.label}, without explanations. Output the result in the main language of the content.`;
        formattedContent = await aiService.generateProductTitle(prompt);

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

        prompt += `\n\nKeep the content but format according to the guidelines. Return only the formatted text. Output the result in the main language of the content.`;
        formattedContent = await aiService.generateProductDescription(currentValue, prompt);
      }

      return json({ success: true, generatedContent: formattedContent, fieldType });
    } catch (error: any) {
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

    try {
      const changedFields: any = {};
      changedFields[fieldType] = sourceText;

      const translations = await translationService.translateProduct(changedFields, [targetLocale], contentConfig.contentType);
      const translatedValue = translations[targetLocale]?.[fieldType] || "";

      return json({ success: true, translatedValue, fieldType, targetLocale });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // TRANSLATE ALL
  // ============================================================================

  if (action === "translateAll") {
    try {
      const changedFields: any = {};
      const targetLocalesStr = formData.get("targetLocales") as string;

      // Collect all field values
      contentConfig.fieldDefinitions.forEach((field) => {
        const value = formData.get(field.key) as string;
        if (value) {
          changedFields[field.key] = value;
        }
      });

      if (Object.keys(changedFields).length === 0) {
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        fields: changedFields,
        translationService,
        db,
        targetLocales: targetLocalesStr ? JSON.parse(targetLocalesStr) : undefined,
        contentType: contentConfig.contentType,
      });

      return json({ success: true, translations: allTranslations });
    } catch (error: any) {
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

    try {
      const changedFields: any = {};
      changedFields[fieldType] = sourceText;

      if (!sourceText) {
        return json({ success: false, error: "No source text to translate" }, { status: 400 });
      }

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        fields: changedFields,
        translationService,
        db,
        targetLocales: targetLocalesStr ? JSON.parse(targetLocalesStr) : undefined,
        contentType: contentConfig.contentType,
      });

      return json({ success: true, translations: allTranslations, fieldType });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // ============================================================================
  // UPDATE CONTENT
  // ============================================================================

  if (action === "updateContent") {
    const locale = formData.get("locale") as string;
    const primaryLocale = formData.get("primaryLocale") as string;

    try {
      // Collect field updates
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

      // Use unified content service
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: contentConfig.resourceType as any,
        locale,
        primaryLocale,
        updates,
        db,
        shop: session.shop,
      });

      return json(result);
    } catch (error: any) {
      console.error(`[UNIFIED-CONTENT-UPDATE] Error:`, error);
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

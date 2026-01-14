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
import { decryptApiKey } from "../utils/encryption";
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
        let prompt = `Erstelle einen optimierten ${field.label}.`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nAnweisungen:\n${aiInstructions[instructionsTextKey]}`;
        }

        if (field.type === "slug") {
          prompt += `\n\nWICHTIG - Der URL-Slug MUSS diesem Format folgen:`;
          prompt += `\n- NUR Kleinbuchstaben (a-z)`;
          prompt += `\n- NUR Ziffern (0-9)`;
          prompt += `\n- NUR Bindestriche (-) als Trennzeichen`;
          prompt += `\n- KEINE Leerzeichen, KEINE Unterstriche, KEINE Sonderzeichen`;
          prompt += `\n- Umlaute MÜSSEN umgewandelt werden (ä→ae, ö→oe, ü→ue, ß→ss)`;
          prompt += `\n- 2-5 Wörter, durch Bindestriche getrennt`;
          prompt += `\n\nBeispiele:`;
          prompt += `\n- "Über Uns" → "ueber-uns"`;
          prompt += `\n- "Kontakt & Impressum" → "kontakt-impressum"`;
        }

        prompt += `\n\nKontext:\n${contextDescription || currentValue}\n\nGib nur den ${field.label} zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);

        if (field.type === "slug") {
          generatedContent = sanitizeSlug(generatedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        let prompt = `Erstelle einen optimierten ${field.label} für: ${contextTitle}`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nAnweisungen:\n${aiInstructions[instructionsTextKey]}`;
        }

        prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur den ${field.label} zurück, ohne Erklärungen.`;
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
        let prompt = `Formatiere den folgenden ${field.label} gemäß den Formatierungsrichtlinien:\n\nAktueller ${field.label}:\n${currentValue}`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions[instructionsTextKey]}`;
        }

        if (field.type === "slug") {
          prompt += `\n\nWICHTIG - Der URL-Slug MUSS diesem Format folgen:`;
          prompt += `\n- NUR Kleinbuchstaben (a-z), NUR Ziffern (0-9), NUR Bindestriche (-)`;
          prompt += `\n- Umlaute MÜSSEN umgewandelt werden (ä→ae, ö→oe, ü→ue, ß→ss)`;
        }

        prompt += `\n\nGib NUR den fertigen ${field.label} zurück, ohne Erklärungen.`;
        formattedContent = await aiService.generateProductTitle(prompt);

        if (field.type === "slug") {
          formattedContent = sanitizeSlug(formattedContent);
        }
      } else if (field.type === "html" || field.type === "textarea") {
        let prompt = `Formatiere den folgenden ${field.label} gemäß den Formatierungsrichtlinien:\n\nAktueller ${field.label}:\n${currentValue}`;

        if (aiInstructions?.[formatKey]) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions[formatKey]}`;
        }
        if (aiInstructions?.[instructionsTextKey]) {
          prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions[instructionsTextKey]}`;
        }

        prompt += `\n\nBehalte den Inhalt bei, formatiere aber gemäß den Richtlinien. Gib nur den formatierten Text zurück.`;
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

      const translations = await translationService.translateProduct(changedFields);
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
      });

      return json({ success: true, translations: allTranslations });
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

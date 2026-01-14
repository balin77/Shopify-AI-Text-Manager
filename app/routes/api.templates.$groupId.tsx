/**
 * API Route: Load theme content details for a specific group
 * Used for lazy loading when user clicks on a navigation item
 * Also handles updates to theme translations
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { decryptApiKey } from "../utils/encryption";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { groupId } = params;

  if (!groupId) {
    return json({ error: "groupId is required" }, { status: 400 });
  }

  try {
    const { db } = await import("../db.server");

    // OPTIMIZATION: Only load theme content, NOT translations
    // Translations will be loaded on-demand when user switches locale
    const themeGroups = await db.themeContent.findMany({
      where: {
        shop: session.shop,
        groupId: groupId
      }
    });

    if (themeGroups.length === 0) {
      return json({ error: "Group not found" }, { status: 404 });
    }

    // Merge all translatable content from all resources in this group
    const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);

    // DEDUPLICATION: Remove duplicate keys (same key can appear in multiple resources)
    const uniqueContent = new Map<string, any>();
    for (const item of allContent) {
      if (!uniqueContent.has(item.key)) {
        uniqueContent.set(item.key, item);
      }
    }
    const deduplicatedContent = Array.from(uniqueContent.values());

    console.log(`[API-TEMPLATES-LOADER] Group ${groupId}: ${allContent.length} total items, ${deduplicatedContent.length} unique keys`);

    // Get group metadata from first item
    const firstGroup = themeGroups[0];

    const themeData = {
      id: `group_${groupId}`,
      title: firstGroup.groupName,
      name: firstGroup.groupName,
      icon: firstGroup.groupIcon,
      groupId: groupId,
      role: 'THEME_GROUP',
      translatableContent: deduplicatedContent,
      contentCount: deduplicatedContent.length
    };

    console.log(`[API-TEMPLATES-LOADER] Loaded ${themeGroups.length} resources with ${allContent.length} translatable fields for group ${groupId}`);

    return json({ theme: themeData });
  } catch (error: any) {
    console.error(`[API-TEMPLATES] Error loading group ${groupId}:`, error);
    return json({ error: error.message }, { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { groupId } = params;

  if (!groupId) {
    return json({ error: "groupId is required" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const actionType = formData.get("action") as string;

    const { db } = await import("../db.server");

    // Load group data
    const themeGroups = await db.themeContent.findMany({
      where: {
        shop: session.shop,
        groupId: groupId
      }
    });

    if (themeGroups.length === 0) {
      return json({ error: "Group not found" }, { status: 404 });
    }

    const firstGroup = themeGroups[0];
    const resourceId = firstGroup.resourceId;

    switch (actionType) {
      case "loadTranslations": {
        const locale = formData.get("locale") as string;

        console.log(`[API-TEMPLATES-ACTION] 🔍 Loading translations for:`, {
          shop: session.shop,
          groupId,
          locale
        });

        // OPTIMIZATION: Load translations from database (lazy loading)
        // This is much faster than fetching from Shopify API
        const translations = await db.themeTranslation.findMany({
          where: {
            shop: session.shop,
            groupId: groupId,
            locale: locale
          }
        });

        console.log(`[API-TEMPLATES-ACTION] ✅ Loaded ${translations.length} translations for locale ${locale} from database`);

        if (translations.length > 0) {
          console.log(`[API-TEMPLATES-ACTION] Sample translation keys:`, translations.slice(0, 3).map(t => t.key));
        } else {
          console.log(`[API-TEMPLATES-ACTION] ⚠️  NO TRANSLATIONS FOUND! This means:`);
          console.log(`  - Either no sync has been run for this locale`);
          console.log(`  - Or translations don't exist in Shopify for this group`);
          console.log(`  - Run a content sync to populate translations`);
        }

        return json({
          success: true,
          translations,
          locale
        });
      }

      case "generateAIText": {
        const fieldKey = formData.get("fieldKey") as string;
        const currentValue = formData.get("currentValue") as string;

        // Load AI settings from database
        const { db } = await import("../db.server");
        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          settings?.preferredProvider as any || 'huggingface',
          {
            huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
            geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
            claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
            openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
            grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
            deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
          }
        );

        const prompt = `Improve or generate content for this field: ${fieldKey}
Current value: ${currentValue}
Context: ${firstGroup.groupName}

Please provide improved content that is clear and concise.`;

        const generatedContent = await aiService['askAI'](prompt);

        return json({
          success: true,
          generatedContent,
          fieldKey
        });
      }

      case "translateField": {
        const fieldKey = formData.get("fieldKey") as string;
        const sourceText = formData.get("sourceText") as string;
        const targetLocale = formData.get("targetLocale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;

        if (!sourceText) {
          return json({
            success: false,
            error: "No source text available"
          }, { status: 400 });
        }

        // Load AI settings from database
        const { db } = await import("../db.server");
        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          settings?.preferredProvider as any || 'huggingface',
          {
            huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
            geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
            claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
            openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
            grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
            deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
          }
        );

        const translatedValue = await aiService.translateContent(
          sourceText,
          primaryLocale,
          targetLocale
        );

        return json({
          success: true,
          translatedValue,
          fieldKey
        });
      }

      case "translateAll": {
        const primaryLocale = formData.get("primaryLocale") as string;
        const targetLocale = formData.get("targetLocale") as string;

        // Get all translatable content
        const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);

        // DEDUPLICATION: Remove duplicate keys before translation
        const uniqueContent = new Map<string, any>();
        for (const item of allContent) {
          if (!uniqueContent.has(item.key)) {
            uniqueContent.set(item.key, item);
          }
        }

        // Collect all fields to translate
        const fieldsToTranslate: Record<string, string> = {};
        for (const item of uniqueContent.values()) {
          if (item.value) {
            fieldsToTranslate[item.key] = item.value;
          }
        }

        // Load AI settings from database
        const { db } = await import("../db.server");
        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          settings?.preferredProvider as any || 'huggingface',
          {
            huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
            geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
            claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
            openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
            grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
            deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
          }
        );

        // Translate all fields
        const translatedFields: Record<string, string> = {};
        for (const [key, text] of Object.entries(fieldsToTranslate)) {
          try {
            const translated = await aiService.translateContent(
              text,
              primaryLocale,
              targetLocale
            );
            translatedFields[key] = translated;
          } catch (error) {
            console.error(`Error translating field ${key}:`, error);
            translatedFields[key] = text; // Fallback to original
          }
        }

        return json({
          success: true,
          translatedFields
        });
      }

      case "updateContent": {
        const locale = formData.get("locale") as string;
        const primaryLocale = formData.get("primaryLocale") as string;
        const updatedFieldsJson = formData.get("updatedFields") as string;
        const updatedFields = JSON.parse(updatedFieldsJson);

        // STEP 1: Register translations with Shopify FIRST
        const translationInputs = Object.entries(updatedFields).map(([key, value]) => ({
          key,
          value: value as string,
          locale,
          translatableContentDigest: ""
        }));

        if (translationInputs.length > 0) {
          const response = await admin.graphql(TRANSLATE_CONTENT, {
            variables: {
              resourceId,
              translations: translationInputs
            }
          });

          const data = await response.json();

          // Check for errors from Shopify
          if (data.data?.translationsRegister?.userErrors?.length > 0) {
            const errors = data.data.translationsRegister.userErrors;
            console.error("Shopify translation errors:", errors);
            return json({
              success: false,
              error: `Shopify error: ${errors[0].message}`
            }, { status: 500 });
          }
        }

        // STEP 2: Only update database if Shopify succeeded
        if (locale === primaryLocale) {
          // Update primary locale: Update translatableContent in ThemeContent
          for (const group of themeGroups) {
            const content = group.translatableContent as any[];
            let hasChanges = false;

            for (const item of content) {
              if (updatedFields[item.key] !== undefined) {
                item.value = updatedFields[item.key];
                hasChanges = true;
              }
            }

            if (hasChanges) {
              await db.themeContent.update({
                where: {
                  shop_resourceId_groupId: {
                    shop: session.shop,
                    resourceId: group.resourceId,
                    groupId: groupId
                  }
                },
                data: {
                  translatableContent: content,
                  lastSyncedAt: new Date()
                }
              });
            }
          }

          return json({ success: true });
        } else {
          // Update translation: Use ThemeTranslation table
          for (const [key, value] of Object.entries(updatedFields)) {
            await db.themeTranslation.upsert({
              where: {
                shop_resourceId_groupId_key_locale: {
                  shop: session.shop,
                  resourceId: resourceId,
                  groupId: groupId,
                  key: key,
                  locale: locale
                }
              },
              update: {
                value: value as string,
                updatedAt: new Date()
              },
              create: {
                shop: session.shop,
                groupId: groupId,
                resourceId: resourceId,
                locale: locale,
                key: key,
                value: value as string
              }
            });
          }

          return json({ success: true });
        }
      }

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: any) {
    console.error(`[API-TEMPLATES-ACTION] Error:`, error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};

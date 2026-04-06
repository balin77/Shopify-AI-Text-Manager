/**
 * API Route: Load theme content details for a specific group
 * Uses splat route ($) so groupIds containing slashes (e.g. "sections/header-group") work correctly.
 * Used for lazy loading when user clicks on a navigation item
 * Also handles updates to theme translations
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService, type AIProvider, toValidProvider } from "../../src/services/ai.service";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { decryptApiKey } from "../utils/encryption.server";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";

/** Shape of individual items within ThemeContent.translatableContent JSON array */
interface TranslatableField {
  key: string;
  value?: string;
  digest?: string;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const groupId = params["*"];

  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  // Parse and validate pagination parameters from URL
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const search = url.searchParams.get("search") || "";

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
      return json({ success: false, error: "Group not found" }, { status: 404 });
    }

    // Merge all translatable content from all resources in this group
    const allContent = themeGroups.flatMap((group) => (group.translatableContent as unknown) as TranslatableField[]);

    // DEDUPLICATION: Remove duplicate keys (same key can appear in multiple resources)
    const uniqueContent = new Map<string, TranslatableField>();
    for (const item of allContent) {
      if (!uniqueContent.has(item.key)) {
        uniqueContent.set(item.key, item);
      }
    }
    let deduplicatedContent = Array.from(uniqueContent.values());

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      deduplicatedContent = deduplicatedContent.filter((item) =>
        item.key.toLowerCase().includes(searchLower) ||
        (item.value && item.value.toLowerCase().includes(searchLower))
      );
    }

    // Calculate pagination
    const totalCount = deduplicatedContent.length;
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const paginatedContent = deduplicatedContent.slice(startIndex, startIndex + limit);

    logger.debug("[API-TEMPLATES-LOADER] Group content loaded", { context: "Templates", groupId, totalCount, page, totalPages, itemsShown: paginatedContent.length });

    // Get group metadata from first item
    const firstGroup = themeGroups[0];

    const themeData = {
      id: `group_${groupId}`,
      title: firstGroup.groupName,
      name: firstGroup.groupName,
      icon: firstGroup.groupIcon,
      groupId: groupId,
      role: 'THEME_GROUP',
      translatableContent: paginatedContent,
      contentCount: totalCount,
      // Pagination metadata
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      }
    };

    logger.debug("[API-TEMPLATES-LOADER] Loaded resources with translatable fields", { context: "Templates", resourceCount: themeGroups.length, fieldsCount: allContent.length, groupId });

    return json({ theme: themeData }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("[API-TEMPLATES] Error loading group", { context: "Templates", groupId, error: msg, stack });
    return json({ success: false, error: "Failed to load theme group." }, { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const groupId = params["*"];

  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const actionType = getFormString(formData, "action");

    const { db } = await import("../db.server");

    // Load group data
    const themeGroups = await db.themeContent.findMany({
      where: {
        shop: session.shop,
        groupId: groupId
      }
    });

    if (themeGroups.length === 0) {
      return json({ success: false, error: "Group not found" }, { status: 404 });
    }

    const firstGroup = themeGroups[0];
    const resourceId = firstGroup.resourceId;

    switch (actionType) {
      case "loadTranslations": {
        const locale = getFormString(formData, "locale");

        logger.debug("[API-TEMPLATES-ACTION] Loading translations", { context: "Templates", shop: session.shop, groupId, locale });

        // OPTIMIZATION: Load translations from database (lazy loading)
        // This is much faster than fetching from Shopify API
        const translations = await db.themeTranslation.findMany({
          where: {
            shop: session.shop,
            groupId: groupId,
            locale: locale
          }
        });

        logger.debug("[API-TEMPLATES-ACTION] Loaded translations from database", { context: "Templates", count: translations.length, locale });

        if (translations.length > 0) {
          logger.debug("[API-TEMPLATES-ACTION] Sample translation keys", { context: "Templates", sampleKeys: translations.slice(0, 3).map(t => t.key) });
        } else {
          logger.warn("[API-TEMPLATES-ACTION] NO TRANSLATIONS FOUND - Either no sync has been run for this locale, or translations don't exist in Shopify for this group", { context: "Templates", groupId, locale });
        }

        return json({
          success: true,
          translations,
          locale
        });
      }

      case "generateAIText": {
        const fieldKey = getFormString(formData, "fieldKey");
        const currentValue = getFormString(formData, "currentValue");

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          toValidProvider(settings?.preferredProvider),
          {
            huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
            geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
            claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
            openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
            grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
            deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
          }
        );

        const prompt = `Improve the following template field content.

Field: ${fieldKey}
Current value: ${currentValue}
Context: ${firstGroup.groupName}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content.`;

        const generatedContent = await aiService['askAI'](prompt);

        return json({
          success: true,
          generatedContent,
          fieldKey
        });
      }

      case "translateField": {
        const fieldKey = getFormString(formData, "fieldKey");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocale = getFormString(formData, "primaryLocale");

        if (!sourceText) {
          return json({
            success: false,
            error: "No source text available"
          }, { status: 400 });
        }

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          toValidProvider(settings?.preferredProvider),
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
            logger.error("Error translating field", { context: "Templates", key, error: error instanceof Error ? error.message : String(error) });
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
        const updatedFields = safeJsonParse<Record<string, string>>(updatedFieldsJson, {});

        // Parse changedFields if present (for translation deletion when primary locale changes)
        const changedFieldsStr = formData.get("changedFields") as string;
        const changedFields = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : [];

        // STEP 1: Register translations with Shopify (only for foreign locales)
        // Shopify's translationsRegister does NOT accept the shop's primary locale
        if (locale !== primaryLocale) {
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
              logger.error("Shopify translation errors", { context: "Templates", errors });
              return json({
                success: false,
                error: `Shopify error: ${errors[0].message}`
              }, { status: 500 });
            }
          }
        }

        // STEP 2: Update local database
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

          // STEP 3: Delete translations for changed fields (they are now outdated)
          if (changedFields.length > 0) {
            logger.debug("[API-TEMPLATES-ACTION] Deleting translations for changed fields", { context: "Templates", changedFields });

            await db.themeTranslation.deleteMany({
              where: {
                shop: session.shop,
                groupId: groupId,
                key: { in: changedFields }
              }
            });

            logger.debug("[API-TEMPLATES-ACTION] Translations deleted for keys", { context: "Templates", keys: changedFields });
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[API-TEMPLATES-ACTION] Error", { context: "Templates", error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json({ success: false, error: "Template operation failed" }, { status: 500 });
  }
};

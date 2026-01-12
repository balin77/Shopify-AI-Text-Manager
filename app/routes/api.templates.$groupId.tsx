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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { groupId } = params;

  if (!groupId) {
    return json({ error: "groupId is required" }, { status: 400 });
  }

  try {
    const { db } = await import("../db.server");

    // Load theme content and translations for this specific group
    const [themeGroups, themeTranslations] = await Promise.all([
      db.themeContent.findMany({
        where: {
          shop: session.shop,
          groupId: groupId
        }
      }),
      db.themeTranslation.findMany({
        where: {
          shop: session.shop,
          groupId: groupId
        }
      })
    ]);

    if (themeGroups.length === 0) {
      return json({ error: "Group not found" }, { status: 404 });
    }

    // Group translations by resourceId
    const translationsByResource: Record<string, any[]> = {};
    for (const trans of themeTranslations) {
      const key = trans.resourceId;
      if (!translationsByResource[key]) {
        translationsByResource[key] = [];
      }
      translationsByResource[key].push(trans);
    }

    // Merge all translatable content from all resources in this group
    const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);
    const allTranslations = themeGroups.flatMap((group) =>
      translationsByResource[group.resourceId] || []
    );

    // Get group metadata from first item
    const firstGroup = themeGroups[0];

    const themeData = {
      id: `group_${groupId}`,
      title: firstGroup.groupName,
      name: firstGroup.groupName,
      icon: firstGroup.groupIcon,
      groupId: groupId,
      role: 'THEME_GROUP',
      translatableContent: allContent,
      translations: allTranslations,
      contentCount: allContent.length
    };

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

        const translations = await db.themeTranslation.findMany({
          where: {
            shop: session.shop,
            groupId: groupId,
            locale: locale
          }
        });

        return json({
          success: true,
          translations,
          locale
        });
      }

      case "generateAIText": {
        const fieldKey = formData.get("fieldKey") as string;
        const currentValue = formData.get("currentValue") as string;

        const generatedContent = await AIService.generateText({
          fieldType: fieldKey,
          currentValue,
          context: { groupName: firstGroup.groupName }
        });

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

        const translatedValue = await TranslationService.translateText({
          text: sourceText,
          sourceLocale: primaryLocale,
          targetLocale
        });

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

        // Collect all fields to translate
        const fieldsToTranslate: Record<string, string> = {};
        for (const item of allContent) {
          if (item.value) {
            fieldsToTranslate[item.key] = item.value;
          }
        }

        // Translate all fields
        const translatedFields: Record<string, string> = {};
        for (const [key, text] of Object.entries(fieldsToTranslate)) {
          try {
            const translated = await TranslationService.translateText({
              text,
              sourceLocale: primaryLocale,
              targetLocale
            });
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
                  shop_resourceId: {
                    shop: session.shop,
                    resourceId: group.resourceId
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
                shop_groupId_locale_key: {
                  shop: session.shop,
                  groupId: groupId,
                  locale: locale,
                  key: key
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

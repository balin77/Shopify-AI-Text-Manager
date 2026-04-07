/**
 * API Route: Load metaobject content details for a specific type
 * Uses splat route ($) so type IDs containing special characters work correctly.
 * Used for lazy loading when user clicks on a navigation item
 * Also handles updates to metaobject translations
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService, type AIProvider, toValidProvider } from "../../src/services/ai.service";
import { TRANSLATE_CONTENT, METAOBJECT_UPDATE } from "../graphql/content.mutations";
import { decryptApiKey } from "../utils/encryption.server";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";
import { isMetaobjectLabelField, findMetaobjectLabelField } from "~/constants/shopifyFields";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const typeId = params["*"];

  if (!typeId) {
    return json({ success: false, error: "typeId is required" }, { status: 400 });
  }

  // Parse and validate pagination parameters from URL
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const search = url.searchParams.get("search") || "";

  try {
    const { db } = await import("../db.server");

    // Load metaobject definition from DB
    const definition = await db.metaobjectDefinition.findUnique({
      where: {
        shop_type: {
          shop: session.shop,
          type: typeId
        }
      }
    });

    if (!definition) {
      return json({ success: false, error: "Metaobject type not found" }, { status: 404 });
    }

    // Fetch metaobjects for this type from DB
    let metaobjects = await db.metaobject.findMany({
      where: {
        shop: session.shop,
        type: typeId
      },
      orderBy: {
        displayName: 'asc'
      }
    });

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      metaobjects = metaobjects.filter((m) =>
        m.displayName?.toLowerCase().includes(searchLower) ||
        m.handle?.toLowerCase().includes(searchLower)
      );
    }

    // Calculate pagination
    const totalCount = metaobjects.length;
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const paginatedMetaobjects = metaobjects.slice(startIndex, startIndex + limit);

    // Load translations for paginated metaobjects from DB
    const metaobjectIds = paginatedMetaobjects.map(m => m.id);
    const translations = await db.metaobjectTranslation.findMany({
      where: {
        shop: session.shop,
        metaobjectId: { in: metaobjectIds }
      }
    });

    // Format metaobjects with DB data
    const formattedMetaobjects = paginatedMetaobjects.map((metaobj) => ({
      id: metaobj.id,
      handle: metaobj.handle,
      displayName: metaobj.displayName,
      type: metaobj.type,
      updatedAt: metaobj.shopifyUpdatedAt.toISOString(),
      fields: metaobj.fields as any,
    }));

    // Format translations for UI
    const translationsArray = translations.map(t => ({
      key: t.metaobjectId, // Use metaobject ID as translation key
      value: t.value,
      locale: t.locale,
    }));

    logger.debug("[API-METAOBJECTS-LOADER] Metaobjects loaded from DB", {
      context: "Metaobjects",
      typeId,
      totalCount,
      page,
      totalPages,
      itemsShown: paginatedMetaobjects.length,
      translationsCount: translationsArray.length
    });

    // Build response with paginated metaobjects and translations
    const metaobjectData = {
      id: `metaobject_type_${typeId}`,
      type: typeId,
      title: definition.name,
      handle: typeId,
      definitionName: definition.name,
      definitionId: definition.id,
      role: 'METAOBJECT_TYPE',
      metaobjects: formattedMetaobjects,
      translations: translationsArray, // Include translations from DB
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

    return json({ success: true, metaobject: metaobjectData }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("[API-METAOBJECTS] Error loading type", { context: "Metaobjects", typeId, error: msg, stack });
    return json({ success: false, error: "Failed to load metaobject type." }, { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const typeId = params["*"];

  if (!typeId) {
    return json({ success: false, error: "typeId is required" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const actionType = getFormString(formData, "action");

    const { db } = await import("../db.server");

    switch (actionType) {
      case "loadTranslations": {
        const locale = getFormString(formData, "locale");
        const metaobjectId = getFormString(formData, "metaobjectId");

        if (!metaobjectId) {
          return json({ success: false, error: "metaobjectId is required" }, { status: 400 });
        }

        logger.debug("[API-METAOBJECTS-ACTION] Loading translations", {
          context: "Metaobjects",
          shop: session.shop,
          typeId,
          metaobjectId,
          locale
        });

        // Load translations from Shopify API
        const translationsResponse = await admin.graphql(
          `#graphql
            query getMetaobjectTranslations($resourceId: ID!, $locale: String!) {
              translatableResource(resourceId: $resourceId) {
                resourceId
                translations(locale: $locale) {
                  key
                  value
                  locale
                }
              }
            }`,
          {
            variables: {
              resourceId: metaobjectId,
              locale: locale
            }
          }
        );

        const transData = (await translationsResponse.json()) as any;
        if (transData.errors) {
          logger.error("[API-METAOBJECTS] GraphQL error loading translations", {
            context: "Metaobjects", metaobjectId, locale, errors: transData.errors
          });
          return json({ success: false, error: "GraphQL error loading translations" }, { status: 502 });
        }
        const translations = transData.data?.translatableResource?.translations || [];

        // Filter to only display_name/name/label translations
        const filteredTranslations = translations
          .filter((t: any) => isMetaobjectLabelField(t.key))
          .map((t: any) => ({
            key: metaobjectId, // Use metaobject ID as key (matches field definition)
            value: t.value,
            locale: t.locale
          }));

        logger.debug("[API-METAOBJECTS-ACTION] Loaded translations", {
          context: "Metaobjects",
          count: filteredTranslations.length,
          locale
        });

        return json({
          success: true,
          translations: filteredTranslations,
          locale
        });
      }

      case "translateField": {
        const metaobjectId = getFormString(formData, "metaobjectId");
        const sourceText = getFormString(formData, "sourceText");
        const targetLocale = getFormString(formData, "targetLocale");
        const primaryLocale = getFormString(formData, "primaryLocale");

        if (!metaobjectId || !sourceText) {
          return json({
            success: false,
            error: "Missing required parameters"
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
          metaobjectId
        });
      }

      case "updateContent": {
        const locale = getFormString(formData, "locale");
        const primaryLocale = getFormString(formData, "primaryLocale");
        const metaobjectId = getFormString(formData, "metaobjectId");
        const updatedValue = getFormString(formData, "updatedValue");

        if (!metaobjectId) {
          return json({ success: false, error: "metaobjectId is required" }, { status: 400 });
        }

        logger.debug("[API-METAOBJECTS-ACTION] Updating content", {
          context: "Metaobjects",
          metaobjectId,
          locale,
          primaryLocale
        });

        // Determine which field to update (display_name, name, or label)
        // Query the metaobject to find which field it has
        const metaobjectResponse = await admin.graphql(
          `#graphql
            query getMetaobject($id: ID!) {
              metaobject(id: $id) {
                id
                fields {
                  key
                  type
                }
              }
            }`,
          { variables: { id: metaobjectId } }
        );

        const metaobjectData = (await metaobjectResponse.json()) as any;
        if (metaobjectData.errors) {
          logger.error("[API-METAOBJECTS] GraphQL error fetching metaobject fields", {
            context: "Metaobjects", metaobjectId, errors: metaobjectData.errors
          });
          return json({ success: false, error: "GraphQL error fetching metaobject" }, { status: 502 });
        }
        const fields = metaobjectData.data?.metaobject?.fields || [];

        // Find the label field (display_name, name, or label)
        const labelField = findMetaobjectLabelField(fields);

        if (!labelField) {
          return json({
            success: false,
            error: "No label field found in metaobject"
          }, { status: 400 });
        }

        if (locale === primaryLocale) {
          // Update primary locale: Update metaobject field directly in Shopify
          const updateResponse = await admin.graphql(METAOBJECT_UPDATE, {
            variables: {
              id: metaobjectId,
              metaobject: {
                fields: [
                  {
                    key: labelField.key,
                    value: updatedValue
                  }
                ]
              }
            }
          });

          const updateData = await updateResponse.json();

          if (updateData.data?.metaobjectUpdate?.userErrors?.length > 0) {
            const errors = updateData.data.metaobjectUpdate.userErrors;
            logger.error("Shopify metaobject update errors", { context: "Metaobjects", errors });
            return json({
              success: false,
              error: `Shopify error: ${errors[0].message}`
            }, { status: 500 });
          }

          // Update DB: Update displayName field
          await db.metaobject.update({
            where: {
              shop_id: {
                shop: session.shop,
                id: metaobjectId
              }
            },
            data: {
              displayName: updatedValue,
              lastSyncedAt: new Date()
            }
          });

          logger.info("[API-METAOBJECTS] Primary locale updated in Shopify and DB", {
            context: "Metaobjects",
            metaobjectId,
            locale
          });

          return json({ success: true });
        } else {
          // Update translation: Use translationsRegister
          const translationResponse = await admin.graphql(TRANSLATE_CONTENT, {
            variables: {
              resourceId: metaobjectId,
              translations: [
                {
                  key: labelField.key,
                  value: updatedValue,
                  locale: locale,
                  translatableContentDigest: ""
                }
              ]
            }
          });

          const translationData = await translationResponse.json();

          if (translationData.data?.translationsRegister?.userErrors?.length > 0) {
            const errors = translationData.data.translationsRegister.userErrors;
            logger.error("Shopify translation errors", { context: "Metaobjects", errors });
            return json({
              success: false,
              error: `Shopify error: ${errors[0].message}`
            }, { status: 500 });
          }

          // Update DB: Upsert translation
          await db.metaobjectTranslation.upsert({
            where: {
              shop_metaobjectId_key_locale: {
                shop: session.shop,
                metaobjectId,
                key: labelField.key,
                locale
              }
            },
            create: {
              shop: session.shop,
              metaobjectId,
              type: typeId,
              key: labelField.key,
              value: updatedValue,
              locale,
              outdated: false
            },
            update: {
              value: updatedValue,
              outdated: false,
              updatedAt: new Date()
            }
          });

          logger.info("[API-METAOBJECTS] Translation updated in Shopify and DB", {
            context: "Metaobjects",
            metaobjectId,
            locale,
            key: labelField.key
          });

          return json({ success: true });
        }
      }

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: unknown) {
    logger.error("[API-METAOBJECTS-ACTION] Error", {
      context: "Metaobjects",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ success: false, error: "Metaobject operation failed" }, { status: 500 });
  }
};

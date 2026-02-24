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

    // Load metaobject definition to get type name
    const { ContentService } = await import("../services/content.service");
    const contentService = new ContentService(admin);
    const definitions = await contentService.getMetaobjectDefinitions(50);
    const definition = definitions.find(d => d.type === typeId);

    if (!definition) {
      return json({ success: false, error: "Metaobject type not found" }, { status: 404 });
    }

    // Fetch metaobjects for this type
    const response = await admin.graphql(
      `#graphql
        query getMetaobjectsWithFields($type: String!, $first: Int!) {
          metaobjects(type: $type, first: $first) {
            edges {
              node {
                id
                handle
                displayName
                type
                updatedAt
                fields {
                  key
                  value
                  type
                }
              }
            }
          }
        }`,
      {
        variables: { type: typeId, first: 250 }
      }
    );
    const data = await response.json();

    if (data.errors) {
      logger.error('[API-METAOBJECTS-LOADER] GraphQL errors', {
        type: typeId,
        errors: data.errors
      });
      return json({ success: false, error: "Failed to load metaobjects" }, { status: 500 });
    }

    const metaobjects = data.data?.metaobjects?.edges?.map((edge: { node: any }) => edge.node) || [];

    // Apply search filter if provided
    let filteredMetaobjects = metaobjects;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredMetaobjects = metaobjects.filter((m: any) =>
        m.displayName?.toLowerCase().includes(searchLower) ||
        m.handle?.toLowerCase().includes(searchLower)
      );
    }

    // Calculate pagination
    const totalCount = filteredMetaobjects.length;
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const paginatedMetaobjects = filteredMetaobjects.slice(startIndex, startIndex + limit);

    logger.debug("[API-METAOBJECTS-LOADER] Metaobjects loaded", {
      context: "Metaobjects",
      typeId,
      totalCount,
      page,
      totalPages,
      itemsShown: paginatedMetaobjects.length
    });

    // Load shop locales for translation loading
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            primary
          }
        }`
    );
    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const locales = shopLocales.map((l: any) => l.locale);

    // Load translations for all paginated metaobjects
    const translationsArray: any[] = [];
    for (const metaobj of paginatedMetaobjects) {
      for (const locale of locales) {
        try {
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
                resourceId: metaobj.id,
                locale: locale
              }
            }
          );

          const transData = await translationsResponse.json();
          if (transData.errors) continue;

          const translations = transData.data?.translatableResource?.translations || [];

          // Only include display_name/name/label translations
          translations.forEach((trans: any) => {
            if (trans.key === 'display_name' || trans.key === 'name' || trans.key === 'label') {
              translationsArray.push({
                key: metaobj.id, // Use metaobject ID as translation key
                value: trans.value,
                locale: trans.locale,
              });
            }
          });
        } catch (transError) {
          // Silently skip if translations not available
          continue;
        }
      }
    }

    logger.debug("[API-METAOBJECTS-LOADER] Translations loaded", {
      context: "Metaobjects",
      typeId,
      translationsCount: translationsArray.length,
      sampleTranslations: translationsArray.slice(0, 3)
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
      metaobjects: paginatedMetaobjects,
      translations: translationsArray, // Include translations
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

    return json({ metaobject: metaobjectData }, { headers: { "Cache-Control": "no-store" } });
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

        const transData = await translationsResponse.json();
        const translations = transData.data?.translatableResource?.translations || [];

        // Filter to only display_name/name/label translations
        const filteredTranslations = translations
          .filter((t: any) => t.key === 'display_name' || t.key === 'name' || t.key === 'label')
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

        const metaobjectData = await metaobjectResponse.json();
        const fields = metaobjectData.data?.metaobject?.fields || [];

        // Find the label field (display_name, name, or label)
        const labelField = fields.find((f: any) =>
          f.key === 'display_name' || f.key === 'name' || f.key === 'label'
        );

        if (!labelField) {
          return json({
            success: false,
            error: "No label field found in metaobject"
          }, { status: 400 });
        }

        if (locale === primaryLocale) {
          // Update primary locale: Update metaobject field directly
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

          return json({ success: true });
        }
      }

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: any) {
    logger.error("[API-METAOBJECTS-ACTION] Error", {
      context: "Metaobjects",
      error: error.message,
      stack: error.stack
    });
    return json({ success: false, error: "Metaobject operation failed" }, { status: 500 });
  }
};

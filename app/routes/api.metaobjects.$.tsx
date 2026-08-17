/**
 * API Route: Load metaobject content details for a specific type
 * Uses splat route ($) so type IDs containing special characters work correctly.
 * Used for lazy loading when user clicks on a navigation item
 * Also handles updates to metaobject translations
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { AIService, type AIProvider, toValidProvider } from "../../src/services/ai.service";
import { TRANSLATE_CONTENT, METAOBJECT_UPDATE, REMOVE_TRANSLATIONS } from "../graphql/content.mutations";
import { GET_TRANSLATABLE_CONTENT, GET_SHOP_LOCALES } from "../graphql/content.queries";
import { tryDecryptApiKey } from "../utils/encryption.server";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse, isValidLocale } from "~/utils/validation";
import { logger } from "~/utils/logger.server";
import { isMetaobjectLabelField, findMetaobjectLabelField } from "~/constants/shopifyFields";

// R3-M8: shape of GET_TRANSLATABLE_CONTENT so the digest hot-path is typed
// instead of `as any` + `(c: any) => …` (an undefined `key`/`digest` would
// otherwise pass the compiler and only fail at runtime under load).
interface TranslatableContentEntry {
  key: string;
  digest: string | null;
}
interface GetTranslatableContentResponse {
  data?: { translatableResource?: { translatableContent?: TranslatableContentEntry[] } };
  errors?: unknown;
}

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

    // Format translations for UI. Global rows (marketId "") feed the per-item
    // `translations` array exactly as before; market-specific rows are surfaced
    // as `marketTranslations` so resolve() can layer them over the global value.
    // Metaobject translations are keyed by metaobjectId (that is the field's
    // translationKey in the editor), so the market lookup is
    //   marketTranslations[marketId][metaobjectId][locale].
    const translationsArray = translations
      .filter(t => (t.marketId ?? "") === "")
      .map(t => ({
        key: t.metaobjectId, // Use metaobject ID as translation key
        value: t.value,
        locale: t.locale,
      }));
    const marketTranslations: Record<string, Record<string, Record<string, string>>> = {};
    for (const t of translations) {
      if ((t.marketId ?? "") === "") continue;
      const byKey = (marketTranslations[t.marketId] ??= {});
      const byLocale = (byKey[t.metaobjectId] ??= {});
      byLocale[t.locale] = t.value;
    }

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
      translations: translationsArray, // Include translations from DB (global rows)
      marketTranslations, // Market-specific rows: [marketId][metaobjectId][locale]
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

        if (!isValidLocale(locale)) {
          return json({ success: false, error: `Invalid locale: ${locale}` }, { status: 400 });
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

        if (!isValidLocale(targetLocale) || !isValidLocale(primaryLocale)) {
          return json({ success: false, error: "Invalid locale" }, { status: 400 });
        }

        const settings = await db.aISettings.findUnique({
          where: { shop: session.shop }
        });

        const aiService = new AIService(
          toValidProvider(settings?.preferredProvider),
          {
            huggingfaceApiKey: tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface") || undefined,
            geminiApiKey: tryDecryptApiKey(settings?.geminiApiKey, "gemini") || undefined,
            claudeApiKey: tryDecryptApiKey(settings?.claudeApiKey, "claude") || undefined,
            openaiApiKey: tryDecryptApiKey(settings?.openaiApiKey, "openai") || undefined,
            grokApiKey: tryDecryptApiKey(settings?.grokApiKey, "grok") || undefined,
            deepseekApiKey: tryDecryptApiKey(settings?.deepseekApiKey, "deepseek") || undefined,
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
        // Market scope for market-specific translations (foreign locales only).
        const marketId = locale !== primaryLocale ? getFormString(formData, "marketId") : "";

        if (!metaobjectId) {
          return json({ success: false, error: "metaobjectId is required" }, { status: 400 });
        }

        if (!isValidLocale(locale)) {
          return json({ success: false, error: `Invalid locale: ${locale}` }, { status: 400 });
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

          // Update DB: mirror the new value into the `fields` blob, NOT just
          // displayName. The editor's getFieldValue reads labelField.value from
          // `fields`, so updating only displayName leaves the UI showing the
          // stale value until a full re-sync re-fetches from Shopify.
          const existing = await db.metaobject.findUnique({
            where: { shop_id: { shop: session.shop, id: metaobjectId } },
            select: { fields: true },
          });
          const existingFields = Array.isArray(existing?.fields)
            ? (existing!.fields as Array<{ key: string; value: string | null; type: string }>)
            : [];
          const nextFields = existingFields.map((f) =>
            f.key === labelField.key ? { ...f, value: updatedValue } : f
          );
          await db.metaobject.update({
            where: {
              shop_id: {
                shop: session.shop,
                id: metaobjectId
              }
            },
            data: {
              displayName: updatedValue,
              fields: nextFields,
              lastSyncedAt: new Date()
            }
          });

          // Primary content changed → its foreign translations are now stale.
          // Remove them on Shopify AND locally, mirroring the products /
          // collections / templates routes. Without this, outdated translations
          // linger in every foreign locale until the merchant re-translates.
          const localesResponse = await admin.graphql(GET_SHOP_LOCALES);
          const localesData = (await localesResponse.json()) as any;
          const foreignLocales: string[] = (localesData.data?.shopLocales || [])
            .filter((l: { primary: boolean; published: boolean }) => !l.primary && l.published)
            .map((l: { locale: string }) => l.locale);

          if (foreignLocales.length > 0) {
            try {
              const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
                variables: {
                  resourceId: metaobjectId,
                  translationKeys: [labelField.key],
                  locales: foreignLocales,
                },
              });
              const removeData = (await removeResponse.json()) as any;
              if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
                // Non-fatal: the primary save already succeeded.
                logger.warn("[API-METAOBJECTS] translationsRemove errors on primary change", {
                  context: "Metaobjects",
                  metaobjectId,
                  errors: removeData.data.translationsRemove.userErrors,
                });
              }

              // Only mirror the removal into the DB after the Shopify call
              // returned. If it threw (network), we skip the local purge so the
              // DB does not diverge from Shopify (a re-sync would just restore
              // the still-present Shopify translation anyway).
              await db.metaobjectTranslation.deleteMany({
                where: {
                  shop: session.shop,
                  metaobjectId,
                  key: labelField.key,
                  // Global only — mirror the global-only Shopify removal so market
                  // overrides survive on both sides (no divergence).
                  marketId: "",
                  locale: { in: foreignLocales },
                },
              });
            } catch (removeErr: unknown) {
              logger.warn("[API-METAOBJECTS] translationsRemove failed on primary change (non-fatal)", {
                context: "Metaobjects",
                metaobjectId,
                error: removeErr instanceof Error ? removeErr.message : String(removeErr),
              });
            }
          }

          logger.info("[API-METAOBJECTS] Primary locale updated in Shopify and DB", {
            context: "Metaobjects",
            metaobjectId,
            locale
          });

          return json({ success: true });
        } else {
          // Update translation: Use translationsRegister.
          // Shopify rejects a translation whose `translatableContentDigest`
          // does not match the current source content, so the digest MUST be
          // fetched first — sending "" makes Shopify discard the call while
          // the DB upsert below would still mark it "translated" (silent
          // divergence). Mirrors the pattern in translation.action.ts.
          const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
            variables: { resourceId: metaobjectId }
          });
          const digestData = (await digestResponse.json()) as GetTranslatableContentResponse;
          if (digestData.errors) {
            logger.error("[API-METAOBJECTS] GraphQL error loading digest", {
              context: "Metaobjects", metaobjectId, locale, errors: digestData.errors
            });
            return json({ success: false, error: "GraphQL error loading translation digest" }, { status: 502 });
          }
          const translatableContent = digestData.data?.translatableResource?.translatableContent ?? [];
          const digestEntry = translatableContent.find((c) => c.key === labelField.key);
          if (!digestEntry?.digest) {
            logger.error("[API-METAOBJECTS] Missing translatableContentDigest", {
              context: "Metaobjects", metaobjectId, locale, key: labelField.key
            });
            return json({
              success: false,
              error: "Could not resolve translation digest for this field"
            }, { status: 502 });
          }

          const translationResponse = await admin.graphql(TRANSLATE_CONTENT, {
            variables: {
              resourceId: metaobjectId,
              translations: [
                {
                  key: labelField.key,
                  value: updatedValue,
                  locale: locale,
                  translatableContentDigest: digestEntry.digest,
                  ...(marketId ? { marketId } : {}),
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

          // Update DB: Upsert translation (market-scoped)
          await db.metaobjectTranslation.upsert({
            where: {
              shop_metaobjectId_key_locale_marketId: {
                shop: session.shop,
                metaobjectId,
                key: labelField.key,
                locale,
                marketId,
              }
            },
            create: {
              shop: session.shop,
              metaobjectId,
              type: typeId,
              key: labelField.key,
              value: updatedValue,
              locale,
              outdated: false,
              marketId,
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
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[API-METAOBJECTS-ACTION] Error", {
      context: "Metaobjects",
      error: msg,
      stack: error instanceof Error ? error.stack : undefined
    });
    return json({ success: false, error: "Metaobject operation failed" }, { status: 500 });
  }
};

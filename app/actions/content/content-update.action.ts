/**
 * Content Update Action Handler
 *
 * Extracted from unified-content.actions.ts
 * Handles: updateContent
 */

import { json } from "@remix-run/node";
import { sanitizeSlug } from "../../utils/slug.utils";
import { logger } from "../../utils/logger.server";
import { getFormString } from "../../utils/form-data.utils";
import { isValidShopifyGID, safeJsonParse } from "../../utils/validation";
import { getFullErrorMessage } from "../../utils/error-handler";
import { findMetaobjectLabelField } from "../../constants/shopifyFields";
import type { ContentActionHandlerContext } from "./alt-text.action";

// ============================================================================
// UPDATE CONTENT
// ============================================================================

export async function handleUpdateContent(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<Response> {
  const { admin, session, contentConfig, db, itemId, shopifyContentService } = ctx;

  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const changedFieldsDebug = getFormString(formData, "changedFields");

  logger.debug('[UnifiedContent] updateContent', { resourceType: contentConfig.resourceType, itemId, locale, primaryLocale });

  try {
    // Special handling for Products - use dedicated product update handler
    if (contentConfig.resourceType === "Product") {
      const { handleUpdateProduct } = await import("../product/update.actions");
      const { prepareActionContext } = await import("../product/shared/action-context");

      // Prepare context for product update
      const context = await prepareActionContext(admin, session);

      // Map unified field names to product-specific names
      const productFormData = new FormData();
      productFormData.set("action", "updateProduct");
      productFormData.set("productId", itemId);
      productFormData.set("locale", locale);
      productFormData.set("primaryLocale", primaryLocale);

      // Map field names
      const fieldMapping: Record<string, string> = {
        title: "title",
        description: "descriptionHtml",
        handle: "handle",
        seoTitle: "seoTitle",
        metaDescription: "metaDescription",
        productType: "productType",
      };

      // Only forward fields that were actually sent by the client.
      // buildFieldsForSave only includes changed fields for foreign locales,
      // so absent fields mean "not changed" — NOT "clear this field".
      // Using formData.has() preserves empty strings (user cleared the field)
      // while skipping fields the client never sent.
      contentConfig.fieldDefinitions.forEach((field) => {
        if (!formData.has(field.key)) return;
        const value = getFormString(formData, field.key);
        const productFieldName = fieldMapping[field.key] || field.key;
        productFormData.set(productFieldName, value);
      });

      // Pass changedFields for translation deletion when primary locale changes
      const changedFieldsStr = getFormString(formData, "changedFields");
      if (changedFieldsStr && locale === primaryLocale) {
        productFormData.set("changedFields", changedFieldsStr);
      }

      // Pass imageAltTexts if present
      const imageAltTextsStr = getFormString(formData, "imageAltTexts");
      if (imageAltTextsStr) {
        productFormData.set("imageAltTexts", imageAltTextsStr);
      }

      // Pass changedAltTextIndices for alt-text translation deletion when primary locale changes
      const changedAltTextIndicesStr = getFormString(formData, "changedAltTextIndices");
      if (changedAltTextIndicesStr && locale === primaryLocale) {
        productFormData.set("changedAltTextIndices", changedAltTextIndicesStr);
      }

      const productResult = await handleUpdateProduct(context, productFormData, itemId);
      // Inject actionType into the response for discriminated union matching
      const productBody = await productResult.json();
      return json({ ...productBody, actionType: "updateContent" }, { status: productResult.status });
    }

    // Special handling for Metaobjects
    // Each field key is a metaobject ID (gid://shopify/Metaobject/...).
    // We iterate over all changed fields and update each metaobject individually.
    if (contentConfig.resourceType === "Metaobject") {
      const { METAOBJECT_UPDATE, TRANSLATE_CONTENT, REMOVE_TRANSLATIONS } = await import("../../graphql/content.mutations");
      const { GET_TRANSLATABLE_CONTENT, GET_SHOP_LOCALES } = await import("../../graphql/content.queries");

      // Foreign locales are only needed when saving the primary locale (to purge
      // stale translations after the source content changed). Fetch once and
      // cache across the update loop instead of per metaobject.
      let foreignLocalesCache: string[] | null = null;
      const getForeignLocales = async (): Promise<string[]> => {
        if (foreignLocalesCache) return foreignLocalesCache;
        const localesResponse = await admin.graphql(GET_SHOP_LOCALES);
        const localesData = await localesResponse.json();
        foreignLocalesCache = (localesData.data?.shopLocales || [])
          .filter((l: { primary: boolean; published: boolean }) => !l.primary && l.published)
          .map((l: { locale: string }) => l.locale);
        return foreignLocalesCache!;
      };

      // Collect changed metaobject fields from formData
      const metaobjectUpdates: Array<{ id: string; value: string }> = [];
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("gid://shopify/Metaobject/")) {
          metaobjectUpdates.push({ id: key, value: String(value) });
        }
      }

      if (metaobjectUpdates.length === 0) {
        return json({ success: true, actionType: "updateContent" });
      }

      // Block empty primary-locale fields (same protection as templates)
      if (locale === primaryLocale) {
        const emptyEntries = metaobjectUpdates.filter(u => u.value.trim() === "");
        if (emptyEntries.length > 0) {
          logger.warn("[UnifiedContent] Blocked metaobject save — empty primary-locale fields", {
            context: "Metaobjects",
            locale,
            emptyIds: emptyEntries.map(e => e.id),
          });
          return json({
            success: false,
            errorKey: "emptyPrimaryFieldsError",
          }, { status: 400 });
        }
      }

      const errors: string[] = [];

      for (const update of metaobjectUpdates) {
        try {
          // Query metaobject to find the label field key
          const metaobjectResponse = await admin.graphql(
            `#graphql
              query getMetaobject($id: ID!) {
                metaobject(id: $id) {
                  id
                  fields { key type }
                }
              }`,
            { variables: { id: update.id } }
          );
          const metaobjectData = await metaobjectResponse.json();
          const fields = metaobjectData.data?.metaobject?.fields || [];
          const labelField = findMetaobjectLabelField(fields);

          if (!labelField) {
            errors.push(`No label field found for ${update.id}`);
            continue;
          }

          if (locale === primaryLocale) {
            // Update metaobject field directly
            const updateResponse = await admin.graphql(METAOBJECT_UPDATE, {
              variables: {
                id: update.id,
                metaobject: {
                  fields: [{ key: labelField.key, value: update.value }]
                }
              }
            });
            const updateData = await updateResponse.json();
            if (updateData.data?.metaobjectUpdate?.userErrors?.length > 0) {
              errors.push(updateData.data.metaobjectUpdate.userErrors[0].message);
            } else {
              // Mirror the new primary value into the DB `fields` blob, NOT just
              // displayName. The editor's getFieldValue reads labelField.value
              // from `fields`, so updating only displayName leaves the UI showing
              // the stale value until a full re-sync re-fetches from Shopify.
              const existing = await db.metaobject.findUnique({
                where: { shop_id: { shop: session.shop, id: update.id } },
                select: { fields: true },
              });
              const existingFields = Array.isArray(existing?.fields)
                ? (existing!.fields as Array<{ key: string; value: string | null; type: string }>)
                : [];
              const nextFields = existingFields.map((f) =>
                f.key === labelField.key ? { ...f, value: update.value } : f
              );
              await db.metaobject.update({
                where: { shop_id: { shop: session.shop, id: update.id } },
                data: { displayName: update.value, fields: nextFields, lastSyncedAt: new Date() }
              });

              // Primary content changed → its foreign translations are now stale.
              // Remove them on Shopify AND locally, mirroring the products /
              // collections / templates routes. Without this, outdated translations
              // linger in every foreign locale until the merchant re-translates.
              const foreignLocales = await getForeignLocales();
              if (foreignLocales.length > 0) {
                try {
                  const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
                    variables: {
                      resourceId: update.id,
                      translationKeys: [labelField.key],
                      locales: foreignLocales,
                    },
                  });
                  const removeData = await removeResponse.json();
                  if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
                    // Non-fatal: the primary save already succeeded.
                    logger.warn("[UnifiedContent] translationsRemove errors on metaobject primary change", {
                      context: "Metaobjects",
                      id: update.id,
                      errors: removeData.data.translationsRemove.userErrors,
                    });
                  }

                  // Only mirror the removal into the DB after the Shopify call
                  // returned. If it threw (network), we skip the local purge so
                  // the DB does not diverge from Shopify (a re-sync would just
                  // restore the still-present Shopify translation anyway).
                  await db.metaobjectTranslation.deleteMany({
                    where: {
                      shop: session.shop,
                      metaobjectId: update.id,
                      key: labelField.key,
                      locale: { in: foreignLocales },
                    },
                  });
                } catch (removeErr: any) {
                  logger.warn("[UnifiedContent] translationsRemove failed on metaobject primary change (non-fatal)", {
                    context: "Metaobjects",
                    id: update.id,
                    error: removeErr?.message,
                  });
                }
              }
            }
          } else if (update.value.trim() === "") {
            // Empty value in foreign locale → remove the translation
            const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
              variables: {
                resourceId: update.id,
                translationKeys: [labelField.key],
                locales: [locale]
              }
            });
            const removeData = await removeResponse.json();
            if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
              errors.push(removeData.data.translationsRemove.userErrors[0].message);
            } else {
              // Remove from DB
              await db.metaobjectTranslation.deleteMany({
                where: {
                  shop: session.shop,
                  metaobjectId: update.id,
                  key: labelField.key,
                  locale
                }
              });
            }
          } else {
            // Non-empty value in foreign locale → fetch digest then register translation
            const digestResponse = await admin.graphql(GET_TRANSLATABLE_CONTENT, {
              variables: { resourceId: update.id }
            });
            const digestData = await digestResponse.json();
            const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
            const digestEntry = translatableContent.find((c: any) => c.key === labelField.key);

            if (!digestEntry?.digest) {
              errors.push(`No digest found for ${update.id} field ${labelField.key}`);
              continue;
            }

            const translationResponse = await admin.graphql(TRANSLATE_CONTENT, {
              variables: {
                resourceId: update.id,
                translations: [{
                  key: labelField.key,
                  value: update.value,
                  locale,
                  translatableContentDigest: digestEntry.digest
                }]
              }
            });
            const translationData = await translationResponse.json();
            if (translationData.data?.translationsRegister?.userErrors?.length > 0) {
              errors.push(translationData.data.translationsRegister.userErrors[0].message);
            } else {
              // Update DB translation
              const typeId = itemId; // itemId is the metaobject type ID
              await db.metaobjectTranslation.upsert({
                where: {
                  shop_metaobjectId_key_locale: {
                    shop: session.shop,
                    metaobjectId: update.id,
                    key: labelField.key,
                    locale
                  }
                },
                create: {
                  shop: session.shop,
                  metaobjectId: update.id,
                  type: typeId,
                  key: labelField.key,
                  value: update.value,
                  locale,
                  outdated: false
                },
                update: {
                  value: update.value,
                  outdated: false,
                  updatedAt: new Date()
                }
              });
            }
          }
        } catch (err: any) {
          errors.push(`${update.id}: ${err.message}`);
        }
      }

      if (errors.length > 0) {
        logger.error("[UnifiedContent] Metaobject update errors", { context: "Metaobjects", errors });
        return json({
          success: false,
          error: `Some updates failed: ${errors.join("; ")}`,
          actionType: "updateContent"
        }, { status: 500 });
      }

      logger.info("[UnifiedContent] Metaobjects updated successfully", {
        context: "Metaobjects",
        count: metaobjectUpdates.length,
        locale
      });

      return json({ success: true, actionType: "updateContent" });
    }

    // For other content types (Collections, Pages, Blogs, Policies), use unified service
    // Determine the actual resource type — for blogs, the config says "Article" but
    // Blog container items have GIDs like gid://shopify/Blog/123.
    const effectiveResourceType = itemId.includes("/Blog/") ? "Blog" : contentConfig.resourceType;

    // Only include fields that were actually sent by the client.
    // buildFieldsForSave only includes changed fields for foreign locales,
    // so absent fields mean "not changed" — NOT "clear this field".
    // Use the full field definitions list (covers both Blog and Article fields for dynamic configs).
    const allFieldDefs = contentConfig.fieldDefinitions;
    const updates: Record<string, string> = {};
    allFieldDefs.forEach((field) => {
      if (!formData.has(field.key)) return;
      let value = getFormString(formData, field.key);

      // Sanitize slug fields
      if (field.type === "slug" && value) {
        value = sanitizeSlug(value);
        if (!value) {
          throw new Error("Invalid URL slug: Handle must contain at least one alphanumeric character");
        }
      }

      updates[field.key] = value;
    });

    // Handle featured image alt text for Collections and Blogs
    if (contentConfig.resourceType === "Collection" || contentConfig.resourceType === "Article") {
      const imageAltTextsStr = getFormString(formData, "imageAltTexts");
      if (imageAltTextsStr) {
        try {
          const imageAltTexts = JSON.parse(imageAltTextsStr) as string[];
          // Featured image alt text is at index 0
          if (imageAltTexts[0] !== undefined) {
            updates.imageAltText = imageAltTexts[0];
          }
        } catch (e) {
          logger.error('Failed to parse imageAltTexts:', e);
        }
      }
    }

    // Get changed fields (for translation deletion when saving primary locale)
    const changedFieldsStr = getFormString(formData, "changedFields");
    const changedFields: string[] | undefined = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : undefined;

    // Extract policyType for ShopPolicy primary locale updates
    const policyType = contentConfig.resourceType === "ShopPolicy"
      ? getFormString(formData, "policyType") || undefined
      : undefined;

    // Use unified content service
    const result = await shopifyContentService.updateContent({
      resourceId: itemId,
      resourceType: effectiveResourceType,
      locale,
      primaryLocale,
      updates,
      db,
      shop: session.shop,
      policyType,
      changedFields: locale === primaryLocale ? changedFields : undefined, // Only pass for primary locale
    });

    return json({ ...result, actionType: "updateContent" });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    logger.error('Unified content update error', {
      context: 'UnifiedContent',
      action: 'updateContent',
      itemId,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined
    });
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

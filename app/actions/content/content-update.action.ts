/**
 * Content Update Action Handler
 *
 * Extracted from unified-content.actions.ts
 * Handles: updateContent
 */

import { data as json } from "react-router";
import { sanitizeSlug } from "../../utils/slug.utils";
import { logger } from "../../utils/logger.server";
import { getFormString } from "../../utils/form-data.utils";
import { isValidShopifyGID, safeJsonParse } from "../../utils/validation";
import { getFullErrorMessage } from "../../utils/error-handler";
import { findMetaobjectLabelField } from "../../constants/shopifyFields";
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";
import { readDataPayload, readDataStatus } from "~/utils/data-response";
import {
  normalizeHandle,
  redirectResourceFor,
  resolveRedirectPreference,
} from "~/services/seo/handle-redirect.shared";
import type { HandleRedirectNoteCode } from "~/services/seo/handle-redirect.server";

/** What the client needs to phrase the redirect outcome in its own language. */
interface HandleRedirectNote {
  code: HandleRedirectNoteCode;
  fromPath?: string;
}

// ============================================================================
// UPDATE CONTENT
// ============================================================================

export async function handleUpdateContent(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, itemId, shopifyContentService } = ctx;

  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const changedFieldsDebug = getFormString(formData, "changedFields");
  // Market scope for market-specific ("Translate & Adapt") translations.
  // Primary-locale saves are always global — Shopify forbids market-specific
  // primary content — so the marketId only applies to foreign-locale saves.
  const marketId = locale !== primaryLocale ? getFormString(formData, "marketId") : "";

  logger.debug('[UnifiedContent] updateContent', { resourceType: contentConfig.resourceType, itemId, locale, primaryLocale });

  // ── PLAN §Phase 3.3 / §A1 — a handle change breaks the old URL ───────────
  // Read BEFORE the write, because afterwards the old handle is gone and with
  // it any chance of preserving the address it served. Only for the primary
  // locale: a translated handle is a different URL and a different question.
  // The per-save form field wins where it is sent, so a future per-edit
  // checkbox needs no server change; otherwise the shop's preference decides.
  const wantsHandleRedirect = resolveRedirectPreference(
    getFormString(formData, "createHandleRedirect"),
    ctx.aiSettings?.seoAutoHandleRedirect,
  );
  // The SANITIZED handle, because that is the one that reaches Shopify: both
  // write paths below run it through `sanitizeSlug` first (this handler for the
  // generic types, handleUpdateProduct for products). Redirecting to the raw
  // input would point the old URL at a 404 — "My Handle!" is stored as
  // "my-handle" — which is worse than not redirecting at all. An empty result
  // means the input was unusable; that save throws further down anyway.
  const submittedHandle = sanitizeSlug(getFormString(formData, "handle"));
  const redirectResource = redirectResourceFor(contentConfig.resourceType, itemId);
  // A PRIMARY save carries every field, changed or not (buildFieldsForSave only
  // filters for foreign locales), so `handle` is present on practically every
  // save. Everything below therefore has to be cheap in the common case: the
  // cache read happens only when a redirect could actually come of it, and the
  // blog lookup only once the handle is known to have changed.
  //
  // ONE pre-save snapshot serves BOTH features that need to know what the item
  // looked like before: the handle redirect (§3.3) and the IndexNow enqueue
  // (§3.4). Reading it twice would be two queries for the same row.
  const isPrimarySave = locale === primaryLocale;
  const beforeSave =
    isPrimarySave && redirectResource
      ? // A blog CONTAINER has no cache model, so its old handle is fetched
        // live — the same one call `loadBlogHandle` already makes for articles.
        redirectResource === "blog"
        ? { handle: await loadBlogHandle(admin, itemId), isPublished: null }
        : await loadCachedSnapshot(db, session.shop, contentConfig.resourceType, itemId)
      : null;
  const previousHandle = wantsHandleRedirect ? beforeSave?.handle ?? null : null;
  const handleChanged =
    !!previousHandle && !!submittedHandle && normalizeHandle(previousHandle) !== normalizeHandle(submittedHandle);

  /**
   * §Phase 3.4 / §A2 — pages, articles and blogs have NO Shopify webhook, so
   * this save is the only moment anything can tell IndexNow that a URL went
   * live, went away, or moved. Products and collections are covered by their
   * own webhooks and are deliberately not repeated here.
   *
   * Never throws (see `enqueuePublishChange`): the save already happened.
   */
  const finishIndexNow = async (storedHandle?: string | null): Promise<void> => {
    if (!isPrimarySave || !beforeSave) return;
    const resource =
      redirectResource === "page" || redirectResource === "article" || redirectResource === "blog"
        ? redirectResource
        : null;
    if (!resource) return;
    const submittedPublished = getFormString(formData, "isPublished");
    const { enqueuePublishChange } = await import("~/services/seo/index-now-content.server");
    await enqueuePublishChange(db, session.shop, {
      resource,
      previousPublished: beforeSave.isPublished,
      // Absent ⇒ unchanged. Only the transition is interesting, and treating a
      // missing field as "now published" would ping every draft.
      nextPublished: submittedPublished === "" ? beforeSave.isPublished : submittedPublished !== "false",
      previousHandle: beforeSave.handle,
      nextHandle: storedHandle || submittedHandle || beforeSave.handle,
      blogHandle:
        resource === "article" ? await loadArticleBlogHandle(admin, db, session.shop, itemId) : undefined,
    });
  };

  /**
   * Runs AFTER the save. `storedHandle` is the handle Shopify ECHOED back where
   * the write path exposes one — the repo's echo rule applied to the redirect
   * target: trusting `sanitizeSlug` to reproduce Shopify's own normalisation
   * byte-for-byte is an assumption, and a redirect built on a wrong assumption
   * points a live URL at a 404 while telling the merchant it is covered.
   *
   * Never throws. The content update it accompanies has already happened, so a
   * failure here must not reach the caller's catch and be reported as a failed
   * save — that would invite the merchant to make the same edit twice.
   */
  const finishHandleRedirect = async (storedHandle?: string | null): Promise<HandleRedirectNote | undefined> => {
    if (!handleChanged || !redirectResource || !previousHandle) return undefined;
    try {
      const { applyHandleRedirect } = await import("~/services/seo/handle-redirect.server");
      const result = await applyHandleRedirect(admin, session.shop, {
        resource: redirectResource,
        previousHandle,
        nextHandle: storedHandle || submittedHandle,
        wanted: wantsHandleRedirect,
        // An article's URL contains its BLOG's handle, which this app does not
        // cache (no Blog model). Fetched on demand — one call, and only when an
        // article handle actually changed — because without it the redirect
        // simply cannot be built and the old URL stays broken.
        blogHandle:
          redirectResource === "article"
            ? await loadArticleBlogHandle(admin, db, session.shop, itemId)
            : undefined,
      });
      // A code plus its one variable, never a sentence: the three UI languages
      // are the client's to build.
      return result.noteCode ? { code: result.noteCode, fromPath: result.fromPath } : undefined;
    } catch (error) {
      logger.warn("[UnifiedContent] Handle redirect failed after a successful save", {
        context: "UnifiedContent",
        itemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { code: "failed" };
    }
  };

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
      if (marketId) productFormData.set("marketId", marketId);

      // Map field names
      const fieldMapping: Record<string, string> = {
        title: "title",
        description: "descriptionHtml",
        handle: "handle",
        seoTitle: "seoTitle",
        metaDescription: "metaDescription",
        productType: "productType",
        // §Phase 3 attributes keep their own names on both sides.
        status: "status",
        vendor: "vendor",
        tags: "tags",
        templateSuffix: "templateSuffix",
        price: "price",
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
      // §Phase 3 — which merchandising attributes the merchant actually
      // touched. Separate from `changedFields` because that one is withheld by
      // the accept-and-translate flow, and an attribute edit must not be
      // silently dropped just because the save also starts a translation.
      const changedAttributesStr = getFormString(formData, "changedAttributeFields");
      if (changedAttributesStr && locale === primaryLocale) {
        productFormData.set("changedAttributeFields", changedAttributesStr);
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
      const productBody = await readDataPayload<Record<string, unknown>>(productResult);
      // Only after a SUCCESSFUL save: redirecting to a handle that was never
      // written would point the old URL at a 404. The handle Shopify echoed
      // back wins over the one we sent — see finishHandleRedirect.
      const productRedirectNote =
        productBody?.success === false
          ? undefined
          : await finishHandleRedirect(echoedHandle(productBody));
      // Products have their own webhook, so `finishIndexNow` is a no-op here —
      // it is called anyway so the two return paths stay identical and a future
      // creatable type on this branch is covered without anyone remembering.
      if (productBody?.success !== false) await finishIndexNow(echoedHandle(productBody));
      return json(
        { ...productBody, actionType: "updateContent", ...(productRedirectNote ? { redirectNote: productRedirectNote } : {}) },
        { status: readDataStatus(productResult) ?? 200 },
      );
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

      // On a primary-locale save the client sends ALL metaobject fields
      // (buildFieldsForSave does not filter for the primary locale); only the
      // GIDs listed in `changedFields` actually changed. Restrict processing to
      // those so we never re-write / purge untouched metaobjects or fire N
      // redundant Shopify calls. Foreign-locale saves already send only changed
      // fields (and omit changedFields), so they pass through unchanged. The
      // per-entry value guard in the loop below is a safety net for flows that
      // omit changedFields (e.g. accept-and-translate).
      const changedFieldsStr = getFormString(formData, "changedFields");
      const changedIds = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : null;
      const updatesToProcess = (locale === primaryLocale && changedIds && changedIds.length > 0)
        ? metaobjectUpdates.filter((u) => changedIds.includes(u.id))
        : metaobjectUpdates;

      if (updatesToProcess.length === 0) {
        return json({ success: true, actionType: "updateContent" });
      }

      // Block empty primary-locale fields (same protection as templates)
      if (locale === primaryLocale) {
        const emptyEntries = updatesToProcess.filter(u => u.value.trim() === "");
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

      for (const update of updatesToProcess) {
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
            // Safety net: skip metaobjects whose value did not actually change.
            // Guards flows that omit changedFields (accept-and-translate) so we
            // never purge foreign translations of an untouched entry. Compare
            // against the stored primary value (label entry in the DB `fields`
            // blob), which we also reuse below to mirror the new value.
            const existing = await db.metaobject.findUnique({
              where: { shop_id: { shop: session.shop, id: update.id } },
              select: { fields: true },
            });
            const existingFields = Array.isArray(existing?.fields)
              ? (existing!.fields as Array<{ key: string; value: string | null; type: string }>)
              : [];
            const oldLabelValue = existingFields.find((f) => f.key === labelField.key)?.value ?? "";
            if (oldLabelValue === update.value) {
              continue; // unchanged → nothing to update or purge
            }

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
                      // Global only — mirror the global-only Shopify removal so
                      // market overrides survive on both sides (no divergence).
                      marketId: "",
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
            // Empty value in foreign locale → remove the translation (market-scoped:
            // omitting marketIds removes global, a market removes only that override)
            const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
              variables: {
                resourceId: update.id,
                translationKeys: [labelField.key],
                locales: [locale],
                marketIds: marketId ? [marketId] : null,
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
                  locale,
                  marketId,
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
                  translatableContentDigest: digestEntry.digest,
                  // Market scope: omitted (global) unless a market is selected.
                  ...(marketId ? { marketId } : {}),
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
                  shop_metaobjectId_key_locale_marketId: {
                    shop: session.shop,
                    metaobjectId: update.id,
                    key: labelField.key,
                    locale,
                    marketId,
                  }
                },
                create: {
                  shop: session.shop,
                  metaobjectId: update.id,
                  type: typeId,
                  key: labelField.key,
                  value: update.value,
                  locale,
                  outdated: false,
                  marketId,
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
        count: updatesToProcess.length,
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
    // §Phase 3 — see the product branch above for why this is its own list.
    const changedAttributesStr = getFormString(formData, "changedAttributeFields");
    const changedAttributeFields: string[] | undefined = changedAttributesStr
      ? safeJsonParse<string[]>(changedAttributesStr, [])
      : undefined;

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
      changedAttributeFields: locale === primaryLocale ? changedAttributeFields : undefined,
      marketId,
    });

    const savedOk = (result as { success?: boolean })?.success !== false;
    const redirectNote = savedOk
      ? await finishHandleRedirect(echoedHandle(result as Record<string, unknown>))
      : undefined;
    // §3.4 — the ONLY moment a page/article/blog publish can reach IndexNow:
    // Shopify emits no webhook for any of them.
    if (savedOk) await finishIndexNow(echoedHandle(result as Record<string, unknown>));
    return json({ ...result, actionType: "updateContent", ...(redirectNote ? { redirectNote } : {}) });
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

// ────────────────────────────────────────────────────────────────────────────
// Handle-redirect helpers (PLAN §Phase 3.3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The handle Shopify actually STORED, dug out of whichever shape the write path
 * returned: the product path answers `{ product }`, the generic one `{ item }`.
 * Every one of those mutations already selects `handle`.
 *
 * The echo rule, applied to the redirect target. Without it the target is the
 * value this app SENT, and that is only right for as long as `sanitizeSlug`
 * matches Shopify's own normalisation exactly — an assumption, and one whose
 * failure mode is a redirect pointing a live URL at a 404 while the merchant is
 * told the old address is covered. Undefined when the path exposes nothing, in
 * which case the caller falls back to the submitted handle.
 */
function echoedHandle(body: Record<string, unknown> | null | undefined): string | null {
  if (!body) return null;
  for (const key of ["product", "item"]) {
    const resource = body[key] as { handle?: unknown } | null | undefined;
    if (resource && typeof resource.handle === "string" && resource.handle) return resource.handle;
  }
  return null;
}

/**
 * What the item looked like BEFORE this save — the handle about to be replaced
 * and the visibility about to change. One read for both §3.3 and §3.4; reading
 * it twice would be two queries for the same row.
 *
 * `isPublished: null` means the type does not have one (products carry a status
 * enum instead, collections nothing) — NOT that it is hidden.
 */
async function loadCachedSnapshot(
  db: ContentActionHandlerContext["db"],
  shop: string,
  resourceType: string,
  itemId: string,
): Promise<{ handle: string | null; isPublished: boolean | null }> {
  const empty = { handle: null, isPublished: null };
  try {
    switch (resourceType) {
      case "Product": {
        const row = await db.product.findFirst({ where: { shop, id: itemId }, select: { handle: true } });
        return { handle: row?.handle ?? null, isPublished: null };
      }
      case "Collection": {
        const row = await db.collection.findFirst({ where: { shop, id: itemId }, select: { handle: true } });
        return { handle: row?.handle ?? null, isPublished: null };
      }
      case "Page": {
        const row = await db.page.findFirst({
          where: { shop, id: itemId },
          select: { handle: true, isPublished: true, attributesSyncedAt: true },
        });
        return {
          handle: row?.handle ?? null,
          // §2.4 — `isPublished` defaults to TRUE in the schema, so on a row an
          // older sync wrote it says nothing. Reported as unknown rather than
          // as "was visible", which would make every first save look like a
          // publish transition and ping IndexNow for drafts.
          isPublished: row?.attributesSyncedAt ? row.isPublished : null,
        };
      }
      case "Article": {
        const row = await db.article.findFirst({
          where: { shop, id: itemId },
          select: { handle: true, isPublished: true, attributesSyncedAt: true },
        });
        return {
          handle: row?.handle ?? null,
          isPublished: row?.attributesSyncedAt ? row.isPublished : null,
        };
      }
      default:
        return empty;
    }
  } catch {
    // A cache miss is not a reason to fail the save — it only means neither
    // the redirect nor the IndexNow ping can be offered for this edit.
    return empty;
  }
}

/** A blog's handle, straight from Shopify. There is no Blog cache model, so
 *  this is the only way to learn either an article's URL prefix or the blog
 *  container's OWN pre-rename handle. */
async function loadBlogHandle(
  admin: ContentActionHandlerContext["admin"],
  blogId: string,
): Promise<string | null> {
  try {
    const response = await admin.graphql(
      `#graphql
        query blogHandleForRedirect($id: ID!) { blog(id: $id) { handle } }`,
      { variables: { id: blogId } },
    );
    const data = await response.json();
    return data?.data?.blog?.handle ?? null;
  } catch {
    return null;
  }
}

/** The blog handle that prefixes an ARTICLE's URL. */
async function loadArticleBlogHandle(
  admin: ContentActionHandlerContext["admin"],
  db: ContentActionHandlerContext["db"],
  shop: string,
  articleId: string,
): Promise<string | null> {
  try {
    const article = await db.article.findFirst({ where: { shop, id: articleId }, select: { blogId: true } });
    if (!article?.blogId) return null;
    return await loadBlogHandle(admin, article.blogId);
  } catch {
    return null;
  }
}

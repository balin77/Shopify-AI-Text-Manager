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
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";
import { readDataPayload, readDataStatus } from "~/utils/data-response";
import {
  normalizeHandle,
  redirectResourceFor,
  resolveRedirectPreference,
  wasEverLive,
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

  // §Phase 3 — which MERCHANDISING attributes the merchant actually touched.
  // Its own list, separate from `changedFields`: that one answers "which
  // translations went stale" and the accept-and-translate flow withholds it,
  // which would otherwise take attribute edits down with it. Read once here —
  // both branches below and the IndexNow hook need it.
  const changedAttributesStr = getFormString(formData, "changedAttributeFields");
  const changedAttributeFields: string[] | undefined = changedAttributesStr
    ? safeJsonParse<string[]>(changedAttributesStr, [])
    : undefined;

  logger.debug('[UnifiedContent] updateContent', { resourceType: contentConfig.resourceType, itemId, locale, primaryLocale });

  // ── PLAN §Phase 3.3 / §A1 — a handle change breaks the old URL ───────────
  // Read BEFORE the write, because afterwards the old handle is gone and with
  // it any chance of preserving the address it served. Everything under this
  // heading is the PRIMARY locale's half; a translated handle is a different
  // URL with its own set of things that must not happen, and it runs through
  // `finishTranslatedHandleRedirect` further down.
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
      ? redirectResource === "blog"
        ? // A blog CONTAINER has no cache model, so its old handle can only
          // come from Shopify. Fetched ONLY when a handle was actually
          // submitted — otherwise this would be one Admin round-trip on every
          // save of every blog, in the request's critical path, for a value
          // nothing downstream can use.
          submittedHandle
          ? { handle: await loadBlogHandle(admin, itemId), isPublished: null, status: null, attributesKnown: true }
          : { handle: null, isPublished: null, status: null, attributesKnown: true }
        : await loadCachedSnapshot(db, session.shop, contentConfig.resourceType, itemId)
      : null;
  const previousHandle = wantsHandleRedirect ? beforeSave?.handle ?? null : null;
  // §Phase 3.3 — a draft's URL was never reachable, so a redirect from it is
  // clutter in the merchant's list and a loop waiting to happen once they reuse
  // the handle. Unknown proceeds; see `wasEverLive` for why that asymmetry is
  // deliberate.
  const previouslyLive =
    beforeSave && redirectResource
      ? wasEverLive(redirectResource, {
          status: beforeSave.status,
          isPublished: beforeSave.isPublished,
          attributesKnown: beforeSave.attributesKnown,
        })
      : null;
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
    // The submitted value is trusted ONLY when the merchant actually touched
    // the toggle. Otherwise it is whatever the editor read out of the cache —
    // and for an article that cache column is `isPublished`, which defaults to
    // TRUE and says nothing at all on a row an older sync wrote. Trusting it
    // would let a hidden article report itself as published and put a 404 URL
    // in front of a search engine: the very failure the `previousPublished`
    // gate exists to prevent, on the other half of the comparison.
    const publishTouched = changedAttributeFields?.includes("isPublished") ?? false;
    const submittedPublished = getFormString(formData, "isPublished");
    const nextPublished =
      publishTouched && submittedPublished !== ""
        ? submittedPublished !== "false"
        : beforeSave.isPublished;

    const { enqueuePublishChange } = await import("~/services/seo/index-now-content.server");
    await enqueuePublishChange(db, session.shop, {
      resource,
      previousPublished: beforeSave.isPublished,
      nextPublished,
      previousHandle: beforeSave.handle,
      nextHandle: storedHandle || submittedHandle || beforeSave.handle,
      // A THUNK, not a value: resolving an article's blog handle costs a DB
      // read plus a GraphQL call, and `enqueuePublishChange` returns early for
      // every shop that has IndexNow switched off. Passed eagerly it would put
      // that round-trip in the critical path of every article save on every
      // shop, including the ones that can never use the result.
      loadBlogHandle:
        resource === "article"
          ? () => loadArticleBlogHandle(admin, db, session.shop, itemId)
          : undefined,
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
        previouslyLive,
        // An article's URL contains its BLOG's handle, which this app does not
        // cache (no Blog model). Fetched on demand — one call, and only when an
        // article handle actually changed — because without it the redirect
        // simply cannot be built and the old URL stays broken.
        blogHandle:
          redirectResource === "article"
            ? await loadArticleBlogHandle(admin, db, session.shop, itemId)
            : undefined,
      });
      // §Phase 3.3 — a renamed BLOG moves every article under it, and Shopify
      // redirects have no wildcards, so each needs its own row. That is bounded
      // but not small (a 200-article blog is 200 lookups + 200 creates), so it
      // runs as a background Task: the blog's OWN redirect is already done and
      // is the URL most likely to be linked, and holding the merchant's save
      // open for minutes to finish the rest would risk a request timeout for
      // work that is not urgent.
      if (result.created && redirectResource === "blog" && previousHandle) {
        const nextBlogHandle = storedHandle || submittedHandle;
        void import("~/services/seo/blog-article-redirects.server")
          .then(({ redirectBlogArticles }) =>
            redirectBlogArticles(admin, db, session.shop, {
              blogId: itemId,
              previousBlogHandle: previousHandle,
              nextBlogHandle,
            }),
          )
          .catch(() => undefined);
      }

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

  /**
   * §Phase 3.3, foreign half — the same courtesy for a TRANSLATED handle,
   * split into a BEFORE and an AFTER half for two separate reasons.
   *
   * BEFORE, because the old translated handle is gone once the save has run:
   * the write path upserts the new value into `ContentTranslation` itself, so a
   * capture placed after it reads its own write and every rename looks
   * unchanged — which is exactly how the first cut of this shipped dead.
   *
   * AFTER, because the STORED value is the only honest answer to "what does
   * this locale serve now". The submitted handle is not it: the generic write
   * path SKIPS a handle translation identical to the primary handle (no
   * Shopify write, no DB write, no error), so trusting the submission would
   * build a redirect off an edit that never happened — and put it on the
   * locale's own live URL. Reading the row back covers the rename, the clear
   * (row gone ⇒ back to the primary handle) and the skip (row unchanged ⇒
   * `unchanged`) with one rule instead of three guesses.
   *
   * A foreign save carries only CHANGED fields (`buildFieldsForSave`), so
   * `formData.has("handle")` is both the gate and the cheap common case.
   */
  interface TranslatedHandleCapture {
    previous: string;
    otherLocaleHandles: string[];
    primaryHandle: string | null;
    previouslyLive: boolean | null;
    previousHandleTakenElsewhere: boolean;
    blogHandle: string | null;
    blogHandleTranslatedInLocale: boolean;
  }

  const captureTranslatedHandle = async (): Promise<TranslatedHandleCapture | null> => {
    // A market override is served to one market while a redirect row is
    // shop-wide — refused by the decision too, but skipped here so the common
    // market-scoped save pays for none of the reads.
    if (isPrimarySave || !redirectResource || !wantsHandleRedirect || marketId !== "") return null;
    if (!formData.has("handle")) return null;
    try {
      const handleRows = await db.contentTranslation.findMany({
        where: { shop: session.shop, resourceId: itemId, key: "handle", marketId: "" },
        select: { locale: true, value: true },
      });
      const previous = handleRows.find((r) => r.locale === locale)?.value?.trim() ?? "";
      // No previous translation ⇒ this locale was served under the primary
      // handle, which stays live. Nothing broke; bail before the other reads.
      if (!previous) return null;

      const snapshot =
        redirectResource === "blog"
          ? { handle: await loadBlogHandle(admin, itemId), isPublished: null, status: null, attributesKnown: true }
          : await loadCachedSnapshot(db, session.shop, contentConfig.resourceType, itemId);

      let blogHandle: string | null = null;
      let blogHandleTranslatedInLocale = false;
      if (redirectResource === "article") {
        // ONE read of blogId, used for both the handle and the translation
        // check — `loadArticleBlogHandle` would read it a second time.
        const article = await db.article.findFirst({
          where: { shop: session.shop, id: itemId },
          select: { blogId: true },
        });
        if (article?.blogId) {
          blogHandle = await loadBlogHandle(admin, article.blogId);
          const translated = await db.contentTranslation.findFirst({
            where: { shop: session.shop, resourceId: article.blogId, key: "handle", locale, marketId: "" },
            select: { value: true },
          });
          blogHandleTranslatedInLocale = !!translated?.value?.trim();
        }
      }

      const { handleTakenByOtherResource } = await import("~/services/seo/handle-redirect.server");
      return {
        previous,
        otherLocaleHandles: handleRows.filter((r) => r.locale !== locale).map((r) => r.value),
        primaryHandle: snapshot.handle,
        previouslyLive: wasEverLive(redirectResource, {
          status: snapshot.status,
          isPublished: snapshot.isPublished,
          attributesKnown: snapshot.attributesKnown,
        }),
        previousHandleTakenElsewhere: await handleTakenByOtherResource(
          db as never,
          session.shop,
          redirectResource,
          previous,
          itemId,
        ),
        blogHandle,
        blogHandleTranslatedInLocale,
      };
    } catch (error) {
      // A redirect is a courtesy on a write that has to happen either way.
      logger.warn("[UnifiedContent] Could not read the old translated handle", {
        context: "UnifiedContent",
        itemId,
        locale,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  /** Never throws: the translation is already written. */
  const finishTranslatedHandleRedirect = async (
    captured: TranslatedHandleCapture | null,
  ): Promise<HandleRedirectNote | undefined> => {
    if (!captured || !redirectResource) return undefined;
    try {
      // What the locale actually serves NOW — see the note above on why the
      // submitted handle is not that.
      const stored = await db.contentTranslation.findFirst({
        where: { shop: session.shop, resourceId: itemId, key: "handle", locale, marketId: "" },
        select: { value: true },
      });

      const { applyTranslatedHandleRedirect } = await import("~/services/seo/handle-redirect.server");
      const result = await applyTranslatedHandleRedirect(admin, session.shop, {
        resource: redirectResource,
        marketId,
        previousTranslatedHandle: captured.previous,
        // Empty ⇒ the row is gone, i.e. the merchant cleared the translation;
        // the decision then sends the dead URL back to the primary handle.
        nextTranslatedHandle: stored?.value?.trim() ?? "",
        primaryHandle: captured.primaryHandle,
        otherLocaleHandles: captured.otherLocaleHandles,
        previousHandleTakenElsewhere: captured.previousHandleTakenElsewhere,
        wanted: wantsHandleRedirect,
        previouslyLive: captured.previouslyLive,
        blogHandle: captured.blogHandle,
        blogHandleTranslatedInLocale: captured.blogHandleTranslatedInLocale,
      });
      return result.noteCode ? { code: result.noteCode, fromPath: result.fromPath } : undefined;
    } catch (error) {
      logger.warn("[UnifiedContent] Translated handle redirect failed after a successful save", {
        context: "UnifiedContent",
        itemId,
        locale,
        error: error instanceof Error ? error.message : String(error),
      });
      return { code: "failed" };
    }
  };

  // Read BEFORE either write path runs — see above.
  const capturedTranslatedHandle = await captureTranslatedHandle();

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
      // §Phase 3 — see the hoisted declaration at the top of this handler.
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
      // The two are mutually exclusive by construction — one returns early for
      // a foreign save, the other for a primary one — so at most one note comes
      // back and the response shape stays a single `redirectNote`.
      const productRedirectNote =
        productBody?.success === false
          ? undefined
          : (await finishHandleRedirect(echoedHandle(productBody))) ??
            (await finishTranslatedHandleRedirect(capturedTranslatedHandle));
      // Products have their own webhook, so `finishIndexNow` is a no-op here —
      // it is called anyway so the two return paths stay identical and a future
      // creatable type on this branch is covered without anyone remembering.
      if (productBody?.success !== false) await finishIndexNow(echoedHandle(productBody));
      return json(
        { ...productBody, actionType: "updateContent", ...(productRedirectNote ? { redirectNote: productRedirectNote } : {}) },
        { status: readDataStatus(productResult) ?? 200 },
      );
    }

    // Metaobjects have their own branch: a form field here is
    // `<Metaobject GID>#<field key>`, so ONE save carries several fields of
    // several entries. It is a helper of THIS handler, not a second one.
    if (contentConfig.resourceType === "Metaobject") {
      const { handleMetaobjectUpdate } = await import("./metaobject-update.action");
      return handleMetaobjectUpdate(ctx, formData, { locale, primaryLocale, marketId });
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
      changedAttributeFields: locale === primaryLocale ? changedAttributeFields : undefined,
      marketId,
    });

    // §Phase 3.1 — the collection's rule sources, as a DIFF against what the
    // cache holds. A separate mutation from the content update because
    // `sourcesToCreate/Update/Delete` are their own inputs, and because a
    // rule failure must not take the merchant's text edits with it.
    let ruleWarning: string | undefined;
    if (
      contentConfig.resourceType === "Collection" &&
      isPrimarySave &&
      changedAttributeFields?.includes("collectionRules")
    ) {
      const { applyCollectionRuleChange } = await import("~/services/collection-rules.server");
      ruleWarning = await applyCollectionRuleChange(admin, db, session.shop, {
        collectionId: itemId,
        submitted: getFormString(formData, "collectionRules"),
      });
    }

    const savedOk = (result as { success?: boolean })?.success !== false;
    const redirectNote = savedOk
      ? (await finishHandleRedirect(echoedHandle(result as Record<string, unknown>))) ??
        (await finishTranslatedHandleRedirect(capturedTranslatedHandle))
      : undefined;
    // §3.4 — the ONLY moment a page/article/blog publish can reach IndexNow:
    // Shopify emits no webhook for any of them.
    if (savedOk) await finishIndexNow(echoedHandle(result as Record<string, unknown>));
    return json({
      ...result,
      actionType: "updateContent",
      ...(redirectNote ? { redirectNote } : {}),
      // A rule change that did not land is a warning on a save that otherwise
      // worked — never a silent drop, and never a failed save.
      ...(ruleWarning ? { ruleWarning } : {}),
    });
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
): Promise<{
  handle: string | null;
  isPublished: boolean | null;
  /** Products only — the four-value ProductStatus, verbatim. */
  status: string | null;
  /** False ⇒ `isPublished` above is the migration's default, not data. */
  attributesKnown: boolean;
}> {
  const empty = { handle: null, isPublished: null, status: null, attributesKnown: true };
  try {
    switch (resourceType) {
      case "Product": {
        // `status` is NOT part of the attribute block — it is non-null in the
        // schema and predates it — so it is trustworthy on every row.
        const row = await db.product.findFirst({
          where: { shop, id: itemId },
          select: { handle: true, status: true },
        });
        return { handle: row?.handle ?? null, isPublished: null, status: row?.status ?? null, attributesKnown: true };
      }
      case "Collection": {
        // A collection's visibility lives in publications, which this app has
        // no scope for — so "was it live" is genuinely unknown here.
        const row = await db.collection.findFirst({ where: { shop, id: itemId }, select: { handle: true } });
        return { handle: row?.handle ?? null, isPublished: null, status: null, attributesKnown: true };
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
          status: null,
          attributesKnown: !!row?.attributesSyncedAt,
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
          status: null,
          attributesKnown: !!row?.attributesSyncedAt,
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

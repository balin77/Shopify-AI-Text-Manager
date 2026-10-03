/**
 * Alt-Text Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: generateAltText, generateAllAltTexts, translateAltText, translateAltTextToAllLocales
 */

import { data as json } from "react-router";
import { AIService, toValidProvider, isManagedRefusal } from "../../../src/services/ai.service";
import { managedRefusalResponseFromError } from "~/utils/ai-refusal-response.server";
import { ALT_NO_PRIMARY, ALT_NO_SOURCE_TEXT, altTranslateSourceText, altTranslateTaskStatus, planAltTranslate } from "~/services/alt-text-feedback.shared";
import { TranslationService } from "../../../src/services/translation.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import { decryptApiKey } from "../../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { taskTitleOrFallback } from "~/services/tasks/resource-title.server";
import type { ContentEditorConfig } from "../../types/content-editor.types";
import { logger } from "../../utils/logger.server";
import { ShopifyApiGateway } from "../../services/shopify-api-gateway.service";
import { getFormInt, getFormJSON, getFormString } from "../../utils/form-data.utils";
import { isValidLocale } from "../../utils/validation";
import { sanitizePromptInput } from "../../utils/prompt-sanitizer";
import { resolveVisionPolicy } from "../../services/ai/vision-policy.shared";
import { getFullErrorMessage } from "../../utils/error-handler";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-api";
import type { PrismaClient } from "@prisma/client";
import type { AISettings, AIInstructions } from "@prisma/client";
import type { SeoLimits } from "../../utils/character-limits";
import type { TranslationMode } from "../../routes/api-ai-handlers/shared";
import type { DataResponse } from "~/types/data-response";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { ALT_IMAGE_NOT_FOUND, pickProductImage } from "~/services/product-image-pick.shared";
import { altTextSyncShieldId, marketLayerLockId } from "~/services/translations/translation-locks.shared";

// A Shopify Market id: the only shape a client-sent marketId may take.
const MARKET_GID_RE = /^gid:\/\/shopify\/Market\/\d+$/;
const MEDIA_IMAGE_GID_RE = /^gid:\/\/shopify\/MediaImage\/\d+$/;
const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;

export interface ContentActionHandlerContext {
  admin: AdminApiContext;
  session: Session;
  contentConfig: ContentEditorConfig;
  db: PrismaClient;
  aiSettings: AISettings | null;
  aiInstructions: AIInstructions | null;
  itemId: string;
  seoTitleMaxChars: number;
  /** Fully-resolved merchant SEO character limits (defaults filled in). */
  seoLimits: SeoLimits;
  /** Merchant translation policy — "exact" preserves source length,
   * "seo_optimized" appends per-field caps to the translate prompt. */
  translationMode: TranslationMode;
  shopifyContentService: ShopifyContentService;
  provider: ReturnType<typeof toValidProvider>;
  serviceConfig: {
    huggingfaceApiKey?: string;
    geminiApiKey?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
    grokApiKey?: string;
    deepseekApiKey?: string;
    selectedModel?: string;
  };
}

// ============================================================================
// SHARED BUILDING BLOCKS
// Also used by the SEO performance page's alt-text bridge
// (app.seo.performance.tsx, accessibility plan §7) — keep them the single
// source of truth for the alt-text prompt and the primary-locale save, so the
// two entry points cannot drift apart.
// ============================================================================

/**
 * The alt-text generation prompt. Sanitizes the product title and returns it
 * alongside the prompt because `AIService.generateImageAltText` wants the
 * sanitized title as its own argument too.
 */
export function buildProductAltTextPrompt(opts: {
  productTitle: string;
  imageUrl: string;
  aiInstructions: Pick<AIInstructions, "productAltTextFormat" | "productAltTextInstructions"> | null;
  /** Output language, e.g. the shop's main language. */
  language: string;
}): { prompt: string; sanitizedTitle: string } {
  const sanitizedTitle = sanitizePromptInput(opts.productTitle || "", { fieldType: "title" });
  let prompt = `Create an optimized alt text for a product image.
Product: ${sanitizedTitle}
Image URL: ${opts.imageUrl}`;

  if (opts.aiInstructions?.productAltTextFormat) {
    prompt += `\n\nFormat Example:\n${opts.aiInstructions.productAltTextFormat}`;
  }
  if (opts.aiInstructions?.productAltTextInstructions) {
    prompt += `\n\nInstructions:\n${opts.aiInstructions.productAltTextInstructions}`;
  }
  prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${opts.language}.`;
  return { prompt, sanitizedTitle };
}

/**
 * Primary-locale alt-text save: `fileUpdate` with userErrors check, then the
 * shop-scoped ProductImage cache write (R4-DI7: per-shop-unique media GIDs can
 * collide across tenants, so the write is always scoped by the owning
 * product's shop). The DB write is best-effort — Shopify is the source of
 * truth — but logged so a real failure stays observable.
 *
 * `apiError` is set when the mutation itself failed (network/GraphQL error);
 * `userErrors` carries Shopify's validation messages. `saved` is true only
 * when Shopify accepted the update.
 */
export async function saveImageAltTextPrimary(opts: {
  admin: AdminApiContext;
  db: PrismaClient;
  shop: string;
  mediaId: string;
  altText: string;
}): Promise<{ saved: boolean; userErrors: string[]; apiError?: string; retranslationTaskId?: string; libraryAltsPurged?: string[] }> {
  const { admin, db, shop, mediaId, altText } = opts;
  // The alt as it stood BEFORE this write — read first, because the cache write
  // below replaces it (product-alt-repair.server.ts).
  const { snapshotProductAlts, repairAltsAfterWrite } = await import(
    "../../services/translations/product-alt-repair.server"
  );
  const snapshot = await snapshotProductAlts(db, shop, [mediaId]);
  // A media-LIBRARY file (no ProductImage row) has no product repair; its
  // foreign translations are deleted below (library-alt-repair.server.ts).
  const { snapshotLibraryAlts, purgeLibraryAltTranslationsAfterWrite } = await import(
    "../../services/translations/library-alt-repair.server"
  );
  const librarySnapshot = await snapshotLibraryAlts(db, shop, [mediaId]);
  let stored = altText;
  try {
    const r = await admin.graphql(
      `#graphql
        mutation fileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            files { id alt }
            userErrors { field message }
          }
        }`,
      { variables: { files: [{ id: mediaId, alt: altText }] } }
    );
    const d = await r.json() as any;
    const userErrors: Array<{ message: string }> = d.data?.fileUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { saved: false, userErrors: userErrors.map((e) => e.message) };
    }
    // What Shopify STORED, where it says: the repair checks its read-back
    // against this, and a normalised value compared with the raw input would
    // read as a mismatch and decline the whole repair.
    const echoed = (d.data?.fileUpdate?.files ?? []).find((f: { id?: string }) => f?.id === mediaId)?.alt;
    if (typeof echoed === "string") stored = echoed;
  } catch (err: unknown) {
    logger.error("[saveImageAltText] fileUpdate error", { error: String(err) });
    return { saved: false, userErrors: [], apiError: String(err) };
  }

  await db.productImage.updateMany({
    where: { mediaId, product: { shop } },
    data: { altText: stored || null, altTextModifiedAt: new Date() },
  }).catch((e) => {
    logger.warn("[saveImageAltText] DB cache update failed", { error: e instanceof Error ? e.message : String(e) });
  });
  // A media-library file (no ProductImage row -- e.g. a library pick in a
  // variant gallery) is cached in MediaLibraryImage instead; fileUpdate above
  // is the right write for both. Shop-scoped like the product cache write.
  try {
    await db.mediaLibraryImage.updateMany({
      where: { shop, id: mediaId },
      data: { altText: stored || null },
    });
  } catch (e: unknown) {
    logger.warn("[saveImageAltText] media-library cache update failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // The foreign translations of the alt that just changed: re-translated with
  // auto-translate on, otherwise the merchant's stored deletion answer. This
  // path used to do neither — the product editor's save did, this one (the
  // image manager's per-image save, and the SEO performance page's generator)
  // did not, so an alt edited here was never translated anywhere.
  const [retranslationTaskId] = await repairAltsAfterWrite({
    gateway: new ShopifyApiGateway(admin as never, shop),
    db,
    shop,
    snapshot,
    written: [{ mediaId, alt: stored }],
  });
  const libraryAltsPurged = await purgeLibraryAltTranslationsAfterWrite({
    gateway: new ShopifyApiGateway(admin as never, shop),
    db,
    shop,
    snapshot: librarySnapshot,
    written: [{ mediaId, alt: stored }],
  });

  return {
    saved: true,
    userErrors: [],
    ...(retranslationTaskId ? { retranslationTaskId } : {}),
    ...(libraryAltsPurged.length > 0 ? { libraryAltsPurged } : {}),
  };
}

// ============================================================================
// GENERATE ALT-TEXT (single image)
// ============================================================================

export async function handleGenerateAltText(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, provider, serviceConfig } = ctx;

  const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
  const imageUrl = getFormString(formData, "imageUrl");
  const productTitle = getFormString(formData, "productTitle");
  const mainLanguage = getFormString(formData, "mainLanguage");
  const { prompt, sanitizedTitle: sanitizedProductTitle } = buildProductAltTextPrompt({
    productTitle,
    imageUrl,
    aiInstructions,
    language: mainLanguage,
  });

  // The client sends the product title it has on screen; the image manager's
  // buttons do not always carry one, and an empty subject used to blank the
  // Tasks card's whole resource row. Cached title as the fallback, and NO id
  // fallback: the card renders the numeric id and the Shopify deep link off
  // `resourceId` itself, so a GID here would be that fact spelled unreadably.
  const taskResourceTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId, productTitle,
  );
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: taskResourceTitle,
      fieldType: `altText_${imageIndex}`,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    // §2.5e — the glossary applies to the ORIGINAL alt text too, not only to
    // its translations. Same block as the `/api/ai` twin: this action is the
    // OTHER entrance to the same feature.
    const { resolveWrittenLocale } = await import("~/routes/api-ai-handlers/keyword-prompt");
    // The shop's own switch, and this is the site that most needed it: it was
    // hardcoded `false`, so the image manager's "write an alt text" button
    // described pictures it had never seen, however the merchant had set the
    // (then per-editor) checkbox two clicks away.
    const altText = await aiServiceWithTask.generateImageAltText(
      imageUrl,
      sanitizedProductTitle,
      prompt,
      resolveVisionPolicy(ctx.aiSettings).sendImages,
      {
        contextTexts: [sanitizedProductTitle],
        locale: await resolveWrittenLocale(admin, session.shop, formData),
      },
    );

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ altText, imageIndex }),
      },
    });

    return json({ actionType: "generateAltText", success: true, altText, imageIndex });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "generateAltText" });
    if (refused) return refused;
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// GENERATE ALL ALT-TEXTS (bulk)
// ============================================================================

export async function handleGenerateAllAltTexts(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, aiInstructions, itemId, provider, serviceConfig } = ctx;

  const imagesData = getFormJSON<Array<{ url: string }>>(formData, "imagesData");
  if (!imagesData) {
    return json({ success: false, error: "Invalid imagesData format" }, { status: 400 });
  }
  const productTitle = getFormString(formData, "productTitle");
  const sanitizedProductTitle = sanitizePromptInput(productTitle || "", { fieldType: "title" });
  const mainLanguage = getFormString(formData, "mainLanguage");
  const totalImages = imagesData.length;

  // The client sends the product title it has on screen; the image manager's
  // buttons do not always carry one, and an empty subject used to blank the
  // Tasks card's whole resource row. Cached title as the fallback, and NO id
  // fallback: the card renders the numeric id and the Shopify deep link off
  // `resourceId` itself, so a GID here would be that fact spelled unreadably.
  const bulkTaskResourceTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId, productTitle,
  );
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkAIGeneration",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: bulkTaskResourceTitle,
      fieldType: "allAltTexts",
      progress: 0,
      total: totalImages,
      processed: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const generatedAltTexts: Record<number, string> = {};

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

    // Read ONCE for the batch: one shop, one answer, and re-resolving it per
    // image would suggest it could change mid-run.
    const sendImagesToAI = resolveVisionPolicy(ctx.aiSettings).sendImages;

    // One product, one language — resolved once for the whole batch (§2.5e).
    const { resolveWrittenLocale } = await import("~/routes/api-ai-handlers/keyword-prompt");
    const writtenLocale = await resolveWrittenLocale(admin, session.shop, formData);

    // A refusal part-way through: the alt texts generated before it are paid
    // for and still valid, so they are returned rather than thrown away.
    let stoppedBy: unknown = null;
    for (let i = 0; i < imagesData.length; i++) {
      const image = imagesData[i];
      try {
        const { prompt } = buildProductAltTextPrompt({
          productTitle,
          imageUrl: image.url,
          aiInstructions,
          language: mainLanguage,
        });
        const altText = await aiServiceWithTask.generateImageAltText(image.url, sanitizedProductTitle, prompt, sendImagesToAI, {
          contextTexts: [sanitizedProductTitle],
          locale: writtenLocale,
        });
        generatedAltTexts[i] = altText;

        const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
        await db.task.update({
          where: { id: task.id },
          data: { progress: progressPercent, processed: i + 1 },
        });
      } catch (error: unknown) {
        // A managed refusal refuses every remaining image identically — stop
        // the run so the merchant sees why, instead of N empty alt texts. With
        // nothing generated yet it fails the request with the refusal; after
        // the first success it ends the loop and keeps what was delivered.
        if (isManagedRefusal(error)) {
          if (Object.keys(generatedAltTexts).length === 0) throw error;
          stoppedBy = error;
          break;
        }
        logger.error("Failed to generate alt-text for image", {
          context: "UnifiedContent",
          imageIndex: i,
          error: getFullErrorMessage(error),
        });
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: stoppedBy ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ generatedAltTexts }),
        ...(stoppedBy ? { error: getFullErrorMessage(stoppedBy) } : {}),
      },
    });

    return json({
      actionType: "generateAllAltTexts",
      success: true,
      generatedAltTexts,
      // The machine code (`managed_ai_refused:<reason>`); the client's error
      // translator phrases it in the merchant's language.
      ...(stoppedBy ? { warning: getFullErrorMessage(stoppedBy) } : {}),
    });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "generateAllAltTexts" });
    if (refused) return refused;
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE ALT-TEXT
// ============================================================================

export async function handleTranslateAltText(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, itemId, provider, serviceConfig } = ctx;

  const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
  const requestedMediaId = (getFormString(formData, "mediaId") || "").trim();
  const clientSourceAltText = getFormString(formData, "sourceAltText");
  const targetLocale = getFormString(formData, "targetLocale");
  if (!targetLocale || !isValidLocale(targetLocale)) {
    return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
  }

  // A named MEDIUM has its primary alt read here, from the cache this app
  // writes on every primary alt save -- the product's own image first, then
  // the media library (a library file shown only in a variant gallery). The
  // client's text is only the fallback for a caller that names no medium
  // (collections/articles, the editor's featured image). An id found in
  // neither is refused, never translated from whatever the client sent.
  let sourceAltText = clientSourceAltText;
  if (requestedMediaId && contentConfig.resourceType === "Product") {
    const dbProduct = await db.product.findUnique({
      where: { shop_id: { shop: session.shop, id: itemId } },
      include: { images: { orderBy: { position: "asc" } } },
    });
    const productImage = pickProductImage(dbProduct?.images, { mediaId: requestedMediaId });
    if (productImage) {
      sourceAltText = productImage.altText ?? "";
    } else {
      const libraryImage = await db.mediaLibraryImage.findUnique({
        where: { shop_id: { shop: session.shop, id: requestedMediaId } },
        select: { altText: true },
      });
      if (!libraryImage) {
        return json(
          { success: false, errorCode: ALT_IMAGE_NOT_FOUND, error: "Image not found on this product" },
          { status: 404 },
        );
      }
      sourceAltText = libraryImage.altText ?? "";
    }
  }

  // The SOURCE is the image's primary-language alt and nothing else. This
  // handler used to take whatever the client sent -- the image manager sent
  // the FOREIGN field's own text (a typed draft, or empty) -- and put it into
  // the JSON-shaped field-translate prompt with no source language named. An
  // empty or already-target-language text has no translation, the model
  // answered in prose, "Could not parse JSON from AI response" followed, and
  // every retry sent the same input and failed the same way. So: refuse an
  // empty source BEFORE any AI work, name the source language, and use the
  // plain-text single-value translate the /api/ai alt path uses (no JSON).
  // No try/catch: getCachedShopLocales maps every failure but a 401 to []
  // itself (which only costs the prompt its source-language name) and
  // re-throws the 401 on purpose, so the request can re-authenticate.
  let primaryLocale = getFormString(formData, "primaryLocale") || "";
  const { getCachedShopLocales } = await import("~/utils/shop-locales-cache.server");
  const shopLocales = await getCachedShopLocales(admin, session.shop);
  const primary = shopLocales.find((l) => l.primary)?.locale;
  if (primary) primaryLocale = primary;
  const plan = planAltTranslate({ sourceAltText, targetLocale, primaryLocale });
  if (!plan.ok) {
    return json(
      plan.reason === "noSource"
        ? { success: false, errorCode: ALT_NO_SOURCE_TEXT, error: "No primary-language alt text to translate" }
        : { success: false, error: "The target language is the primary language" },
      { status: 400 },
    );
  }

  // Name the ITEM. This row stored a `resourceId` and no title at all, so the
  // Tasks card rendered nothing for it — not even the Shopify link. No title
  // reaches this handler on the wire, so the cached one is read here; the
  // image is already named by `fieldType` ("Image N alt-text"), which is why
  // the subject is the plain product name and not a composed string.
  const taskResourceTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId,
  );
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: taskResourceTitle,
      fieldType: `altText_${imageIndex}`,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiServiceWithTask = new AIService(provider, serviceConfig, session.shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    const translatedAltText = (
      await aiServiceWithTask.translateContent(plan.source, plan.fromLang, targetLocale, undefined, "image alt text")
    ).trim();
    // An empty answer is not a translation: applied, it would CLEAR the
    // foreign alt the merchant asked to fill.
    if (!translatedAltText) {
      throw new Error("The AI returned an empty alt text translation");
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ translatedAltText, imageIndex, targetLocale }),
      },
    });

    return json({
      actionType: "translateAltText",
      success: true,
      translatedAltText,
      imageIndex,
      targetLocale,
    });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "translateAltText" });
    if (refused) return refused;
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

// ============================================================================
// TRANSLATE ALT-TEXT TO ALL LOCALES
// ============================================================================

export async function handleTranslateAltTextToAllLocales(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, session, contentConfig, db, itemId, provider, serviceConfig, shopifyContentService } = ctx;

  const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
  const requestedMediaId = getFormString(formData, "mediaId") || "";
  const sourceAltText = getFormString(formData, "sourceAltText");
  const productTitle = getFormString(formData, "productTitle") || "";
  const targetLocales = getFormJSON<string[]>(formData, "targetLocales");
  if (!targetLocales) {
    return json({ success: false, error: "Invalid targetLocales format" }, { status: 400 });
  }
  // Nothing to translate: refused before any AI work (see handleTranslateAltText).
  if (altTranslateSourceText(sourceAltText) === null) {
    return json(
      { success: false, errorCode: ALT_NO_SOURCE_TEXT, error: "No primary-language alt text to translate" },
      { status: 400 },
    );
  }

  // The medium is resolved by its id BEFORE any AI work is spent: a client
  // position is not a DB position, and an image that cannot be found is
  // refused, never replaced by image 0. (Articles/Collections have no
  // ProductImage rows and keep the index.)
  const isFeaturedImageResource = contentConfig.resourceType === 'Article' || contentConfig.resourceType === 'Collection';
  let resolvedDbImage: { mediaId: string | null } | undefined;
  if (!isFeaturedImageResource) {
    const dbProduct = await db.product.findUnique({
      where: { shop_id: { shop: session.shop, id: itemId } },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    resolvedDbImage = pickProductImage(dbProduct?.images, { mediaId: requestedMediaId, imageIndex });
    if (requestedMediaId && !resolvedDbImage) {
      return json(
        { success: false, errorCode: ALT_IMAGE_NOT_FOUND, error: "Image not found on this product" },
        { status: 404 },
      );
    }
  }

  // Same as its siblings: the item's title only (the form's first, the cached
  // one next). The image is named by `fieldType: altText_<i>`, which the Tasks
  // views render in the merchant's language ("Image 3 alt text") -- a number
  // composed into the title as well repeated it, in German on every UI.
  const resourceTitle = await taskTitleOrFallback(
    db, session.shop, contentConfig.resourceType, itemId, productTitle,
  );

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle,
      // The client's own operation key for this button, like its siblings:
      // the editor's spinner reconcile maps a running row back to it
      // (`taskOperationKey`). As "all" it read as a whole-item run.
      fieldType: `altText_${imageIndex}`,
      targetLocale: targetLocales.join(","),
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const translationServiceWithTask = new TranslationService(provider, serviceConfig, session.shop, task.id);

    const changedFields: Record<string, string> = {};
    changedFields[`altText_${imageIndex}`] = sourceAltText;

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    const translations = await translationServiceWithTask.translateProduct(
      changedFields,
      targetLocales,
      contentConfig.contentType
    );

    // Extract translated alt-texts for each locale
    const translatedAltTexts: Record<string, string> = {};
    for (const locale of targetLocales) {
      translatedAltTexts[locale] = translations[locale]?.[`altText_${imageIndex}`] || "";
    }

    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 50 },
    });

    // Save translations to Shopify first, then DB only on success
    const failedLocales: string[] = [];
    const savedLocales: string[] = [];

    // Articles/Collections store the featured image translation on a separate translatable
    // resource (ArticleImage / CollectionImage) and persist locally to `contentTranslation`,
    // not to `productImageAltTranslation`. Delegate to the shared helper.
    if (isFeaturedImageResource) {
      for (const locale of targetLocales) {
        const altText = translatedAltTexts[locale];
        if (!altText) continue;
        const result = await shopifyContentService.saveImageAltTextTranslation({
          resourceId: itemId,
          resourceType: contentConfig.resourceType as "Article" | "Collection",
          locale,
          altText,
          shop: session.shop,
          db,
        });
        if (result.saved) {
          savedLocales.push(locale);
        } else {
          failedLocales.push(locale);
        }
      }

      await db.task.update({
        where: { id: task.id },
        data: {
          status: altTranslateTaskStatus(failedLocales.length),
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ translatedAltTexts, imageIndex, targetLocales, savedLocales, failedLocales }),
        },
      });

      return json({
        actionType: "translateAltTextToAllLocales",
        success: true,
        translatedAltTexts,
        imageIndex,
        targetLocales,
        savedLocales,
        failedLocales,
      });
    }

    // Product path: image translations live on Shopify MediaImage GIDs and `productImageAltTranslation`.
    const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
    const gateway = new ShopifyApiGateway(admin, session.shop);

    const dbImage = resolvedDbImage;

    if (!dbImage?.mediaId) {
      // No mediaId = cannot save to Shopify, so don't save to DB either
      logger.warn("[UnifiedContent] No mediaId for image - cannot save alt-text translations to Shopify", {
        context: "UnifiedContent", imageIndex, productId: itemId,
      });
      failedLocales.push(...targetLocales);
    } else {
      // One verified register per locale (digest -> register -> echo): a
      // locale counts as saved, and is mirrored, ONLY when Shopify echoed it.
      const {
        registerMediaAltAndVerify,
        mirrorProductMediaAlt,
      } = await import("~/services/translations/verified-translations.server");
      // One digest read for this image, not one per locale.
      const digestCache = new Map<string, string | null>();
      for (const locale of targetLocales) {
        const altText = translatedAltTexts[locale];
        if (!altText) continue;

        let stored: string | null = null;
        try {
          const verified = await registerMediaAltAndVerify(gateway, dbImage.mediaId, locale, altText, undefined, { digestCache });
          if (verified.confirmed) {
            stored = verified.storedValue ?? altText;
          } else {
            logger.error("[UnifiedContent] Shopify did not confirm the alt-text translation", {
              context: "UnifiedContent", imageIndex, locale, noDigest: verified.noDigest, errors: verified.userErrors,
            });
          }
        } catch (shopifyError: unknown) {
          logger.error("[UnifiedContent] Error saving alt-text to Shopify", {
            context: "UnifiedContent", imageIndex, locale, error: shopifyError instanceof Error ? shopifyError.message : String(shopifyError),
          });
        }

        if (stored === null) {
          failedLocales.push(locale);
          continue;
        }
        // The detached alt repair watches the MEDIA resource it is about to
        // write (translation-locks.shared.ts); without this claim it never
        // sees the merchant write and overwrites it minutes later.
        markTranslationSaved(dbImage.mediaId);
        // The cache row is resolved from (productId, mediaId) NOW, never
        // captured: a product sync recreates ProductImage rows.
        const mirrored = await mirrorProductMediaAlt(db, {
          shop: session.shop, productId: itemId, mediaId: dbImage.mediaId, locale, value: stored,
        });
        if (mirrored === "imageGone") {
          logger.warn("[UnifiedContent] Image deleted during translation save (concurrent sync)", {
            context: "UnifiedContent", imageIndex, productId: itemId,
          });
        }
        savedLocales.push(locale);
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: altTranslateTaskStatus(failedLocales.length),
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ translatedAltTexts, imageIndex, targetLocales, savedLocales, failedLocales }),
      },
    });

    return json({
      actionType: "translateAltTextToAllLocales",
      success: true,
      translatedAltTexts,
      imageIndex,
      targetLocales,
      savedLocales,
      failedLocales,
    });
  } catch (error: unknown) {
    const errorMsg = getFullErrorMessage(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMsg,
      },
    });
    const refused = managedRefusalResponseFromError(error, ctx.aiSettings, { actionType: "translateAltTextToAllLocales" });
    if (refused) return refused;
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

/**
 * Generate Alt Text from Variant SKUs
 *
 * Finds all variants that reference this image in their custom.variant_gallery
 * metafield and generates an alt text from their comma-separated SKUs.
 */
export async function handleGenerateAltTextFromSku(
  ctx: ContentActionHandlerContext,
  formData: FormData
) {
  const mediaIds = formData.getAll("mediaId").map(v => String(v)).filter(Boolean);
  const productId = formData.get("productId") as string;

  if (mediaIds.length === 0 || !productId) {
    return json({ success: false, error: "mediaId(s) and productId required" }, { status: 400 });
  }

  // 1. Alle gecachten Varianten des Produkts laden
  const variants = await ctx.db.productVariant.findMany({
    where: { productId },
    select: { sku: true, galleryJson: true },
  });

  const results: Array<{ mediaId: string; altText: string }> = [];

  for (const mediaId of mediaIds) {
    const numericId = mediaId.replace("gid://shopify/MediaImage/", "").replace("gid://shopify/File/", "");

    const matchingSkus = variants
      .filter(v => {
        if (!v.galleryJson) return false;
        try {
          const gids: string[] = JSON.parse(v.galleryJson);
          return gids.some(gid => gid.includes(numericId) || gid === mediaId);
        } catch { return false; }
      })
      .filter(v => v.sku)
      .map(v => v.sku as string);

    if (matchingSkus.length === 0) continue;

    const altText = matchingSkus.join(",").slice(0, 512);
    results.push({ mediaId, altText });
  }

  if (results.length === 0) {
    return json({ success: false, error: "No variants with SKU found for these images" }, { status: 404 });
  }

  // The alts BEFORE the write, for the translation repair below.
  const { snapshotProductAlts, repairAltsAfterWrite } = await import(
    "../../services/translations/product-alt-repair.server"
  );
  const snapshot = await snapshotProductAlts(ctx.db, ctx.session.shop, results.map((r) => r.mediaId));
  const { snapshotLibraryAlts, purgeLibraryAltTranslationsAfterWrite } = await import(
    "../../services/translations/library-alt-repair.server"
  );
  const librarySnapshot = await snapshotLibraryAlts(ctx.db, ctx.session.shop, results.map((r) => r.mediaId));

  // 2. Alt-Text zu Shopify synchronisieren
  const updateResponse = await ctx.admin.graphql(`#graphql
    mutation fileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files { id ... on MediaImage { alt } }
        userErrors { field message }
      }
    }
  `, { variables: { files: results.map(r => ({ id: r.mediaId, alt: r.altText })) } });
  const updateData = (await updateResponse.json()) as {
    data?: { fileUpdate?: { files?: Array<{ id?: string; alt?: string | null }> | null; userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  const updateErrors = [
    ...(updateData.errors ?? []),
    ...(updateData.data?.fileUpdate?.userErrors ?? []),
  ];
  if (updateErrors.length > 0) {
    // `fileUpdate` applies the batch as a unit; nothing was written, so the
    // cache is left alone and nothing is repaired.
    return json({ success: false, error: updateErrors.map((e) => e.message).join("; ") }, { status: 502 });
  }

  // Only what Shopify ECHOED with the sent alt is a confirmed write: the cache
  // mirrors, the product repair and the library purge ride on that alone.
  const { fileUpdateEchoConfirms } = await import("~/utils/file-update-echo.server");
  const written = results.filter((r) =>
    fileUpdateEchoConfirms(updateData.data?.fileUpdate?.files, r.mediaId, r.altText),
  );
  if (written.length === 0) {
    return json({ success: false, error: "Shopify did not confirm the alt-text write" }, { status: 502 });
  }

  // 3. DB updaten
  // R4-DI7: scope by the owning product's shop. Shopify media GIDs are only
  // unique per shop, so an unscoped { mediaId } updateMany can overwrite a
  // different tenant's ProductImage on a GID collision (cross-tenant write).
  // Mirrors the deliberately-scoped persistAltText().
  await Promise.all(written.map(r =>
    ctx.db.productImage.updateMany({ where: { mediaId: r.mediaId, product: { shop: ctx.session.shop } }, data: { altText: r.altText } })
  ));

  // The library cache too (a file with no ProductImage row): without it the
  // next snapshot keeps the old "before" and an identical later write would
  // count as a change again.
  await Promise.all(written.map((r) =>
    ctx.db.mediaLibraryImage
      .updateMany({ where: { shop: ctx.session.shop, id: r.mediaId }, data: { altText: r.altText } })
      .catch((e: unknown) => logger.warn("[generateAltTextFromSku] media-library cache update failed", { error: e instanceof Error ? e.message : String(e) })),
  ));

  // The foreign alts of what changed — one run per product
  // (product-alt-repair.server.ts); never fails the write.
  const retranslationTaskIds = await repairAltsAfterWrite({
    gateway: new ShopifyApiGateway(ctx.admin as never, ctx.session.shop),
    db: ctx.db,
    shop: ctx.session.shop,
    snapshot,
    written: written.map((r) => ({ mediaId: r.mediaId, alt: r.altText })),
  });
  // A library file's foreign translations describe the old alt: deleted
  // (library-alt-repair.server.ts); never fails the write.
  const libraryAltsPurged = await purgeLibraryAltTranslationsAfterWrite({
    gateway: new ShopifyApiGateway(ctx.admin as never, ctx.session.shop),
    db: ctx.db,
    shop: ctx.session.shop,
    snapshot: librarySnapshot,
    written: written.map((r) => ({ mediaId: r.mediaId, alt: r.altText })),
  });

  return json({
    success: true,
    updated: written.length,
    ...(retranslationTaskIds.length > 0 ? { retranslationTaskIds } : {}),
    ...(libraryAltsPurged.length > 0 ? { libraryAltsPurged } : {}),
  });
}

// ============================================================================
// SAVE IMAGE ALT-TEXT (single image, primary or foreign locale)
// ============================================================================

export async function handleSaveImageAltText(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { admin, db, session } = ctx;
  const mediaId = getFormString(formData, "mediaId");
  const altText = getFormString(formData, "altText") ?? "";
  const locale = getFormString(formData, "locale") || null;
  const primaryLocale = getFormString(formData, "primaryLocale") || null;
  // The MARKET layer the merchant is editing (foreign locales only: the
  // primary alt is one value for every market). Validated here because the
  // action takes a direct POST and the id lands in a Shopify mutation.
  const rawMarketId = getFormString(formData, "marketId") || "";
  if (rawMarketId && !MARKET_GID_RE.test(rawMarketId)) {
    return json({ success: false, error: "Invalid marketId" }, { status: 400 });
  }

  if (!mediaId) {
    return json({ success: false, error: "mediaId required" }, { status: 400 });
  }
  // The product being edited: its own ProductImage row is the mirror target.
  const rawProductId = getFormString(formData, "productId") || ctx.itemId || "";
  const editedProductId = PRODUCT_GID_RE.test(rawProductId) ? rawProductId : "";

  let shopifySaved = false;
  let notMirrored = false;
  let retranslationTaskIds: string[] = [];
  let libraryAltsPurged: string[] = [];

  if (!locale || locale === primaryLocale) {
    // Primary locale: fileUpdate + shop-scoped cache write (shared helper).
    const result = await saveImageAltTextPrimary({ admin, db, shop: session.shop, mediaId, altText });
    if (result.apiError) {
      return json({ success: false, error: "Shopify API error" }, { status: 500 });
    }
    shopifySaved = result.saved;
    retranslationTaskIds = result.retranslationTaskId ? [result.retranslationTaskId] : [];
    libraryAltsPurged = result.libraryAltsPurged ?? [];
  } else {
    // Only a MediaImage GID ever reaches the translation write and the
    // mirror's library branch (the action takes a direct POST).
    if (!MEDIA_IMAGE_GID_RE.test(mediaId)) {
      return json({ success: false, error: "Invalid mediaId" }, { status: 400 });
    }
    // Foreign locale: verified register (digest -> register -> echo). A write
    // Shopify accepted without storing is NOT a save and is not mirrored.
    const {
      registerMediaAltAndVerify,
      removeMediaAltAndVerify,
      mirrorImageAltAnyStore,
    } = await import("~/services/translations/verified-translations.server");

    const marketId = rawMarketId;
    let storedAlt = altText;
    let storedDigest: string | null = null;
    try {
      if (altText.trim() === "") {
        // Clearing means REMOVING the translation (a register of "" is
        // refused); the local row goes only when the removal is confirmed.
        const removal = await removeMediaAltAndVerify(admin, mediaId, locale, marketId);
        shopifySaved = removal.confirmed;
        if (!shopifySaved) {
          logger.error("[saveImageAltText] Shopify did not confirm removing the alt translation", { errors: removal.userErrors });
        }
      } else {
        const verified = await registerMediaAltAndVerify(admin, mediaId, locale, altText, marketId || undefined);
        if (verified.noDigest) {
          // The image has no PRIMARY alt: Shopify offers nothing to translate.
          // Named, so the image manager can say so and drop the draft instead
          // of keeping one no retry can ever store.
          return json(
            { actionType: "saveImageAltText", success: false, errorCode: ALT_NO_PRIMARY, error: "The image has no alt text in the primary language" },
            { status: 400 },
          );
        }
        shopifySaved = verified.confirmed;
        if (shopifySaved) {
          storedAlt = verified.storedValue ?? altText;
          storedDigest = verified.digest ?? null;
        }
        else logger.error("[saveImageAltText] Shopify did not confirm the alt translation", { errors: verified.userErrors });
      }
    } catch (err: unknown) {
      logger.error("[saveImageAltText] translation write error", { error: String(err) });
      return json({ success: false, error: "Shopify translation API error" }, { status: 500 });
    }

    if (shopifySaved) {
      // Claim the MEDIA resource: a detached alt re-translation watches its own
      // lock AND every resource it is about to write, so marking the image is
      // both precise and enough — without it the AI would overwrite the value
      // the merchant just accepted.
      // The bare MediaImage id is what a repair run watches; a MARKET write
      // must not abort it (a repair writes global rows only), so it marks the
      // market-layer key instead. Both layers also mark the product's alt-sync
      // shield -- the one key the products/update sync actually asks for -- so
      // the rewrite stays off the alt cache until Shopify's read-back caught up.
      markTranslationSaved(marketId ? marketLayerLockId(mediaId) : mediaId);
      const owningProduct = await db.productImage
        .findFirst({ where: { mediaId, product: { shop: session.shop } }, select: { productId: true } })
        .catch(() => null);
      if (owningProduct?.productId) markTranslationSaved(altTextSyncShieldId(owningProduct.productId));
      if (editedProductId && editedProductId !== owningProduct?.productId) markTranslationSaved(altTextSyncShieldId(editedProductId));
      try {
        // Shop-scoped, resolved now (R4-DI7): an unscoped mediaId lookup could
        // resolve another tenant's ProductImage. A cleared value deletes ONLY
        // the row of the layer that was written -- the global one, or this
        // market's -- never the other layer. An image with NO ProductImage row
        // (a media-library file picked into a variant gallery) mirrors into
        // ContentTranslation("MediaImage"), the bulk editor's store for it;
        // this used to answer "imageGone" silently while the save reported
        // success, and the next load wiped the value from the field.
        // One GID may be cached under several products: the value (or the
        // confirmed clear) goes onto EVERY ProductImage row of the shop with
        // that mediaId, because the translation lives on the one MediaImage
        // they all show. A product medium whose rows a concurrent sync is
        // recreating is retried once and otherwise reported, never written
        // as a stray library row.
        const store = await mirrorImageAltAnyStore(db, {
          shop: session.shop,
          mediaId,
          locale,
          marketId,
          value: altText.trim() === "" ? "" : storedAlt,
          digest: storedDigest,
          ...(editedProductId ? { productId: editedProductId } : {}),
        });
        if (store === "notMirrored") {
          notMirrored = true;
          logger.error("[saveImageAltText] translation saved on Shopify but its product image row is gone", {
            mediaId,
            locale,
            marketId,
          });
        }
      } catch (err: unknown) {
        // Shopify holds the value, so the save stays a success -- but the
        // local mirror every editor renders from does not, and that is said
        // rather than swallowed.
        notMirrored = true;
        logger.error("[saveImageAltText] translation saved on Shopify but not mirrored locally", {
          mediaId,
          locale,
          marketId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return json({
    actionType: "saveImageAltText",
    success: shopifySaved,
    ...(notMirrored ? { notMirrored: true } : {}),
    ...(retranslationTaskIds.length > 0 ? { retranslationTaskIds } : {}),
    ...(libraryAltsPurged.length > 0 ? { libraryAltsPurged } : {}),
  });
}

// ============================================================================
// LOAD IMAGE ALT-TEXT TRANSLATIONS (for a given product + locale)
// Returns { mediaId → altText } map from DB
// ============================================================================

/** A gallery shows at most a few hundred media; the cap only bounds a direct POST. */
const MAX_GALLERY_MEDIA_IDS = 500;

export interface ImageAltLayerRow {
  mediaId: string;
  marketId: string;
  altText: string;
}

/**
 * ONE layer out of alt rows of both stores: the global rows, overlaid by the
 * selected market's rows; with a market, every image whose value comes from
 * the GLOBAL fallback (non-empty, no own market row) is listed in
 * `inheritedMediaIds` so the client shows it as a placeholder, never a value.
 */
export function layerImageAltRows(
  rows: readonly ImageAltLayerRow[],
  marketId: string,
): { altTexts: Record<string, string>; inheritedMediaIds: string[] } {
  const altTexts: Record<string, string> = {};
  const inheritedMediaIds: string[] = [];
  // Global first, so a market row of the same image overrides it.
  for (const row of rows) {
    if ((row.marketId ?? "") === "") altTexts[row.mediaId] = row.altText;
  }
  if (marketId) {
    const overridden = new Set<string>();
    for (const row of rows) {
      if ((row.marketId ?? "") === marketId) {
        altTexts[row.mediaId] = row.altText;
        overridden.add(row.mediaId);
      }
    }
    for (const mediaId of Object.keys(altTexts)) {
      if (!overridden.has(mediaId) && altTexts[mediaId].trim() !== "") inheritedMediaIds.push(mediaId);
    }
  }
  return { altTexts, inheritedMediaIds };
}

/**
 * One MediaImage GID may be cached under SEVERAL products (a shared medium),
 * each with its own ProductImageAltTranslation rows. Every writer mirrors onto
 * ALL of those rows (`mirrorProductMediaAlt`), so they normally agree and this
 * is only a TIE-BREAK (rows written before that rule, or a row a sync just
 * recreated): the rows of OTHER products only stand in for a medium THIS
 * product has no row for; where this product holds a row for the medium (any
 * layer), every foreign-product row of it is dropped.
 */
export function preferOwnProductAltRows(
  rows: ReadonlyArray<{ altText: string; marketId: string | null; image: { mediaId: string | null; productId: string } | null }>,
  productId: string,
): ImageAltLayerRow[] {
  const withMedia = rows.filter((r) => !!r.image?.mediaId);
  const ownMedia = new Set(withMedia.filter((r) => r.image!.productId === productId).map((r) => r.image!.mediaId as string));
  return withMedia
    .filter((r) => r.image!.productId === productId || !ownMedia.has(r.image!.mediaId as string))
    .map((r) => ({ mediaId: r.image!.mediaId as string, marketId: r.marketId ?? "", altText: r.altText }));
}

export async function handleLoadImageAltTranslations(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { db, session } = ctx;
  const productId = getFormString(formData, "productId") || ctx.itemId;
  const locale = getFormString(formData, "locale");
  const marketId = getFormString(formData, "marketId") || "";

  if (!productId || !locale) {
    return json({ success: false, error: "productId and locale required" }, { status: 400 });
  }
  if (marketId && !MARKET_GID_RE.test(marketId)) {
    return json({ success: false, error: "Invalid marketId" }, { status: 400 });
  }

  // Media-library files shown in this product's galleries (a library pick in a
  // variant gallery has no ProductImage row). The client names the GIDs it
  // shows; only well-formed MediaImage GIDs are taken, capped, and every read
  // below is shop-scoped, so a foreign id can read nothing of another tenant.
  let galleryMediaIds: string[] = [];
  const rawMediaIds = getFormString(formData, "mediaIds");
  if (rawMediaIds) {
    try {
      const parsed = JSON.parse(rawMediaIds);
      if (Array.isArray(parsed)) {
        galleryMediaIds = [...new Set(parsed.filter((v): v is string => typeof v === "string" && MEDIA_IMAGE_GID_RE.test(v)))]
          .slice(0, MAX_GALLERY_MEDIA_IDS);
      }
    } catch {
      // A malformed list reads the product's own images only.
    }
  }

  // ONE layer per answer. The rows of every market and the global one share
  // (image, locale) and used to be mixed here, the last row winning. With a
  // market selected the market's rows are read plus the global ones as the
  // fallback, exactly the editor's display chain (market, else global); with
  // none, the global layer alone.
  const marketFilter = marketId ? { in: ["", marketId] } : "";
  const productRows = await db.productImageAltTranslation.findMany({
    where: {
      locale,
      marketId: marketFilter,
      image: {
        product: { shop: session.shop },
        ...(galleryMediaIds.length > 0
          ? { OR: [{ productId }, { mediaId: { in: galleryMediaIds } }] }
          : { productId }),
      },
    },
    select: { altText: true, marketId: true, image: { select: { mediaId: true, productId: true } } },
  });
  const rows: ImageAltLayerRow[] = preferOwnProductAltRows(
    productRows as Array<{ altText: string; marketId: string; image: { mediaId: string | null; productId: string } | null }>,
    productId,
  );
  // The product rows' own (media, layer) keys: a library row for the same key
  // never replaces them.
  const productKeys = new Set(rows.map((r) => `${r.mediaId}|${r.marketId}`));

  // The library half: a GID with NO ProductImage row anywhere in the shop is
  // mirrored in ContentTranslation("MediaImage") -- the same split the save
  // and the bulk editor apply ("by whether a ProductImage row exists").
  if (galleryMediaIds.length > 0) {
    const productBacked = await db.productImage.findMany({
      where: { mediaId: { in: galleryMediaIds }, product: { shop: session.shop } },
      select: { mediaId: true },
    });
    const backed = new Set(productBacked.map((r: { mediaId: string | null }) => r.mediaId));
    // Product-backed media are read too, as a FALLBACK per (media, layer):
    // a file that became product-backed while its foreign alts still sit in
    // the library store (the old template apply created the row) would
    // otherwise show them empty. Product rows win; every writer retires the
    // library rows of a product-backed medium (`mirrorProductMediaAlt`).
    const libraryIds = galleryMediaIds;
    if (libraryIds.length > 0) {
      const libraryRows = await db.contentTranslation.findMany({
        where: {
          shop: session.shop,
          resourceType: "MediaImage",
          resourceId: { in: libraryIds },
          key: "alt",
          locale,
          marketId: marketFilter,
        },
        select: { resourceId: true, marketId: true, value: true },
      });
      for (const r of libraryRows) {
        const marketOfRow = r.marketId ?? "";
        if (backed.has(r.resourceId) && productKeys.has(`${r.resourceId}|${marketOfRow}`)) continue;
        // An empty value is no translation (null rows exist per key).
        if (backed.has(r.resourceId) && !(r.value ?? "").trim()) continue;
        rows.push({ mediaId: r.resourceId, marketId: marketOfRow, altText: r.value ?? "" });
      }
    }
  }

  const { altTexts, inheritedMediaIds } = layerImageAltRows(rows, marketId);

  return json({ actionType: "loadImageAltTranslations", locale, marketId, altTexts, inheritedMediaIds });
}

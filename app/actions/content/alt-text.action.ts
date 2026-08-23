/**
 * Alt-Text Action Handlers
 *
 * Extracted from unified-content.actions.ts
 * Handles: generateAltText, generateAllAltTexts, translateAltText, translateAltTextToAllLocales
 */

import { data as json } from "react-router";
import { AIService, toValidProvider } from "../../../src/services/ai.service";
import { TranslationService } from "../../../src/services/translation.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import { decryptApiKey } from "../../utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
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
}): Promise<{ saved: boolean; userErrors: string[]; apiError?: string }> {
  const { admin, db, shop, mediaId, altText } = opts;
  try {
    const r = await admin.graphql(
      `#graphql
        mutation fileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) { userErrors { field message } }
        }`,
      { variables: { files: [{ id: mediaId, alt: altText }] } }
    );
    const d = await r.json() as any;
    const userErrors: Array<{ message: string }> = d.data?.fileUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { saved: false, userErrors: userErrors.map((e) => e.message) };
    }
  } catch (err: unknown) {
    logger.error("[saveImageAltText] fileUpdate error", { error: String(err) });
    return { saved: false, userErrors: [], apiError: String(err) };
  }

  await db.productImage.updateMany({
    where: { mediaId, product: { shop } },
    data: { altText: altText || null, altTextModifiedAt: new Date() },
  }).catch((e) => {
    logger.warn("[saveImageAltText] DB cache update failed", { error: e instanceof Error ? e.message : String(e) });
  });

  return { saved: true, userErrors: [] };
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

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: productTitle,
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

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkAIGeneration",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle: productTitle,
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
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ generatedAltTexts }),
      },
    });

    return json({ actionType: "generateAllAltTexts", success: true, generatedAltTexts });
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
  const { session, contentConfig, db, itemId, provider, serviceConfig } = ctx;

  const imageIndex = getFormInt(formData, "imageIndex") ?? 0;
  const sourceAltText = getFormString(formData, "sourceAltText");
  const targetLocale = getFormString(formData, "targetLocale");
  if (!targetLocale || !isValidLocale(targetLocale)) {
    return json({ success: false, error: "Invalid target locale format" }, { status: 400 });
  }

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      fieldType: `altText_${imageIndex}`,
      targetLocale,
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
      [targetLocale],
      contentConfig.contentType
    );
    const translatedAltText = translations[targetLocale]?.[`altText_${imageIndex}`] || "";

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
  const sourceAltText = getFormString(formData, "sourceAltText");
  const productTitle = getFormString(formData, "productTitle") || "";
  const targetLocales = getFormJSON<string[]>(formData, "targetLocales");
  if (!targetLocales) {
    return json({ success: false, error: "Invalid targetLocales format" }, { status: 400 });
  }

  const resourceTitle = productTitle
    ? `${productTitle} – Bild ${imageIndex + 1}`
    : `Bild ${imageIndex + 1}`;

  // Create task entry
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentConfig.resourceType,
      resourceId: itemId,
      resourceTitle,
      fieldType: "all",
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
    if (contentConfig.resourceType === 'Article' || contentConfig.resourceType === 'Collection') {
      for (const locale of targetLocales) {
        const altText = translatedAltTexts[locale];
        if (!altText) continue;
        const result = await shopifyContentService.saveImageAltTextTranslation({
          resourceId: itemId,
          resourceType: contentConfig.resourceType,
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
          status: "completed",
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

    // Get DB product image to find mediaId
    const dbProduct = await db.product.findUnique({
      where: { id: itemId },
      include: {
        images: {
          orderBy: { position: 'asc' },
        },
      },
    });

    const dbImage = dbProduct?.images?.[imageIndex];

    if (!dbImage?.mediaId) {
      // No mediaId = cannot save to Shopify, so don't save to DB either
      logger.warn("[UnifiedContent] No mediaId for image - cannot save alt-text translations to Shopify", {
        context: "UnifiedContent", imageIndex, productId: itemId,
      });
      failedLocales.push(...targetLocales);
    } else {
      // Fetch digest once (shared for all locales)
      let altDigest: string | undefined;
      try {
        const translatableResponse = await gateway.graphql(
          `#graphql
            query translatableContent($resourceId: ID!) {
              translatableResource(resourceId: $resourceId) {
                resourceId
                translatableContent {
                  key
                  digest
                  value
                }
              }
            }`,
          { variables: { resourceId: dbImage.mediaId } }
        );
        const translatableData = await translatableResponse.json() as any;
        const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
        altDigest = translatableContent.find((c: { key: string; digest: string }) => c.key === "alt")?.digest;
      } catch (err: unknown) {
        logger.error("[UnifiedContent] Error fetching translatable content for alt-text", {
          context: "UnifiedContent", imageIndex, error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!altDigest) {
        logger.warn("[UnifiedContent] No digest for alt-text - cannot save to Shopify", {
          context: "UnifiedContent", imageIndex, mediaId: dbImage.mediaId,
        });
        failedLocales.push(...targetLocales);
      } else {
        // Save each locale to Shopify, then DB
        for (const locale of targetLocales) {
          const altText = translatedAltTexts[locale];
          if (!altText) continue;

          let shopifySaved = false;
          try {
            const shopifyResult = await gateway.graphql(
              `#graphql
                mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                  translationsRegister(resourceId: $resourceId, translations: $translations) {
                    userErrors { field message }
                    translations { locale key value }
                  }
                }`,
              {
                variables: {
                  resourceId: dbImage.mediaId,
                  translations: [{
                    key: "alt",
                    value: altText,
                    locale: locale,
                    translatableContentDigest: altDigest,
                  }],
                },
              }
            );
            const shopifyData = await shopifyResult.json() as any;
            const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
            if (userErrors.length === 0) {
              shopifySaved = true;
            } else {
              logger.error("[UnifiedContent] Shopify translationsRegister userErrors for alt-text", {
                context: "UnifiedContent", imageIndex, locale, errors: userErrors,
              });
            }
          } catch (shopifyError: unknown) {
            logger.error("[UnifiedContent] Error saving alt-text to Shopify", {
              context: "UnifiedContent", imageIndex, locale, error: shopifyError instanceof Error ? shopifyError.message : String(shopifyError),
            });
          }

          // Only save to DB if Shopify succeeded
          if (shopifySaved) {
            try {
              const existing = await db.productImageAltTranslation.findUnique({
                where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale } },
              });
              if (existing) {
                await db.productImageAltTranslation.update({ where: { id: existing.id }, data: { altText } });
              } else {
                await db.productImageAltTranslation.create({ data: { imageId: dbImage.id, locale, altText } });
              }
              savedLocales.push(locale);
            } catch (dbError: unknown) {
              const dbErr = dbError instanceof Error ? dbError : new Error(String(dbError));
              const dbErrCode = (dbError as { code?: string })?.code;
              if (dbErrCode === 'P2003' || dbErr.message?.includes('Foreign key constraint')) {
                logger.warn("[UnifiedContent] Image deleted during translation save (concurrent sync)", {
                  context: "UnifiedContent", imageIndex, productId: itemId, error: dbErr.message,
                });
              } else {
                throw dbError;
              }
            }
          } else {
            failedLocales.push(locale);
          }
        }
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
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

  // 2. Alt-Text zu Shopify synchronisieren
  await ctx.admin.graphql(`
    mutation fileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) { userErrors { field message } }
    }
  `, { variables: { files: results.map(r => ({ id: r.mediaId, alt: r.altText })) } });

  // 3. DB updaten
  // R4-DI7: scope by the owning product's shop. Shopify media GIDs are only
  // unique per shop, so an unscoped { mediaId } updateMany can overwrite a
  // different tenant's ProductImage on a GID collision (cross-tenant write).
  // Mirrors the deliberately-scoped persistAltText().
  await Promise.all(results.map(r =>
    ctx.db.productImage.updateMany({ where: { mediaId: r.mediaId, product: { shop: ctx.session.shop } }, data: { altText: r.altText } })
  ));

  return json({ success: true, updated: results.length });
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

  if (!mediaId) {
    return json({ success: false, error: "mediaId required" }, { status: 400 });
  }

  let shopifySaved = false;

  if (!locale || locale === primaryLocale) {
    // Primary locale: fileUpdate + shop-scoped cache write (shared helper).
    const result = await saveImageAltTextPrimary({ admin, db, shop: session.shop, mediaId, altText });
    if (result.apiError) {
      return json({ success: false, error: "Shopify API error" }, { status: 500 });
    }
    shopifySaved = result.saved;
  } else {
    // Foreign locale: use translationsRegister (needs digest from Shopify)
    let altDigest: string | undefined;
    try {
      const tr = await admin.graphql(
        `#graphql
          query translatableContent($id: ID!) {
            translatableResource(resourceId: $id) {
              translatableContent { key digest }
            }
          }`,
        { variables: { id: mediaId } }
      );
      const td = await tr.json() as any;
      altDigest = (td.data?.translatableResource?.translatableContent ?? [])
        .find((c: { key: string; digest?: string }) => c.key === "alt")?.digest;
    } catch (err: unknown) {
      logger.error("[saveImageAltText] translatableContent error", { error: String(err) });
    }

    if (!altDigest) {
      return json({ success: false, error: "No digest found for alt-text translation" }, { status: 400 });
    }

    try {
      const r = await admin.graphql(
        `#graphql
          mutation translateMedia($resourceId: ID!, $translations: [TranslationInput!]!) {
            translationsRegister(resourceId: $resourceId, translations: $translations) {
              userErrors { field message }
            }
          }`,
        {
          variables: {
            resourceId: mediaId,
            translations: [{ key: "alt", value: altText, locale, translatableContentDigest: altDigest }],
          },
        }
      );
      const d = await r.json() as any;
      shopifySaved = (d.data?.translationsRegister?.userErrors ?? []).length === 0;
    } catch (err: unknown) {
      logger.error("[saveImageAltText] translationsRegister error", { error: String(err) });
      return json({ success: false, error: "Shopify translation API error" }, { status: 500 });
    }

    if (shopifySaved) {
      // Claim the MEDIA resource: a detached alt re-translation watches its own
      // lock AND every resource it is about to write, so marking the image is
      // both precise and enough — without it the AI would overwrite the value
      // the merchant just accepted.
      markTranslationSaved(mediaId);
      try {
        // R4-DI7: shop-scoped — an unscoped mediaId findFirst could resolve
        // another tenant's ProductImage (per-shop-unique GIDs can collide)
        // and we'd then write this shop's translation onto their row.
        const dbImage = await db.productImage.findFirst({ where: { mediaId, product: { shop: session.shop } }, select: { id: true } });
        if (dbImage) {
          if (altText.trim() === "") {
            // Scope to the global layer only — a global clear must not wipe
            // market-specific alt overrides for the same locale.
            await db.productImageAltTranslation.deleteMany({ where: { imageId: dbImage.id, locale, marketId: "" } });
          } else {
            await db.productImageAltTranslation.upsert({
              where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale } },
              create: { imageId: dbImage.id, locale, altText },
              update: { altText },
            });
          }
        }
      } catch {
        // DB update is best-effort; Shopify is the source of truth
      }
    }
  }

  return json({ actionType: "saveImageAltText", success: shopifySaved });
}

// ============================================================================
// LOAD IMAGE ALT-TEXT TRANSLATIONS (for a given product + locale)
// Returns { mediaId → altText } map from DB
// ============================================================================

export async function handleLoadImageAltTranslations(
  ctx: ContentActionHandlerContext,
  formData: FormData,
): Promise<DataResponse> {
  const { db } = ctx;
  const productId = getFormString(formData, "productId") || ctx.itemId;
  const locale = getFormString(formData, "locale");

  if (!productId || !locale) {
    return json({ success: false, error: "productId and locale required" }, { status: 400 });
  }

  const rows = await db.productImageAltTranslation.findMany({
    where: { locale, image: { productId } },
    select: { altText: true, image: { select: { mediaId: true } } },
  });

  const altTexts: Record<string, string> = {};
  for (const row of rows) {
    if (row.image?.mediaId) {
      altTexts[row.image.mediaId] = row.altText;
    }
  }

  return json({ actionType: "loadImageAltTranslations", locale, altTexts });
}

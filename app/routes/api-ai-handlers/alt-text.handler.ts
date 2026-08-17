import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isPrismaError, isAuthError } from "./shared";
import type { TranslatableContentItem } from "./shared";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { withUserInstruction } from "~/utils/ai-user-instruction.server";
import { safeJsonParse, isValidLocale, isValidShopifyGID } from "~/utils/validation";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../../graphql/content.mutations";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import { getCharacterLimitRequirement } from "~/utils/character-limits";
import { loadTrackedKeywordsUnfiltered, resolveKeywordLocale } from "./keyword-prompt";
import type { DataResponse } from "~/types/data-response";

/**
 * Alt-text requirement line for the item's primary keyword. The shipped default
 * `productAltTextInstructions` has always said "Include the main keyword" — but
 * no keyword was ever passed, so the model had to guess one. Alt text is short
 * and accessibility-first, so only the PRIMARY keyword is offered and only
 * "if it genuinely describes the image": stuffing an alt attribute is both an
 * SEO and an accessibility regression.
 */
function altTextKeywordLine(primary: string | null): string {
  return primary
    ? `\n- Include the target keyword "${primary}" if it genuinely describes what is visible (never at the cost of accuracy)`
    : "";
}

// Reject a malformed productId before it reaches a DB lookup or Shopify
// mutation. productId is optional in several flows, so an empty value passes
// (the callers already guard on `if (productId && ...)`); only a non-empty,
// non-GID value is rejected.
function invalidProductGidResponse(productId: string): DataResponse | null {
  if (productId && !isValidShopifyGID(productId)) {
    return json({ success: false, error: `Invalid product GID: ${productId}` }, { status: 400 });
  }
  return null;
}

export async function handleGenerateAltText(ctx: AIActionContext): Promise<DataResponse> {
  const { session, db, settings, formData, contentType, itemId } = ctx;

  const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
  const imageUrl = getFormString(formData, "imageUrl");
  const productTitle = getFormString(formData, "productTitle");
  const mainLanguage = getFormString(formData, "mainLanguage") || "German";
  const sendImageToAI = formData.get("sendImageToAI") === "true";

  if (!imageUrl) {
    return json({ success: false, error: "No image URL provided" }, { status: 400 });
  }

  // Load AI instructions
  const aiInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  // Alt text has no editor field key of its own, so the unfiltered loader is
  // used; the locale follows the same client-sent contract as generation.
  const trackedKeywords = await loadTrackedKeywordsUnfiltered(
    db,
    session.shop,
    itemId,
    resolveKeywordLocale(formData),
  );

  // Create task entry with prompt
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: productTitle,
      fieldType: `altText_${imageIndex}`,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const aiService = createAIService(settings, session.shop, task.id);

    logger.debug("[API-AI] Generating alt-text for image", {
      context: "AI",
      imageIndex,
      productTitle,
      textLength: imageUrl.length
    });

    let prompt = `Create an optimized alt text for a product image.

Product: ${productTitle}
Image URL: ${imageUrl}${mainLanguage ? `\nLanguage: ${mainLanguage}` : ''}`;

    // Add requirements
    prompt += `\n\nRequirements:`;
    const altTextCharLimit = getCharacterLimitRequirement("productAltText", { limits: ctx.seoLimits });
    if (altTextCharLimit) {
      prompt += `\n- Length: ${altTextCharLimit}`;
    }
    prompt += `\n- Describe what's visible in the image`;
    prompt += `\n- Include product name or key feature`;
    prompt += `\n- Accessible and helpful for screen readers`;
    prompt += altTextKeywordLine(trackedKeywords.primary);

    const altTextFormat = getInstructionWithDefault(aiInstructions, "productAltTextFormat");
    if (altTextFormat) {
      prompt += `\n\nFormat Example:\n${altTextFormat}`;
    }

    const altTextInstructions = getInstructionWithDefault(aiInstructions, "productAltTextInstructions");
    if (altTextInstructions) {
      prompt += `\n\nGuidelines:\n${altTextInstructions}`;
    }

    prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

    // Ad-hoc instruction from the prompt box on the alt-text field — appended
    // last and outranking every rule above. No-op when the box was empty.
    prompt = withUserInstruction(prompt, formData);

    const altText = await aiService.generateImageAltText(imageUrl, productTitle, prompt, sendImageToAI);

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: altText,
      },
    });

    return json({
      success: true,
      altText,
      imageIndex
    });
  } catch (error: unknown) {
    // Update task to failed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

export async function handleGenerateAllAltTexts(ctx: AIActionContext): Promise<DataResponse> {
  const { session, db, settings, formData, contentType } = ctx;

  const productId = getFormString(formData, "productId");
  const gidErr1 = invalidProductGidResponse(productId);
  if (gidErr1) return gidErr1;
  const productTitle = getFormString(formData, "productTitle");
  const mainLanguage = getFormString(formData, "mainLanguage") || "German";
  const imagesDataJson = getFormString(formData, "imagesData");
  const sendImageToAI = formData.get("sendImageToAI") === "true";

  if (!imagesDataJson) {
    return json({ success: false, error: "No images data provided" }, { status: 400 });
  }

  const imagesData = safeJsonParse<Array<{ url: string }>>(imagesDataJson, []);
  const totalImages = imagesData.length;

  if (totalImages === 0) {
    return json({ success: false, error: "No images to process" }, { status: 400 });
  }

  // Bound the per-request AI fan-out (one queued AI call per image).
  const MAX_IMAGES_PER_REQUEST = 250;
  if (totalImages > MAX_IMAGES_PER_REQUEST) {
    return json(
      { success: false, error: `Too many images in one request (max ${MAX_IMAGES_PER_REQUEST}, got ${totalImages})` },
      { status: 413 },
    );
  }

  const altTextInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });
  const sharedFormat = getInstructionWithDefault(altTextInstructions, "productAltTextFormat");
  const sharedInstructions = getInstructionWithDefault(altTextInstructions, "productAltTextInstructions");
  const charLimit = getCharacterLimitRequirement("productAltText", { limits: ctx.seoLimits });
  // Resolved ONCE for the whole batch: every image belongs to the same product,
  // so the tracked keywords are identical — no reason to re-query per image.
  const keywordLine = altTextKeywordLine(
    (
      await loadTrackedKeywordsUnfiltered(
        db,
        session.shop,
        productId,
        resolveKeywordLocale(formData),
      )
    ).primary,
  );

  const bulkTask = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkAIGeneration",
      status: "running",
      resourceType: contentType,
      resourceId: productId,
      resourceTitle: productTitle,
      fieldType: "allAltTexts",
      progress: 0,
      total: totalImages,
      processed: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: the heavy AI loop runs detached from the HTTP request.
  // If the user navigates away, Node keeps the promise alive — progress and
  // partial results are persisted to Task.result after every image, so a
  // server restart only loses the in-flight image (TaskRecoveryService will
  // mark stalled tasks as failed after 10 min).
  void runBulkAltTextGeneration(bulkTask.id, {
    db,
    settings,
    shop: session.shop,
    imagesData,
    productTitle,
    mainLanguage,
    sendImageToAI,
    charLimit,
    format: sharedFormat,
    instructions: sharedInstructions,
    keywordLine,
  }).catch((err) => {
    logger.error("[API-AI] Bulk alt-text generation crashed", {
      context: "AI",
      taskId: bulkTask.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: bulkTask.id, total: totalImages });
}

interface BulkAltTextRunArgs {
  db: AIActionContext["db"];
  settings: AIActionContext["settings"];
  shop: string;
  imagesData: Array<{ url: string }>;
  productTitle: string;
  mainLanguage: string;
  sendImageToAI: boolean;
  charLimit: string | null;
  format: string;
  instructions: string;
  /** Pre-rendered target-keyword requirement, "" when the product tracks none. */
  keywordLine: string;
}

async function runBulkAltTextGeneration(taskId: string, args: BulkAltTextRunArgs): Promise<void> {
  const { db, settings, shop, imagesData, productTitle, mainLanguage, sendImageToAI, charLimit, format, instructions, keywordLine } = args;
  const totalImages = imagesData.length;
  const aiService = createAIService(settings, shop, taskId);
  const generatedAltTexts: Record<number, string> = {};
  const failedIndices: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < imagesData.length; i++) {
    const image = imagesData[i];
    try {
      let prompt = `Create an optimized alt text for a product image.

Product: ${productTitle}
Image URL: ${image.url}${mainLanguage ? `\nLanguage: ${mainLanguage}` : ''}`;

      prompt += `\n\nRequirements:`;
      if (charLimit) prompt += `\n- Length: ${charLimit}`;
      prompt += `\n- Describe what's visible in the image`;
      prompt += `\n- Include product name or key feature`;
      prompt += `\n- Accessible and helpful for screen readers`;
      prompt += keywordLine;

      if (format) prompt += `\n\nFormat Example:\n${format}`;
      if (instructions) prompt += `\n\nGuidelines:\n${instructions}`;
      prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

      const altText = await aiService.generateImageAltText(image.url, productTitle, prompt, sendImageToAI);
      generatedAltTexts[i] = altText;
    } catch (imgError: unknown) {
      const message = errorMessage(imgError);
      lastError = message;
      failedIndices.push(i);
      logger.error("[API-AI] Failed to generate alt-text for image", {
        context: "AI",
        taskId,
        imageIndex: i,
        error: message,
      });
    }

    // Persist after every image so a crash only loses the current one.
    const progressPercent = Math.round(((i + 1) / totalImages) * 100);
    await db.task.update({
      where: { id: taskId },
      data: {
        progress: progressPercent,
        processed: i + 1,
        result: JSON.stringify({ generatedAltTexts, failedIndices }),
      },
    }).catch((err: unknown) => {
      logger.error("[API-AI] Failed to persist bulk alt-text progress", {
        context: "AI",
        taskId,
        error: errorMessage(err),
      });
    });
  }

  const generatedCount = Object.keys(generatedAltTexts).length;
  const finalStatus = generatedCount === 0 ? "failed" : "completed";
  const failureSummary = failedIndices.length > 0
    ? `${failedIndices.length} of ${totalImages} images failed${lastError ? `: ${lastError}` : ""}`
    : null;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: finalStatus,
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ generatedAltTexts, failedIndices }),
      error: failureSummary ? failureSummary.substring(0, 1000) : null,
    },
  });
}

export async function handleTranslateAltText(ctx: AIActionContext): Promise<DataResponse> {
  const { session, db, settings, formData, contentType, itemId } = ctx;

  const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
  const sourceAltText = getFormString(formData, "sourceAltText");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productTitle = getFormString(formData, "productTitle");

  if (!sourceAltText) {
    return json({ success: false, error: "No source alt-text available" }, { status: 400 });
  }

  if (!isValidLocale(targetLocale)) {
    return json({ success: false, error: `Invalid target locale: ${targetLocale}` }, { status: 400 });
  }

  // Create task entry (prompt is saved by AI service via savePromptToTask)
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: productTitle || itemId,
      fieldType: `altText_${imageIndex}`,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const aiService = createAIService(settings, session.shop, task.id);

    logger.debug("[API-AI] Translating alt-text", {
      context: "AI",
      imageIndex,
      from: primaryLocale,
      to: targetLocale,
      textLength: sourceAltText.length
    });

    const translatedAltText = await aiService.translateContent(sourceAltText, primaryLocale, targetLocale);

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: translatedAltText,
      },
    });

    return json({
      success: true,
      translatedAltText,
      imageIndex,
      targetLocale
    });
  } catch (error: unknown) {
    // Update task to failed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

export async function handleTranslateAltTextToAllLocales(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, settings, formData, contentType, itemId } = ctx;

  const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
  const sourceAltText = getFormString(formData, "sourceAltText");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productId = getFormString(formData, "productId");
  const gidErr2 = invalidProductGidResponse(productId);
  if (gidErr2) return gidErr2;
  const productTitle = getFormString(formData, "productTitle");

  if (!sourceAltText) {
    return json({ success: false, error: "No source alt-text available" }, { status: 400 });
  }

  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target locales specified" }, { status: 400 });
  }

  // Hard upper bound on locales: one AI translation call is queued per locale,
  // so an unbounded client-supplied array is an unbounded AI fan-out that also
  // sidesteps plan-level language limits.
  const MAX_TARGET_LOCALES = 50;
  if (targetLocales.length > MAX_TARGET_LOCALES) {
    return json(
      { success: false, error: `Too many target locales (max ${MAX_TARGET_LOCALES}, got ${targetLocales.length})` },
      { status: 413 },
    );
  }

  const invalidLocales = targetLocales.filter((l) => !isValidLocale(l));
  if (invalidLocales.length > 0) {
    return json(
      { success: false, error: `Invalid target locale(s): ${invalidLocales.join(", ")}` },
      { status: 400 },
    );
  }

  // Create task entry (prompts will be saved by AI service via savePromptToTask)
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: productTitle || itemId,
      fieldType: `altText_${imageIndex}`,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 10 },
    });

    const aiService = createAIService(settings, session.shop, task.id);

    logger.debug("[API-AI] Translating alt-text to all locales", {
      context: "AI",
      imageIndex,
      from: primaryLocale,
      to: targetLocales,
      textLength: sourceAltText.length
    });

    const translatedAltTexts: Record<string, string> = {};
    const aiResponses: Array<{ locale: string; response: string }> = [];

    // Translate this alt-text to ALL locales in ONE alt-text-aware AI call
    // instead of one translateContent round-trip per locale. On total failure,
    // fall back to the per-locale path so a single bad call doesn't block all.
    const altKey = String(imageIndex);
    try {
      const batch = await aiService.translateAltTextsBatch(
        { [altKey]: sourceAltText },
        primaryLocale,
        targetLocales,
        contentType
      );
      for (const locale of targetLocales) {
        const value = batch[altKey]?.[locale];
        // Missing cell → skip (N-H3: never persist source as a translation).
        if (!value) continue;
        translatedAltTexts[locale] = value;
        aiResponses.push({ locale, response: value });
      }
    } catch (error: unknown) {
      // Invalid API key: the per-locale fallback would 401 too — fail loudly.
      if (isAuthError(error)) throw error;
      logger.error("[API-AI] Alt-text batch translation failed, falling back to per-locale", {
        context: "AI",
        imageIndex,
        error: errorMessage(error)
      });
      for (const locale of targetLocales) {
        try {
          const value = await aiService.translateContent(sourceAltText, primaryLocale, locale);
          translatedAltTexts[locale] = value;
          aiResponses.push({ locale, response: value });
        } catch (innerError: unknown) {
          // Invalid key: abort the loop — every remaining locale would 401 too.
          if (isAuthError(innerError)) throw innerError;
          // Skip this locale — do NOT persist source-as-translation (N-H3).
          logger.error("[API-AI] Error translating alt-text to locale", {
            context: "AI",
            imageIndex,
            locale,
            error: errorMessage(innerError)
          });
          aiResponses.push({ locale, response: `ERROR: ${errorMessage(innerError)}` });
        }
      }
    }

    await db.task.update({ where: { id: task.id }, data: { progress: 60 } });

    // Save translations to Shopify first, then DB only on success
    const failedLocales: string[] = [];
    const savedLocales: string[] = [];

    // Articles/Collections: featured-image alt-text lives on a separate translatable
    // resource (ArticleImage / CollectionImage) and is persisted to `contentTranslation`
    // via the shared helper. Required because this api-ai handler bypasses the page
    // route, which is the only place that previously routed Article/Collection saves.
    if (contentType === 'blogs' || contentType === 'collections') {
      const resourceType: 'Article' | 'Collection' = contentType === 'blogs' ? 'Article' : 'Collection';
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { ShopifyContentService } = await import("../../../src/services/shopify-content.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);
      const shopifyContentService = new ShopifyContentService(gateway as any);

      for (const locale of targetLocales) {
        const altText = translatedAltTexts[locale];
        if (!altText) continue;
        const result = await shopifyContentService.saveImageAltTextTranslation({
          resourceId: itemId,
          resourceType,
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
    } else if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { shop_id: { shop: session.shop, id: productId } },
        include: {
          images: { orderBy: { position: 'asc' } },
        },
      });

      const dbImage = dbProduct?.images?.[imageIndex];

      if (!dbImage?.mediaId) {
        logger.warn("[API-AI] No mediaId for image - cannot save alt-text translations to Shopify", {
          context: "AI", imageIndex, productId,
        });
        failedLocales.push(...targetLocales);
      } else {
        // Fetch digest once
        let altDigest: string | undefined;
        try {
          const translatableResponse = await gateway.graphql(
            `#graphql
              query translatableContent($resourceId: ID!) {
                translatableResource(resourceId: $resourceId) {
                  resourceId
                  translatableContent { key digest value }
                }
              }`,
            { variables: { resourceId: dbImage.mediaId } }
          );
          const translatableData = await translatableResponse.json();
          const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
          altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
        } catch (err: unknown) {
          logger.error("[API-AI] Error fetching translatable content for alt-text", {
            context: "AI", imageIndex, error: errorMessage(err),
          });
        }

        if (!altDigest) {
          logger.warn("[API-AI] No digest for alt-text - cannot save to Shopify", {
            context: "AI", imageIndex, mediaId: dbImage.mediaId,
          });
          failedLocales.push(...targetLocales);
        } else {
          // Save each locale: Shopify first, then DB
          for (const locale of targetLocales) {
            const altText = translatedAltTexts[locale];
            if (!altText) continue;

            let shopifySaved = false;
            try {
              const translateResponse = await gateway.graphql(
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
              const translateData = await translateResponse.json();
              const userErrors = translateData.data?.translationsRegister?.userErrors || [];
              if (userErrors.length === 0) {
                shopifySaved = true;
              } else {
                logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
                  context: "AI", locale, errors: userErrors,
                });
              }
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Error saving alt-text to Shopify", {
                context: "AI", locale, error: errorMessage(shopifyError),
              });
            }

            if (shopifySaved && dbImage) {
              try {
                const existing = await db.productImageAltTranslation.findUnique({
                  where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale } },
                });
                if (existing) {
                  await db.productImageAltTranslation.update({ where: { id: existing.id }, data: { altText } });
                } else {
                  await db.productImageAltTranslation.create({ data: { imageId: dbImage.id, locale, altText } });
                }
              } catch (dbError: unknown) {
                if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
                  logger.error("[API-AI] Image deleted during translation save", {
                    context: "AI", imageIndex, productId, error: errorMessage(dbError),
                  });
                } else {
                  throw dbError;
                }
              }
            } else if (!shopifySaved) {
              failedLocales.push(locale);
            }
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
        result: JSON.stringify(aiResponses, null, 2),
      },
    });

    return json({
      success: true,
      translatedAltTexts,
      imageIndex,
      targetLocales,
      savedLocales,
      failedLocales,
    });
  } catch (error: unknown) {
    // Update task to failed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

export async function handleTranslateAllAltTextsToAllLocales(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, settings, formData, contentType, itemId } = ctx;

  const altTextsDataJson = getFormString(formData, "altTextsData");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productId = getFormString(formData, "productId");
  const gidErr3 = invalidProductGidResponse(productId);
  if (gidErr3) return gidErr3;
  const productTitle = getFormString(formData, "productTitle");

  if (!altTextsDataJson) {
    return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
  }

  const altTextsData = safeJsonParse<Record<string, string>>(altTextsDataJson, {});
  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  const imageIndices = Object.keys(altTextsData).map(Number);

  if (targetLocales.length === 0 || imageIndices.length === 0) {
    return json({ success: false, error: "No target locales or images specified" }, { status: 400 });
  }

  const MAX_TARGET_LOCALES = 50;
  if (targetLocales.length > MAX_TARGET_LOCALES) {
    return json(
      { success: false, error: `Too many target locales (max ${MAX_TARGET_LOCALES}, got ${targetLocales.length})` },
      { status: 413 },
    );
  }

  const invalidLocales = targetLocales.filter((l) => !isValidLocale(l));
  if (invalidLocales.length > 0) {
    return json(
      { success: false, error: `Invalid target locale(s): ${invalidLocales.join(", ")}` },
      { status: 400 },
    );
  }

  // Create task
  const bulkAllTask = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: productTitle || itemId,
      fieldType: "allAltTexts",
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({
      where: { id: bulkAllTask.id },
      data: { status: "running", progress: 5 },
    });

    const aiService = createAIService(settings, session.shop, bulkAllTask.id);

    // Batch translate all alt-texts to all locales in a single AI request
    let translatedResults: Record<string, Record<string, string>> = {};
    try {
      translatedResults = await aiService.translateAltTextsBatch(
        altTextsData, primaryLocale, targetLocales, contentType
      );
    } catch (error: unknown) {
      // Invalid API key: fail loudly — every image/locale would 401 too.
      if (isAuthError(error)) throw error;
      logger.error("[API-AI] Error batch-translating alt-texts to all locales", {
        context: "AI", error: errorMessage(error),
      });
      // Leave translatedResults empty: the per-image/locale save below skips
      // missing cells (`if (!altText) continue;`) and records them as failed.
      // (Previously this filled every cell with the SOURCE alt-text, which then
      // got written to Shopify + DB as if it were a real translation — N-H3
      // source-as-translation corruption, reported as success.)
      translatedResults = {};
    }

    await db.task.update({
      where: { id: bulkAllTask.id },
      data: { progress: 80 },
    });

    // Save translations to Shopify first, then DB only on Shopify success
    const failedImages: number[] = [];
    let savedCount = 0;

    if (contentType === 'blogs' || contentType === 'collections') {
      const resourceType: 'Article' | 'Collection' = contentType === 'blogs' ? 'Article' : 'Collection';
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { ShopifyContentService } = await import("../../../src/services/shopify-content.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);
      const shopifyContentService = new ShopifyContentService(gateway as any);

      for (const imgIdx of imageIndices) {
        let imageFullySaved = true;
        for (const locale of targetLocales) {
          const altText = translatedResults[imgIdx]?.[locale];
          if (!altText) continue;
          const result = await shopifyContentService.saveImageAltTextTranslation({
            resourceId: itemId,
            resourceType,
            locale,
            altText,
            shop: session.shop,
            db,
          });
          if (result.saved) {
            savedCount++;
          } else {
            imageFullySaved = false;
          }
        }
        if (!imageFullySaved && !failedImages.includes(imgIdx)) {
          failedImages.push(imgIdx);
        }
      }
    } else if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { shop_id: { shop: session.shop, id: productId } },
        include: {
          images: { orderBy: { position: 'asc' } },
        },
      });

      for (const imgIdx of imageIndices) {
        const dbImage = dbProduct?.images?.[imgIdx];
        if (!dbImage) {
          logger.warn("[API-AI] No DB image found for index", { context: "AI", imageIndex: imgIdx, productId });
          failedImages.push(imgIdx);
          continue;
        }

        // Shopify save requires mediaId
        if (!dbImage.mediaId) {
          logger.warn("[API-AI] No mediaId for image, cannot save to Shopify", {
            context: "AI", imageIndex: imgIdx, productId,
          });
          failedImages.push(imgIdx);
          continue;
        }

        // Fetch translatable content digest
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

          const translatableData = await translatableResponse.json();
          const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
          altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
        } catch (err: unknown) {
          logger.error("[API-AI] Error fetching translatable content for image", {
            context: "AI", imageIndex: imgIdx, error: errorMessage(err),
          });
        }

        if (!altDigest) {
          logger.warn("[API-AI] No digest found for alt-text, cannot save to Shopify", {
            context: "AI", imageIndex: imgIdx, mediaId: dbImage.mediaId,
          });
          failedImages.push(imgIdx);
          continue;
        }

        // Save each locale to Shopify, then to DB
        let imageFullySaved = true;
        for (const locale of targetLocales) {
          const altText = translatedResults[imgIdx]?.[locale];
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
            const shopifyData = await shopifyResult.json();
            const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
            if (userErrors.length === 0) {
              shopifySaved = true;
            } else {
              logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
                context: "AI", imageIndex: imgIdx, locale, errors: userErrors,
              });
            }
          } catch (shopifyError: unknown) {
            logger.error("[API-AI] Error saving bulk alt-text to Shopify", {
              context: "AI", imageIndex: imgIdx, locale, error: errorMessage(shopifyError),
            });
          }

          // Only save to DB if Shopify save succeeded
          if (shopifySaved) {
            try {
              const existing = await db.productImageAltTranslation.findUnique({
                where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale } },
              });
              if (existing) {
                await db.productImageAltTranslation.update({
                  where: { id: existing.id },
                  data: { altText },
                });
              } else {
                await db.productImageAltTranslation.create({
                  data: { imageId: dbImage.id, locale, altText },
                });
              }
              savedCount++;
            } catch (dbError: unknown) {
              if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
                logger.error("[API-AI] Image deleted during bulk translation save", {
                  context: "AI", imageIndex: imgIdx, productId, error: errorMessage(dbError),
                });
              } else {
                throw dbError;
              }
            }
          } else {
            imageFullySaved = false;
          }
        }

        if (!imageFullySaved && !failedImages.includes(imgIdx)) {
          failedImages.push(imgIdx);
        }
      }
    }

    await db.task.update({
      where: { id: bulkAllTask.id },
      data: { status: "completed", progress: 100, completedAt: new Date() },
    });

    return json({
      success: true,
      translatedCount: targetLocales.length,
      imageCount: imageIndices.length,
      savedCount,
      failedImages,
      translatedResults,
    });
  } catch (error: unknown) {
    await db.task.update({
      where: { id: bulkAllTask.id },
      data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
    });
    throw error;
  }
}

export async function handleTranslateAllAltTextsForLocale(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, settings, formData, contentType, itemId } = ctx;

  const altTextsDataJson = getFormString(formData, "altTextsData");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productTitle = getFormString(formData, "productTitle");

  if (!altTextsDataJson) {
    return json({ success: false, error: "No alt-text data provided" }, { status: 400 });
  }

  const altTextsData = safeJsonParse<Record<string, string>>(altTextsDataJson, {});
  const imageIndices = Object.keys(altTextsData).map(Number);

  if (!targetLocale || imageIndices.length === 0) {
    return json({ success: false, error: "No target locale or images specified" }, { status: 400 });
  }

  // Create task
  const localeTask = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: productTitle || itemId,
      fieldType: "allAltTexts",
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({
      where: { id: localeTask.id },
      data: { status: "running", progress: 10 },
    });

    const aiService = createAIService(settings, session.shop, localeTask.id);

    // Batch translate all alt-texts for this locale in a single AI request
    const translatedAltTexts: Record<number, string> = {};
    try {
      const batchResult = await aiService.translateAltTextsBatch(
        altTextsData, primaryLocale, [targetLocale], contentType
      );
      for (const [imgIdx, localeMap] of Object.entries(batchResult)) {
        // Missing cell → skip (do NOT fall back to the source alt-text, which
        // would be persisted as a real translation — N-H3 corruption).
        const value = localeMap[targetLocale];
        if (value) translatedAltTexts[Number(imgIdx)] = value;
      }
    } catch (error: unknown) {
      // Invalid API key: fail loudly — there is no per-image fallback here.
      if (isAuthError(error)) throw error;
      logger.error("[API-AI] Error batch-translating alt-texts for locale", {
        context: "AI", targetLocale, error: errorMessage(error),
      });
      // Leave translatedAltTexts empty: the save loop below skips missing cells
      // (`if (!altText) continue;`) instead of writing source-as-translation.
    }

    await db.task.update({
      where: { id: localeTask.id },
      data: { progress: 90 },
    });

    // Save translations to Shopify first, then DB only on Shopify success
    const productId = getFormString(formData, "productId");
    const gidErr4 = invalidProductGidResponse(productId);
    if (gidErr4) return gidErr4;
    const failedImages: number[] = [];
    let savedCount = 0;

    if (contentType === 'blogs' || contentType === 'collections') {
      const resourceType: 'Article' | 'Collection' = contentType === 'blogs' ? 'Article' : 'Collection';
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { ShopifyContentService } = await import("../../../src/services/shopify-content.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);
      const shopifyContentService = new ShopifyContentService(gateway as any);

      for (const imgIdx of imageIndices) {
        const altText = translatedAltTexts[imgIdx];
        if (!altText) continue;
        const result = await shopifyContentService.saveImageAltTextTranslation({
          resourceId: itemId,
          resourceType,
          locale: targetLocale,
          altText,
          shop: session.shop,
          db,
        });
        if (result.saved) {
          savedCount++;
        } else {
          failedImages.push(imgIdx);
        }
      }
    } else if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { shop_id: { shop: session.shop, id: productId } },
        include: {
          images: { orderBy: { position: 'asc' } },
        },
      });

      for (const imgIdx of imageIndices) {
        const dbImage = dbProduct?.images?.[imgIdx];
        if (!dbImage) {
          failedImages.push(imgIdx);
          continue;
        }

        const altText = translatedAltTexts[imgIdx];
        if (!altText) continue;

        // Shopify save requires mediaId + digest
        if (!dbImage.mediaId) {
          logger.warn("[API-AI] No mediaId for image, cannot save to Shopify", {
            context: "AI", imageIndex: imgIdx, productId,
          });
          failedImages.push(imgIdx);
          continue;
        }

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

          const translatableData = await translatableResponse.json();
          const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
          altDigest = translatableContent.find((c: TranslatableContentItem) => c.key === "alt")?.digest;
        } catch (err: unknown) {
          logger.error("[API-AI] Error fetching translatable content for image", {
            context: "AI", imageIndex: imgIdx, error: errorMessage(err),
          });
        }

        if (!altDigest) {
          logger.warn("[API-AI] No digest found for alt-text, cannot save to Shopify", {
            context: "AI", imageIndex: imgIdx, mediaId: dbImage.mediaId,
          });
          failedImages.push(imgIdx);
          continue;
        }

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
                  locale: targetLocale,
                  translatableContentDigest: altDigest,
                }],
              },
            }
          );
          const shopifyData = await shopifyResult.json();
          const userErrors = shopifyData.data?.translationsRegister?.userErrors || [];
          if (userErrors.length === 0) {
            shopifySaved = true;
          } else {
            logger.error("[API-AI] Shopify translationsRegister userErrors for alt-text", {
              context: "AI", imageIndex: imgIdx, targetLocale, errors: userErrors,
            });
          }
        } catch (shopifyError: unknown) {
          logger.error("[API-AI] Error saving alt-text to Shopify for locale", {
            context: "AI", imageIndex: imgIdx, targetLocale, error: errorMessage(shopifyError),
          });
        }

        // Only save to DB if Shopify save succeeded
        if (shopifySaved) {
          try {
            const existing = await db.productImageAltTranslation.findUnique({
              where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale: targetLocale } },
            });
            if (existing) {
              await db.productImageAltTranslation.update({
                where: { id: existing.id },
                data: { altText },
              });
            } else {
              await db.productImageAltTranslation.create({
                data: { imageId: dbImage.id, locale: targetLocale, altText },
              });
            }
            savedCount++;
          } catch (dbError: unknown) {
            if (isPrismaError(dbError, 'P2003') || errorMessage(dbError).includes('Foreign key constraint')) {
              logger.error("[API-AI] Image deleted during alt-text locale save", {
                context: "AI", imageIndex: imgIdx, productId, error: errorMessage(dbError),
              });
            } else {
              throw dbError;
            }
          }
        } else {
          failedImages.push(imgIdx);
        }
      }
    }

    await db.task.update({
      where: { id: localeTask.id },
      data: { status: "completed", progress: 100, completedAt: new Date(), result: JSON.stringify(translatedAltTexts) },
    });

    return json({
      success: true,
      translatedAltTexts,
      targetLocale,
      savedCount,
      failedImages,
    });
  } catch (error: unknown) {
    await db.task.update({
      where: { id: localeTask.id },
      data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
    });
    throw error;
  }
}

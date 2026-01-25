/**
 * Alt-Text Actions
 *
 * Handles image alt-text generation and translation:
 * - generateAltText: Generates alt-text for a single image using AI
 * - generateAllAltTexts: Bulk generates alt-text for all product images
 * - translateAltText: Translates image alt-text to target locale
 */

import { json } from "@remix-run/node";
import { AIService } from "../../../src/services/ai.service";
import { TranslationService } from "../../../src/services/translation.service";
import { loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";
import {
  createProductTask,
  updateTaskStatus,
  updateTaskProgress,
  completeTask,
  failTask,
} from "./shared/task-helpers";
import { handleActionError } from "./shared/error-handlers";

interface GenerateAltTextParams {
  imageIndex: number;
  imageUrl: string;
  productTitle: string;
  productId: string;
  mainLanguage?: string;
}

interface GenerateAllAltTextsParams {
  imagesData: Array<{ url: string }>;
  productTitle: string;
  productId: string;
  mainLanguage?: string;
}

interface TranslateAltTextParams {
  imageIndex: number;
  sourceAltText: string;
  targetLocale: string;
  productId: string;
}

interface TranslateAltTextToAllLocalesParams {
  imageIndex: number;
  sourceAltText: string;
  targetLocales: string[];
  productId: string;
}

/**
 * Generates alt-text for a single image using AI
 */
export async function handleGenerateAltText(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const action = "generateAltText";

  const { db } = await import("~/db.server");

  const params: GenerateAltTextParams = {
    imageIndex: parseInt(formData.get("imageIndex") as string),
    imageUrl: formData.get("imageUrl") as string,
    productTitle: formData.get("productTitle") as string,
    productId,
    mainLanguage: formData.get("mainLanguage") as string || undefined,
  };

  loggers.ai("info", "Generating alt-text for image", {
    imageIndex: params.imageIndex,
    productId: params.productId,
    shop: context.session.shop,
  });

  // Load AI instructions
  const aiInstructions = await db.aIInstructions.findUnique({
    where: { shop: context.session.shop },
  });

  const task = await createProductTask({
    shop: context.session.shop,
    type: "aiGeneration",
    resourceType: "product",
    resourceId: productId,
    resourceTitle: params.productTitle,
    fieldType: `altText_${params.imageIndex}`,
  });

  try {
    const aiService = new AIService(context.provider, context.config, context.session.shop, task.id);

    await updateTaskStatus(task.id, "queued", { progress: 10 });

    let prompt = `Create an optimized alt text for a product image.
Product: ${params.productTitle}
Image URL: ${params.imageUrl}`;

    if (aiInstructions?.productAltTextFormat) {
      prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
    }

    if (aiInstructions?.productAltTextInstructions) {
      prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
    }

    prompt += `\n\nReturn ONLY the alt text, without explanations.${params.mainLanguage ? ` Output the result in ${params.mainLanguage}.` : ''}`;

    const altText = await aiService.generateImageAltText(params.imageUrl, params.productTitle, prompt);

    await completeTask(task.id, { altText, imageIndex: params.imageIndex });

    loggers.ai("info", "Alt-text generation completed", {
      imageIndex: params.imageIndex,
      taskId: task.id,
    });

    return json({ success: true, altText, imageIndex: params.imageIndex });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId,
      provider: context.provider,
    });
  }
}

/**
 * Generates alt-text for all product images using AI
 */
export async function handleGenerateAllAltTexts(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const action = "generateAllAltTexts";

  const { db } = await import("~/db.server");

  const params: GenerateAllAltTextsParams = {
    imagesData: JSON.parse(formData.get("imagesData") as string),
    productTitle: formData.get("productTitle") as string,
    productId,
    mainLanguage: formData.get("mainLanguage") as string || undefined,
  };

  const totalImages = params.imagesData.length;

  loggers.ai("info", "Generating all alt-texts", {
    productId: params.productId,
    imageCount: totalImages,
    shop: context.session.shop,
  });

  const task = await createProductTask({
    shop: context.session.shop,
    type: "bulkAIGeneration",
    resourceType: "product",
    resourceId: productId,
    resourceTitle: params.productTitle,
    fieldType: "allAltTexts",
  });

  try {
    const generatedAltTexts: Record<number, string> = {};

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10, total: totalImages, processed: 0 },
    });

    const aiService = new AIService(context.provider, context.config, context.session.shop, task.id);

    // Load AI instructions
    const aiInstructions = await db.aIInstructions.findUnique({
      where: { shop: context.session.shop },
    });

    for (let i = 0; i < params.imagesData.length; i++) {
      const image = params.imagesData[i];
      try {
        let prompt = `Create an optimized alt text for a product image.
Product: ${params.productTitle}
Image URL: ${image.url}`;

        if (aiInstructions?.productAltTextFormat) {
          prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
        }

        if (aiInstructions?.productAltTextInstructions) {
          prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
        }

        prompt += `\n\nReturn ONLY the alt text, without explanations.${params.mainLanguage ? ` Output the result in ${params.mainLanguage}.` : ''}`;

        const altText = await aiService.generateImageAltText(image.url, params.productTitle, prompt);
        generatedAltTexts[i] = altText;

        const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
        await updateTaskProgress(task.id, progressPercent, { processed: i + 1 });

        loggers.ai("debug", "Generated alt-text for image", { imageIndex: i });
      } catch (error: any) {
        loggers.ai("error", "Failed to generate alt-text for image", {
          imageIndex: i,
          error: error.message,
        });
      }
    }

    await completeTask(task.id, { generatedAltTexts });

    loggers.ai("info", "Bulk alt-text generation completed", {
      taskId: task.id,
      generatedCount: Object.keys(generatedAltTexts).length,
      totalImages,
    });

    return json({ success: true, generatedAltTexts });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId,
      provider: context.provider,
    });
  }
}

/**
 * Translates image alt-text to target locale
 */
export async function handleTranslateAltText(
  context: ActionContext,
  formData: FormData
): Promise<Response> {
  const action = "translateAltText";

  const params: TranslateAltTextParams = {
    imageIndex: parseInt(formData.get("imageIndex") as string),
    sourceAltText: formData.get("sourceAltText") as string,
    targetLocale: formData.get("targetLocale") as string,
    productId: formData.get("productId") as string,
  };

  loggers.translation("info", "Translating alt-text", {
    imageIndex: params.imageIndex,
    targetLocale: params.targetLocale,
    productId: params.productId,
    shop: context.session.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.session.shop,
    type: "translation",
    resourceType: "product",
    resourceId: params.productId,
    fieldType: `altText_${params.imageIndex}`,
    targetLocale: params.targetLocale,
  });

  try {
    const translationService = new TranslationService(
      context.provider,
      context.config,
      context.session.shop,
      task.id
    );

    const changedFields: any = {};
    changedFields[`altText_${params.imageIndex}`] = params.sourceAltText;

    await updateTaskStatus(task.id, "queued", { progress: 10 });

    const translations = await translationService.translateProduct(
      changedFields,
      [params.targetLocale],
      "product"
    );
    const translatedAltText = translations[params.targetLocale]?.[`altText_${params.imageIndex}`] || "";

    await completeTask(task.id, {
      translatedAltText,
      imageIndex: params.imageIndex,
      targetLocale: params.targetLocale,
    });

    loggers.translation("info", "Alt-text translation completed", {
      imageIndex: params.imageIndex,
      targetLocale: params.targetLocale,
      taskId: task.id,
    });

    return json({
      success: true,
      translatedAltText,
      imageIndex: params.imageIndex,
      targetLocale: params.targetLocale,
    });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId: params.productId,
      provider: context.provider,
    });
  }
}

/**
 * Translates image alt-text to all target locales and saves to Shopify + DB
 */
export async function handleTranslateAltTextToAllLocales(
  context: ActionContext,
  formData: FormData
): Promise<Response> {
  const action = "translateAltTextToAllLocales";

  const { db } = await import("~/db.server");
  const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");

  const params: TranslateAltTextToAllLocalesParams = {
    imageIndex: parseInt(formData.get("imageIndex") as string),
    sourceAltText: formData.get("sourceAltText") as string,
    targetLocales: JSON.parse(formData.get("targetLocales") as string),
    productId: formData.get("productId") as string,
  };

  loggers.translation("info", "Translating alt-text to all locales", {
    imageIndex: params.imageIndex,
    targetLocales: params.targetLocales,
    productId: params.productId,
    shop: context.session.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.session.shop,
    type: "translation",
    resourceType: "product",
    resourceId: params.productId,
    fieldType: `altText_${params.imageIndex}`,
    targetLocale: params.targetLocales.join(","),
  });

  try {
    const translationService = new TranslationService(
      context.provider,
      context.config,
      context.session.shop,
      task.id
    );

    const changedFields: any = {};
    changedFields[`altText_${params.imageIndex}`] = params.sourceAltText;

    await updateTaskStatus(task.id, "queued", { progress: 10 });

    const translations = await translationService.translateProduct(
      changedFields,
      params.targetLocales,
      "product"
    );

    // Extract translated alt-texts for each locale
    const translatedAltTexts: Record<string, string> = {};
    for (const locale of params.targetLocales) {
      translatedAltTexts[locale] = translations[locale]?.[`altText_${params.imageIndex}`] || "";
    }

    await updateTaskProgress(task.id, 50, { translationsGenerated: true });

    // Now save the translations to Shopify and DB
    const gateway = new ShopifyApiGateway(context.admin, context.session.shop);

    // Get DB product image to find mediaId
    const dbProduct = await db.product.findUnique({
      where: { id: params.productId },
      include: {
        images: {
          orderBy: { position: 'asc' },
        },
      },
    });

    const dbImage = dbProduct?.images?.[params.imageIndex];

    if (dbImage?.mediaId) {
      // First, fetch the translatable content to get the digest
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
      const altDigest = translatableContent.find((c: any) => c.key === "alt")?.digest;

      if (altDigest) {
        // Save each translation to Shopify
        for (const locale of params.targetLocales) {
          const altText = translatedAltTexts[locale];
          if (!altText) continue;

          const translateResponse = await gateway.graphql(
            `#graphql
              mutation translateMediaImage($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors {
                    field
                    message
                  }
                  translations {
                    locale
                    key
                    value
                  }
                }
              }`,
            {
              variables: {
                resourceId: dbImage.mediaId,
                translations: [
                  {
                    key: "alt",
                    value: altText,
                    locale: locale,
                    translatableContentDigest: altDigest,
                  },
                ],
              },
            }
          );

          const translateData = await translateResponse.json();
          if (translateData.data?.translationsRegister?.userErrors?.length > 0) {
            loggers.translation("error", "Failed to save alt-text translation to Shopify", {
              locale,
              errors: translateData.data.translationsRegister.userErrors,
            });
          } else {
            loggers.translation("debug", "Saved alt-text translation to Shopify", { locale });
          }
        }
      }
    }

    // Save translations to DB
    // Note: We wrap this in a try-catch because a concurrent product sync
    // could delete and recreate images, causing a FK constraint violation
    if (dbImage) {
      try {
        for (const locale of params.targetLocales) {
          const altText = translatedAltTexts[locale];
          if (!altText) continue;

          const existing = await db.productImageAltTranslation.findUnique({
            where: {
              imageId_locale: {
                imageId: dbImage.id,
                locale: locale,
              },
            },
          });

          if (existing) {
            await db.productImageAltTranslation.update({
              where: { id: existing.id },
              data: { altText },
            });
          } else {
            await db.productImageAltTranslation.create({
              data: {
                imageId: dbImage.id,
                locale: locale,
                altText: altText,
              },
            });
          }
        }
        loggers.translation("debug", "Saved alt-text translations to DB", {
          imageIndex: params.imageIndex,
          locales: params.targetLocales,
        });
      } catch (dbError: any) {
        // If the image was deleted by a concurrent sync, log and continue
        // The translations were still saved to Shopify, they'll be synced on next reload
        if (dbError.code === 'P2003' || dbError.message?.includes('Foreign key constraint')) {
          loggers.translation("warn", "Image was deleted during translation save (concurrent sync)", {
            imageIndex: params.imageIndex,
            productId: params.productId,
            error: dbError.message,
          });
        } else {
          throw dbError; // Re-throw other errors
        }
      }
    }

    await completeTask(task.id, {
      translatedAltTexts,
      imageIndex: params.imageIndex,
      targetLocales: params.targetLocales,
    });

    loggers.translation("info", "Alt-text translation to all locales completed and saved", {
      imageIndex: params.imageIndex,
      targetLocales: params.targetLocales,
      taskId: task.id,
    });

    return json({
      success: true,
      translatedAltTexts,
      imageIndex: params.imageIndex,
      targetLocales: params.targetLocales,
    });
  } catch (error: any) {
    await failTask(task.id, error);
    return handleActionError(error, {
      action,
      taskId: task.id,
      productId: params.productId,
      provider: context.provider,
    });
  }
}

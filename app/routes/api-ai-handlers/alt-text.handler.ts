import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isPrismaError } from "./shared";
import type { TranslatableContentItem } from "./shared";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../../graphql/content.mutations";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import { getCharacterLimitRequirement } from "~/utils/character-limits";

export async function handleGenerateAltText(ctx: AIActionContext): Promise<Response> {
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
    const altTextCharLimit = getCharacterLimitRequirement("productAltText");
    if (altTextCharLimit) {
      prompt += `\n- Length: ${altTextCharLimit}`;
    }
    prompt += `\n- Describe what's visible in the image`;
    prompt += `\n- Include product name or key feature`;
    prompt += `\n- Accessible and helpful for screen readers`;

    const altTextFormat = getInstructionWithDefault(aiInstructions, "productAltTextFormat");
    if (altTextFormat) {
      prompt += `\n\nFormat Example:\n${altTextFormat}`;
    }

    const altTextInstructions = getInstructionWithDefault(aiInstructions, "productAltTextInstructions");
    if (altTextInstructions) {
      prompt += `\n\nGuidelines:\n${altTextInstructions}`;
    }

    prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

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

export async function handleGenerateAllAltTexts(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, formData, contentType } = ctx;

  const productId = getFormString(formData, "productId");
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

  // Load AI instructions
  const altTextInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  // Create task entry
  const bulkTask = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkAIGeneration",
      status: "pending",
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

  try {
    await db.task.update({
      where: { id: bulkTask.id },
      data: { status: "running", progress: 10 },
    });

    const bulkAiService = createAIService(settings, session.shop, bulkTask.id);

    const generatedAltTexts: Record<number, string> = {};

    for (let i = 0; i < imagesData.length; i++) {
      const image = imagesData[i];
      try {
        let prompt = `Create an optimized alt text for a product image.

Product: ${productTitle}
Image URL: ${image.url}${mainLanguage ? `\nLanguage: ${mainLanguage}` : ''}`;

        // Add requirements
        prompt += `\n\nRequirements:`;
        const bulkAltTextCharLimit = getCharacterLimitRequirement("productAltText");
        if (bulkAltTextCharLimit) {
          prompt += `\n- Length: ${bulkAltTextCharLimit}`;
        }
        prompt += `\n- Describe what's visible in the image`;
        prompt += `\n- Include product name or key feature`;
        prompt += `\n- Accessible and helpful for screen readers`;

        const bulkAltTextFormat = getInstructionWithDefault(altTextInstructions, "productAltTextFormat");
        if (bulkAltTextFormat) {
          prompt += `\n\nFormat Example:\n${bulkAltTextFormat}`;
        }

        const bulkAltTextInstructions = getInstructionWithDefault(altTextInstructions, "productAltTextInstructions");
        if (bulkAltTextInstructions) {
          prompt += `\n\nGuidelines:\n${bulkAltTextInstructions}`;
        }

        prompt += `\n\nIMPORTANT: Return ONLY the alt text, nothing else.${mainLanguage ? ` Output in ${mainLanguage}.` : ''}`;

        const altText = await bulkAiService.generateImageAltText(image.url, productTitle, prompt, sendImageToAI);
        generatedAltTexts[i] = altText;

        const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
        await db.task.update({
          where: { id: bulkTask.id },
          data: { progress: progressPercent, processed: i + 1 },
        });
      } catch (imgError: unknown) {
        logger.error("[API-AI] Failed to generate alt-text for image", {
          context: "AI",
          imageIndex: i,
          error: errorMessage(imgError),
        });
      }
    }

    // Mark task as completed
    await db.task.update({
      where: { id: bulkTask.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ generatedAltTexts }),
      },
    });

    return json({ success: true, generatedAltTexts });
  } catch (error: unknown) {
    await db.task.update({
      where: { id: bulkTask.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

export async function handleTranslateAltText(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, formData, contentType, itemId } = ctx;

  const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
  const sourceAltText = getFormString(formData, "sourceAltText");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productTitle = getFormString(formData, "productTitle");

  if (!sourceAltText) {
    return json({ success: false, error: "No source alt-text available" }, { status: 400 });
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

export async function handleTranslateAltTextToAllLocales(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, settings, formData, contentType, itemId } = ctx;

  const imageIndex = parseInt(getFormString(formData, "imageIndex"), 10);
  const sourceAltText = getFormString(formData, "sourceAltText");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productId = getFormString(formData, "productId");
  const productTitle = getFormString(formData, "productTitle");

  if (!sourceAltText) {
    return json({ success: false, error: "No source alt-text available" }, { status: 400 });
  }

  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target locales specified" }, { status: 400 });
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
    const totalLocales = targetLocales.length;

    // Translate to each locale
    for (let i = 0; i < targetLocales.length; i++) {
      const locale = targetLocales[i];
      try {
        const translatedValue = await aiService.translateContent(sourceAltText, primaryLocale, locale);
        translatedAltTexts[locale] = translatedValue;
        aiResponses.push({ locale, response: translatedValue });

        // Update progress
        const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
        await db.task.update({
          where: { id: task.id },
          data: { progress },
        });

        logger.debug("[API-AI] Translated alt-text to locale", {
          context: "AI",
          imageIndex,
          locale
        });
      } catch (error: unknown) {
        logger.error("[API-AI] Error translating alt-text to locale", {
          context: "AI",
          imageIndex,
          locale,
          error: errorMessage(error)
        });
        translatedAltTexts[locale] = sourceAltText; // Fallback to original
        aiResponses.push({ locale, response: `ERROR: ${errorMessage(error)}` });
      }
    }

    // Save translations to Shopify first, then DB only on success
    const failedLocales: string[] = [];

    if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { id: productId },
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
                  where: { imageId_locale: { imageId: dbImage.id, locale } },
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

export async function handleTranslateAllAltTextsToAllLocales(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, settings, formData, contentType, itemId } = ctx;

  const altTextsDataJson = getFormString(formData, "altTextsData");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const productId = getFormString(formData, "productId");
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
      logger.error("[API-AI] Error batch-translating alt-texts to all locales", {
        context: "AI", error: errorMessage(error),
      });
      // Fallback: use source texts for all
      for (const imgIdx of imageIndices) {
        translatedResults[String(imgIdx)] = {};
        for (const locale of targetLocales) {
          translatedResults[String(imgIdx)][locale] = altTextsData[String(imgIdx)];
        }
      }
    }

    await db.task.update({
      where: { id: bulkAllTask.id },
      data: { progress: 80 },
    });

    // Save translations to Shopify first, then DB only on Shopify success
    const failedImages: number[] = [];
    let savedCount = 0;

    if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { id: productId },
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
                where: { imageId_locale: { imageId: dbImage.id, locale } },
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

export async function handleTranslateAllAltTextsForLocale(ctx: AIActionContext): Promise<Response> {
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
        translatedAltTexts[Number(imgIdx)] = localeMap[targetLocale] || altTextsData[imgIdx];
      }
    } catch (error: unknown) {
      logger.error("[API-AI] Error batch-translating alt-texts for locale", {
        context: "AI", targetLocale, error: errorMessage(error),
      });
      // Fallback: use source texts
      for (const imgIdx of imageIndices) {
        translatedAltTexts[imgIdx] = altTextsData[String(imgIdx)];
      }
    }

    await db.task.update({
      where: { id: localeTask.id },
      data: { progress: 90 },
    });

    // Save translations to Shopify first, then DB only on Shopify success
    const productId = getFormString(formData, "productId");
    const failedImages: number[] = [];
    let savedCount = 0;

    if (productId && contentType === 'products') {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const gateway = new ShopifyApiGateway(admin, session.shop);

      const dbProduct = await db.product.findUnique({
        where: { id: productId },
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
              where: { imageId_locale: { imageId: dbImage.id, locale: targetLocale } },
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

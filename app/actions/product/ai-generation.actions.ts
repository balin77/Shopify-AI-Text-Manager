/**
 * AI Generation Actions
 *
 * Handles AI-powered content generation for product fields.
 * - generateAIText: Creates new content from scratch
 * - formatAIText: Formats existing content according to guidelines
 *
 * EXAMPLE FILE - Shows how refactored actions should look
 * To use: Remove .EXAMPLE extension and update router
 */

import { json } from "@remix-run/node";
import { logger, loggers } from "~/utils/logger.server";
import { sanitizeSlug } from "~/utils/slug.utils";
import type { ActionContext } from "./shared/action-context";
import { createAIService } from "./shared/action-context";
import {
  createProductTask,
  updateTaskStatus,
  completeTask,
  failTask,
} from "./shared/task-helpers";
import { handleActionError, isQuotaError } from "./shared/error-handlers";

type FieldType = "title" | "description" | "handle" | "seoTitle" | "metaDescription";

interface GenerateAITextParams {
  fieldType: FieldType;
  currentValue: string;
  contextTitle: string;
  contextDescription: string;
}

interface FormatAITextParams {
  fieldType: FieldType;
  currentValue: string;
  contextTitle: string;
  contextDescription: string;
}

/**
 * Generates new AI content for a product field
 */
export async function handleGenerateAIText(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const params: GenerateAITextParams = {
    fieldType: formData.get("fieldType") as FieldType,
    currentValue: formData.get("currentValue") as string,
    contextTitle: formData.get("contextTitle") as string,
    contextDescription: formData.get("contextDescription") as string,
  };

  loggers.ai("info", "Starting AI generation", {
    fieldType: params.fieldType,
    productId,
    shop: context.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.shop,
    type: "aiGeneration",
    resourceId: productId,
    fieldType: params.fieldType,
  });

  try {
    // Initialize AI Service
    const aiService = createAIService(context, task.id);

    // Update task to queued
    await updateTaskStatus(task.id, "queued", { progress: 10 });

    // Build prompt based on field type
    const prompt = buildGeneratePrompt(
      params.fieldType,
      params.currentValue,
      params.contextTitle,
      params.contextDescription,
      context.aiInstructions
    );

    loggers.ai("debug", "Generated prompt", {
      fieldType: params.fieldType,
      promptLength: prompt.length,
    });

    // Generate content
    let generatedContent = await generateContent(
      aiService,
      params.fieldType,
      prompt,
      params.contextTitle
    );

    // Post-process based on field type
    if (params.fieldType === "handle") {
      generatedContent = sanitizeSlug(generatedContent);
      if (!generatedContent) {
        throw new Error("Generated handle is invalid after sanitization");
      }
    }

    loggers.ai("info", "AI generation completed", {
      fieldType: params.fieldType,
      contentLength: generatedContent.length,
    });

    // Mark task as completed
    await completeTask(task.id, { generatedContent, fieldType: params.fieldType });

    return json({
      success: true,
      generatedContent,
      fieldType: params.fieldType,
    });
  } catch (error: any) {
    // Check if it's a quota error
    if (isQuotaError(error)) {
      return await import("./shared/error-handlers").then(({ handleQuotaError }) =>
        handleQuotaError(error, {
          action: "generateAIText",
          taskId: task.id,
          productId,
          provider: context.provider,
        })
      );
    }

    return handleActionError(error, {
      action: "generateAIText",
      taskId: task.id,
      productId,
      additionalInfo: {
        fieldType: params.fieldType,
      },
    });
  }
}

/**
 * Formats existing content according to AI guidelines
 */
export async function handleFormatAIText(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const params: FormatAITextParams = {
    fieldType: formData.get("fieldType") as FieldType,
    currentValue: formData.get("currentValue") as string,
    contextTitle: formData.get("contextTitle") as string,
    contextDescription: formData.get("contextDescription") as string,
  };

  loggers.ai("info", "Starting AI formatting", {
    fieldType: params.fieldType,
    productId,
    shop: context.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.shop,
    type: "aiGeneration",
    resourceId: productId,
    fieldType: params.fieldType,
  });

  try {
    // Initialize AI Service
    const aiService = createAIService(context, task.id);

    // Update task to queued
    await updateTaskStatus(task.id, "queued", { progress: 10 });

    // Build format prompt
    const prompt = buildFormatPrompt(
      params.fieldType,
      params.currentValue,
      params.contextTitle,
      params.contextDescription,
      context.aiInstructions
    );

    loggers.ai("debug", "Generated format prompt", {
      fieldType: params.fieldType,
      promptLength: prompt.length,
    });

    // Format content
    let formattedContent = await generateContent(
      aiService,
      params.fieldType,
      prompt,
      params.contextTitle
    );

    // Post-process based on field type
    if (params.fieldType === "handle") {
      formattedContent = sanitizeSlug(formattedContent);
      if (!formattedContent) {
        throw new Error("Formatted handle is invalid after sanitization");
      }
    }

    loggers.ai("info", "AI formatting completed", {
      fieldType: params.fieldType,
      contentLength: formattedContent.length,
    });

    // Mark task as completed
    await completeTask(task.id, { formattedContent, fieldType: params.fieldType });

    return json({
      success: true,
      generatedContent: formattedContent, // Keep key name for compatibility
      fieldType: params.fieldType,
    });
  } catch (error: any) {
    // Check if it's a quota error
    if (isQuotaError(error)) {
      return await import("./shared/error-handlers").then(({ handleQuotaError }) =>
        handleQuotaError(error, {
          action: "formatAIText",
          taskId: task.id,
          productId,
          provider: context.provider,
        })
      );
    }

    return handleActionError(error, {
      action: "formatAIText",
      taskId: task.id,
      productId,
      additionalInfo: {
        fieldType: params.fieldType,
      },
    });
  }
}

/**
 * Builds prompt for content generation
 */
function buildGeneratePrompt(
  fieldType: FieldType,
  currentValue: string,
  contextTitle: string,
  contextDescription: string,
  aiInstructions: any
): string {
  let prompt = "";

  switch (fieldType) {
    case "title":
      prompt = `Create an optimized product title.`;
      if (aiInstructions?.productTitleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productTitleFormat}`;
      }
      if (aiInstructions?.productTitleInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productTitleInstructions}`;
      }
      prompt += `\n\nContext:\n${contextDescription || currentValue}\n\nReturn ONLY the title, without explanations. Output the result in the same language as the product title.`;
      break;

    case "description":
      prompt = `Create an optimized product description for: ${contextTitle}`;
      if (aiInstructions?.productDescriptionFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productDescriptionFormat}`;
      }
      if (aiInstructions?.productDescriptionInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productDescriptionInstructions}`;
      }
      prompt += `\n\nCurrent Content:\n${currentValue}\n\nReturn ONLY the description, without explanations. Output the result in the same language as the product title.`;
      break;

    case "handle":
      prompt = `Create an SEO-friendly URL slug (handle) for this product:\nTitle: ${contextTitle}\nDescription: ${contextDescription}`;
      if (aiInstructions?.productHandleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productHandleFormat}`;
      }
      if (aiInstructions?.productHandleInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productHandleInstructions}`;
      }
      prompt += `\n\nReturn ONLY the URL slug, without explanations. Output the result in the same language as the product title.`;
      break;

    case "seoTitle":
      prompt = `Create an optimized SEO title for this product:\nTitle: ${contextTitle}\nDescription: ${contextDescription}`;
      if (aiInstructions?.productSeoTitleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productSeoTitleFormat}`;
      }
      if (aiInstructions?.productSeoTitleInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productSeoTitleInstructions}`;
      }
      prompt += `\n\nReturn ONLY the SEO title, without explanations. Output the result in the same language as the product title.`;
      break;

    case "metaDescription":
      prompt = `Create an optimized meta description for this product:\nTitle: ${contextTitle}\nDescription: ${contextDescription}`;
      if (aiInstructions?.productMetaDescFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productMetaDescFormat}`;
      }
      if (aiInstructions?.productMetaDescInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productMetaDescInstructions}`;
      }
      prompt += `\n\nReturn ONLY the meta description, without explanations. Output the result in the same language as the product title.`;
      break;
  }

  return prompt;
}

/**
 * Builds prompt for content formatting
 */
function buildFormatPrompt(
  fieldType: FieldType,
  currentValue: string,
  contextTitle: string,
  contextDescription: string,
  aiInstructions: any
): string {
  let prompt = "";

  switch (fieldType) {
    case "title":
      prompt = `Format the following product title according to the formatting guidelines:\n\nCurrent Title:\n${currentValue}`;
      if (aiInstructions?.productTitleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productTitleFormat}`;
      }
      if (aiInstructions?.productTitleInstructions) {
        prompt += `\n\nFormatting Instructions:\n${aiInstructions.productTitleInstructions}`;
      }
      prompt += `\n\nReturn ONLY the formatted title, without explanations. Output the result in the same language as the product title.`;
      break;

    case "description":
      prompt = `Format the following product description according to the formatting guidelines:\n\nCurrent Description:\n${currentValue}`;
      if (aiInstructions?.productDescriptionFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productDescriptionFormat}`;
      }
      if (aiInstructions?.productDescriptionInstructions) {
        prompt += `\n\nFormatting Instructions:\n${aiInstructions.productDescriptionInstructions}`;
      }
      prompt += `\n\nReturn ONLY the formatted description, without explanations. Output the result in the same language as the product title.`;
      break;

    case "handle":
      prompt = `Format the following URL slug according to the formatting guidelines:\n\nCurrent Slug:\n${currentValue}\n\nContext - Title: ${contextTitle}`;
      if (aiInstructions?.productHandleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productHandleFormat}`;
      }
      if (aiInstructions?.productHandleInstructions) {
        prompt += `\n\nFormatting Instructions:\n${aiInstructions.productHandleInstructions}`;
      }
      prompt += `\n\nReturn ONLY the formatted URL slug, without explanations. Output the result in the same language as the product title.`;
      break;

    case "seoTitle":
      prompt = `Format the following SEO title according to the formatting guidelines:\n\nCurrent SEO Title:\n${currentValue}\n\nContext - Title: ${contextTitle}\nDescription: ${contextDescription}`;
      if (aiInstructions?.productSeoTitleFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productSeoTitleFormat}`;
      }
      if (aiInstructions?.productSeoTitleInstructions) {
        prompt += `\n\nFormatting Instructions:\n${aiInstructions.productSeoTitleInstructions}`;
      }
      prompt += `\n\nReturn ONLY the formatted SEO title, without explanations. Output the result in the same language as the product title.`;
      break;

    case "metaDescription":
      prompt = `Format the following meta description according to the formatting guidelines:\n\nCurrent Meta Description:\n${currentValue}\n\nContext - Title: ${contextTitle}\nDescription: ${contextDescription}`;
      if (aiInstructions?.productMetaDescFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productMetaDescFormat}`;
      }
      if (aiInstructions?.productMetaDescInstructions) {
        prompt += `\n\nFormatting Instructions:\n${aiInstructions.productMetaDescInstructions}`;
      }
      prompt += `\n\nReturn ONLY the formatted meta description, without explanations. Output the result in the same language as the product title.`;
      break;
  }

  return prompt;
}

/**
 * Generates content using AI service based on field type
 */
async function generateContent(
  aiService: any,
  fieldType: FieldType,
  prompt: string,
  contextTitle: string
): Promise<string> {
  switch (fieldType) {
    case "title":
    case "handle":
    case "seoTitle":
    case "metaDescription":
      return await aiService.generateProductTitle(prompt);

    case "description":
      return await aiService.generateProductDescription(contextTitle, prompt);

    default:
      throw new Error(`Unknown field type: ${fieldType}`);
  }
}

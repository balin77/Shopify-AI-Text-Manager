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
 *
 * IMPORTANT: Format prompts preserve the original text and only apply formatting.
 * They do NOT rewrite or generate new content.
 */
function buildFormatPrompt(
  fieldType: FieldType,
  currentValue: string,
  contextTitle: string,
  contextDescription: string,
  aiInstructions: any
): string {
  // Default formatting instruction
  const defaultPreserveInstruction = `CRITICAL: You must PRESERVE the original text content. DO NOT rewrite, rephrase, or generate new content.
Only apply formatting changes such as:
- Adding separators (| or - or :)
- Adjusting capitalization
- Adding HTML tags for structure (<strong>, <em>, <h2>, <h3>, <ul>, <li>, <p>)
- Fixing punctuation and spacing
- Removing redundant characters

The meaning, words, and information must stay the same. Only the presentation/formatting changes.`;

  // Use custom instructions if provided, otherwise use default
  const preserveTextInstruction = aiInstructions?.formatPreserveInstructions || defaultPreserveInstruction;

  let prompt = "";

  switch (fieldType) {
    case "title":
      prompt = `Apply formatting to the following product title. Keep all words and meaning intact.

Original Title (preserve this content):
${currentValue}

${preserveTextInstruction}

Allowed formatting changes for titles:
- Add separators like | or - or – between parts
- Adjust capitalization (e.g., Title Case)
- Remove excessive punctuation
- Fix spacing issues`;
      if (aiInstructions?.productTitleFormat) {
        prompt += `\n\nFormat Style Example (for structure reference only, do NOT copy the content):\n${aiInstructions.productTitleFormat}`;
      }
      prompt += `\n\nReturn ONLY the formatted title. Keep the original language. Do NOT add new information or rewrite the text.`;
      break;

    case "description":
      prompt = `Apply HTML formatting to the following product description. Keep all words, sentences, and information intact.

Original Description (preserve this content):
${currentValue}

${preserveTextInstruction}

Allowed formatting changes for descriptions:
- Add HTML structure tags: <h2>, <h3>, <p>, <ul>, <li>
- Add emphasis: <strong>, <em>
- Convert plain lists to <ul>/<li> format
- Add paragraph breaks with <p> tags
- Fix spacing and punctuation`;
      if (aiInstructions?.productDescriptionFormat) {
        prompt += `\n\nFormat Style Example (for HTML structure reference only):\n${aiInstructions.productDescriptionFormat}`;
      }
      prompt += `\n\nReturn ONLY the formatted HTML description. Keep the original language and all original content. Do NOT add new sentences or rewrite existing ones.`;
      break;

    case "handle":
      prompt = `Format the following URL slug. Keep the core words intact.

Original Slug:
${currentValue}

Context - Title: ${contextTitle}

${preserveTextInstruction}

Allowed formatting changes for handles:
- Convert to lowercase
- Replace spaces with hyphens
- Convert umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
- Remove special characters
- Remove excessive hyphens`;
      if (aiInstructions?.productHandleFormat) {
        prompt += `\n\nFormat Style Example:\n${aiInstructions.productHandleFormat}`;
      }
      prompt += `\n\nReturn ONLY the formatted URL slug. Keep the original keywords.`;
      break;

    case "seoTitle":
      prompt = `Apply formatting to the following SEO title. Keep all words and meaning intact.

Original SEO Title (preserve this content):
${currentValue}

Context - Title: ${contextTitle}

${preserveTextInstruction}

Allowed formatting changes for SEO titles:
- Add separators like | or - between parts
- Adjust capitalization
- Fix spacing and punctuation
- Trim to appropriate length if too long`;
      if (aiInstructions?.productSeoTitleFormat) {
        prompt += `\n\nFormat Style Example (for structure reference only):\n${aiInstructions.productSeoTitleFormat}`;
      }
      prompt += `\n\nReturn ONLY the formatted SEO title. Keep the original language. Do NOT rewrite or add new content.`;
      break;

    case "metaDescription":
      prompt = `Apply formatting to the following meta description. Keep all words and meaning intact.

Original Meta Description (preserve this content):
${currentValue}

Context - Title: ${contextTitle}

${preserveTextInstruction}

Allowed formatting changes for meta descriptions:
- Fix punctuation and spacing
- Adjust sentence structure slightly for flow
- Trim to 150-160 characters if too long
- Ensure it ends properly (with punctuation)`;
      if (aiInstructions?.productMetaDescFormat) {
        prompt += `\n\nFormat Style Example (for style reference only):\n${aiInstructions.productMetaDescFormat}`;
      }
      prompt += `\n\nReturn ONLY the formatted meta description. Keep the original language and meaning. Do NOT rewrite or add new content.`;
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

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, CONTENT_CONFIGS } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { getCharacterLimitRequirement } from "~/utils/character-limits";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";
import { METAOBJECT_LABEL_FIELD_KEYS } from "~/constants/shopifyFields";
import { extractReadableName } from "~/utils/templates-field-factory";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { sanitizeSlug } from "~/utils/slug.utils";
import { resolveTemplateInstruction } from "~/services/content-template.service";
import type { Plan } from "~/config/plans";

export async function handleFormatField(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, contentType, itemId } = ctx;
  const formData = ctx.formData;

  const fieldType = getFormString(formData, "fieldType");
  const rawSourceText = getFormString(formData, "sourceText");
  const rawFormatInstruction = getFormString(formData, "formatInstruction") || "Improve and format this text while keeping the same language";

  if (!rawSourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }

  // Both fields are fully client-controlled and interpolated into the prompt.
  // Sanitize them (strip prompt-injection patterns) like the sibling handlers
  // do for contextTitle/contextDescription — without this, this handler was an
  // unguarded prompt-injection sink.
  const sourceText = sanitizePromptInput(rawSourceText, { fieldType: "general", allowNewlines: true });
  const formatInstruction = sanitizePromptInput(rawFormatInstruction, { fieldType: "general", allowNewlines: true });

  // Build the prompt
  const prompt = `${formatInstruction}

Text to format:
${sourceText}

Return only the formatted text, without explanations.`;

  // Create task entry with prompt
  const taskFieldLabel3 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "formatting",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: taskFieldLabel3,
      fieldType: taskFieldLabel3,
      progress: 0,
      // prompt is saved by AI service via savePromptToTask
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

    logger.debug("[API-AI] Formatting field", {
      context: "AI",
      fieldType,
      textLength: sourceText.length
    });

    const formattedValue = await aiService['askAI'](prompt);

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: formattedValue, // Store full AI response
      },
    });

    return json({
      success: true,
      formattedValue,
      fieldType
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

export async function handleGenerateAIText(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, seoTitleMaxChars, contentType, itemId } = ctx;
  const formData = ctx.formData;

  const fieldType = getFormString(formData, "fieldType");
  const currentValue = getFormString(formData, "currentValue");
  const contextTitle = getFormString(formData, "contextTitle") || "";
  const sanitizedContextTitle = sanitizePromptInput(contextTitle, { fieldType: "title" });
  const contextDescription = getFormString(formData, "contextDescription") || "";
  const sanitizedContextDescription = sanitizePromptInput(contextDescription, { fieldType: "description", allowNewlines: true });
  const mainLanguage = getFormString(formData, "mainLanguage") || "German";
  const sendImageToAI = formData.get("sendImageToAI") === "true";
  const imageUrl = getFormString(formData, "imageUrl") || undefined;

  // Load AI instructions for format guidelines
  const genAiInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  }) as Record<string, string | null> | null;

  // Resolve field definition for aiInstructionsKey
  const genContentConfig = CONTENT_CONFIGS[contentType];
  const genField = genContentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
  const genInstructionsKey = genField?.aiInstructionsKey;
  const genFormatKey = genInstructionsKey ? `${genInstructionsKey}Format` : null;
  const genInstructionsTextKey = genInstructionsKey ? `${genInstructionsKey}Instructions` : null;
  const genFieldLabel = genField?.label || fieldType;
  const isGenLongContent = genField?.type === "html";

  // Get instructions (with default fallback)
  const writingStyle = getWritingStyleInstructions(genAiInstructions);
  const formatExample = genFormatKey ? getInstructionWithDefault(genAiInstructions, genFormatKey) : null;
  const fieldInstructions = genInstructionsTextKey ? getInstructionWithDefault(genAiInstructions, genInstructionsTextKey) : null;

  // SEO Phase 5→AI bridge: the keywords tab lets a merchant track one target
  // keyword per item, then flags when that keyword is missing from the
  // title/meta — but generation itself never knew about it. `itemId` here is
  // the same Shopify GID the keywords route stores as `resourceId` (both come
  // straight from the content editor's `selectedItem.id`, e.g. db.product.id),
  // and locale "" is the primary-locale row the keywords feature manages, so
  // this lookup matches keys 1:1 with no normalization needed.
  //
  // Locale dimension (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5b): `mainLanguage`
  // here is a human-readable display name (e.g. "German"), not a Shopify
  // locale code, and this handler always generates content in the PRIMARY
  // language — locale "" therefore stays correct. If a future translation-
  // generation flow starts passing an explicit target locale/language code
  // through `ctx`/formData, the lookup below should switch to that locale's
  // SeoKeyword row instead of hardcoding "".
  const trackedKeywordRow = ["title", "seoTitle", "metaDescription", "description"].includes(fieldType)
    ? await db.seoKeyword.findUnique({
        where: { shop_resourceId_locale: { shop: session.shop, resourceId: itemId, locale: "" } },
      })
    : null;
  const sanitizedTrackedKeyword = trackedKeywordRow
    ? sanitizePromptInput(trackedKeywordRow.keyword, { fieldType: "general" })
    : null;

  // Build field-type-aware prompt
  let prompt = `Create an improved ${genFieldLabel} for the following content.`;

  // Add context information
  prompt += `\n\nContext - Title: ${sanitizedContextTitle}`;
  if (!isGenLongContent && sanitizedContextDescription) {
    prompt += `\nContext - Description: ${sanitizedContextDescription}`;
  }
  if (currentValue) {
    prompt += `\nCurrent ${genFieldLabel}: ${currentValue}`;
  }
  prompt += `\nLanguage: ${mainLanguage}`;

  // Add requirements section
  prompt += `\n\nRequirements:`;

  // Add character limit if available
  const charLimit = genInstructionsKey ? getCharacterLimitRequirement(genInstructionsKey, seoTitleMaxChars) : null;
  if (charLimit) {
    prompt += `\n- Length: ${charLimit}`;
  }

  if (sanitizedTrackedKeyword) {
    prompt += `\n- Naturally include the target keyword "${sanitizedTrackedKeyword}" (do not stuff it).`;
  }

  if (genField?.type === "slug") {
    prompt += `\n- Use only lowercase letters (a-z), digits (0-9), and hyphens (-)`;
    prompt += `\n- No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss)`;
    prompt += `\n- No spaces, underscores, or special characters`;
    prompt += `\n- 2-5 relevant keywords`;
  } else if (isGenLongContent) {
    prompt += `\n- Use HTML formatting (<h2>, <h3>, <p>, <strong>, <em>, <ul>, <li>)`;
    prompt += `\n- Structure content with headings and paragraphs`;
    prompt += `\n- Focus on readability and user engagement`;
  } else {
    prompt += `\n- Clear and concise`;
    prompt += `\n- SEO-friendly where applicable`;
    prompt += `\n- Customer-focused language`;
  }

  // Add writing style (compact)
  if (writingStyle) {
    prompt += `\n\nWriting Style:\n${writingStyle}`;
  }

  // Add format example (compact)
  if (formatExample) {
    prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;
  }

  // Add field-specific instructions (compact)
  if (fieldInstructions) {
    prompt += `\n\nGuidelines:\n${fieldInstructions}`;
  }

  // Content-Template (Pro/Max only): if the shop configured a default prompt
  // template for this contentType+field, substitute its {{variables}} from the
  // current content data and append it. Plan re-checked + values sanitized
  // inside the service (defence in depth against prompt injection).
  //
  // Layered order (matches user-confirmed design decision, 2026-07):
  //   1. Custom-Instructions from AISettings (writingStyle/formatExample/
  //      fieldInstructions) — already appended ABOVE (see ~line 206–218).
  //   2. Template (this hunk) — appended here so it cannot override the
  //      merchant-configured writing style.
  //   3. Glossary — injected centrally inside AIService (translation paths
  //      only today; generation path does not glossary-inject).
  // A downstream failure here must never block generation.
  try {
    const plan = (ctx.settings?.subscriptionPlan || "free") as Plan;
    const resolvedTemplate = await resolveTemplateInstruction({
      shop: session.shop,
      plan,
      contentType,
      fieldType,
      vars: {
        // Pass the already-sanitized context values (the service sanitizes
        // again as defence in depth, but never rely on a single layer).
        title: sanitizedContextTitle,
        name: sanitizedContextTitle,
        product_name: sanitizedContextTitle,
        description: sanitizedContextDescription,
        current_value: currentValue,
        language: mainLanguage,
        field_label: genFieldLabel,
      },
    });
    if (resolvedTemplate) {
      prompt += `\n\nTemplate:\n${resolvedTemplate.instruction}`;
    }
  } catch (templateErr) {
    // A template failure must never block generation — log and continue with
    // the standard prompt.
    logger.warn("[API-AI] Content template resolution failed", {
      context: "AI",
      error: templateErr instanceof Error ? templateErr.message : String(templateErr),
    });
  }

  // Hard length override — placed last so it wins over any conflicting instruction above
  if (charLimit) {
    prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimit}. This overrides any other length or character count instruction in this prompt.`;
  }

  prompt += `\n\nIMPORTANT: Return ONLY the ${genFieldLabel}, nothing else. Output in ${mainLanguage}.`;

  // Create task entry (prompt is saved by AI service via savePromptToTask)
  const taskFieldLabel4 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: taskFieldLabel4,
      fieldType: taskFieldLabel4,
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

    logger.debug("[API-AI] Generating AI text", {
      context: "AI",
      fieldType,
      textLength: currentValue?.length || 0,
      hasFormatExample: !!(genFormatKey && genAiInstructions?.[genFormatKey]),
      hasInstructions: !!(genInstructionsTextKey && genAiInstructions?.[genInstructionsTextKey]),
    });

    // Use appropriate method based on field type
    let generatedContent: string;
    const imageUrlToSend = sendImageToAI ? imageUrl : undefined;
    if (isGenLongContent) {
      generatedContent = await aiService.generateProductDescription(sanitizedContextTitle, prompt, imageUrlToSend);
    } else {
      generatedContent = await aiService.generateProductTitle(prompt, imageUrlToSend);
    }

    // Sanitize slugs
    if (genField?.type === "slug") {
      generatedContent = sanitizeSlug(generatedContent);
    }

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: generatedContent, // Store full AI response
      },
    });

    return json({
      success: true,
      generatedContent,
      fieldType
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

export async function handleFormatAIText(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, contentType, itemId } = ctx;
  const formData = ctx.formData;

  const fieldType = getFormString(formData, "fieldType");
  const currentValue = getFormString(formData, "currentValue");
  const contextTitle = getFormString(formData, "contextTitle") || "";
  const sanitizedContextTitle = sanitizePromptInput(contextTitle, { fieldType: "title" });
  const contextDescription = getFormString(formData, "contextDescription") || "";
  const sanitizedContextDescription = sanitizePromptInput(contextDescription, { fieldType: "description", allowNewlines: true });
  const mainLanguage = getFormString(formData, "mainLanguage") || "German";
  const sendImageToAI = formData.get("sendImageToAI") === "true";
  const imageUrl = getFormString(formData, "imageUrl") || undefined;

  if (!currentValue) {
    return json({ success: false, error: "No content available to format" }, { status: 400 });
  }

  // Load AI instructions for format examples and guidelines
  // Cast to Record for dynamic key access (keys are built from aiInstructionsKey)
  const aiInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  }) as Record<string, string | null> | null;

  // Resolve field definition to get the correct aiInstructionsKey
  const contentConfig = CONTENT_CONFIGS[contentType];
  const field = contentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
  const instructionsKey = field?.aiInstructionsKey;
  const formatKey = instructionsKey ? `${instructionsKey}Format` : null;
  const instructionsTextKey = instructionsKey ? `${instructionsKey}Instructions` : null;

  const fieldLabel = field?.label || fieldType;

  // Determine if this field supports HTML formatting
  // Only description/body fields and blog summary (type "html") get HTML formatting
  const supportsHtmlFormatting = field?.type === "html";

  // Build field-type-aware prompt
  let prompt = "";
  let isLongContent = false;

  if (field?.type === "slug") {
    prompt = `Format the following URL slug. Keep the core words intact.

Original Slug:
${currentValue}

Context - Title: ${sanitizedContextTitle}

Allowed formatting changes for handles:
- Convert to lowercase
- Replace spaces with hyphens
- Convert umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
- Remove special characters
- Remove excessive hyphens`;
    if (formatKey) {
      const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
      if (formatExample) {
        prompt += `\n\nFormat Style Example:\n${formatExample}`;
      }
    }
    if (instructionsTextKey) {
      const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
      if (fieldInstructions) {
        prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
      }
    }
    prompt += `\n\nReturn ONLY the formatted URL slug. Keep the original keywords.`;
  } else if (supportsHtmlFormatting) {
    // HTML fields: description, body, blog summary - full HTML formatting allowed
    isLongContent = true;
    prompt = `Apply HTML formatting to the following ${fieldLabel}. Keep the core content and meaning intact, but you may make slight adjustments to improve readability and presentation.

Original ${fieldLabel}:
${currentValue}

You may:
- Add HTML structure tags: <h2>, <h3>, <p>, <ul>, <li>
- Add emphasis: <strong>, <em>
- Convert plain lists to <ul>/<li> format
- Add paragraph breaks with <p> tags
- Fix spacing, punctuation, and grammar
- Slightly rephrase for better flow or clarity (but keep the meaning)

Do NOT:
- Completely rewrite or replace the content
- Add entirely new information or paragraphs
- Change the language or tone significantly`;
    if (formatKey) {
      const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
      if (formatExample) {
        prompt += `\n\nFormat Style Example (for HTML structure reference):\n${formatExample}`;
      }
    }
    if (instructionsTextKey) {
      const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
      if (fieldInstructions) {
        prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
      }
    }
    prompt += `\n\nReturn ONLY the formatted HTML ${fieldLabel}. Keep the original language. Output the result in ${mainLanguage}.`;
  } else {
    // Text fields (title, seoTitle, metaDescription, etc.) - light formatting only, no HTML
    prompt = `Improve the formatting of the following ${fieldLabel}. Keep the core content intact but you may make slight adjustments to improve presentation.

Original ${fieldLabel}:
${currentValue}

You may:
- Adjust capitalization (e.g., Title Case)
- Add or improve separators (| or - or –)
- Fix punctuation, spacing, and grammar
- Slightly rephrase for better readability or flow

Do NOT:
- Add any HTML tags
- Completely rewrite the content
- Add new information that wasn't there
- Change the language or core meaning`;
    if (formatKey) {
      const formatExample = getInstructionWithDefault(aiInstructions, formatKey);
      if (formatExample) {
        prompt += `\n\nFormat Style Example (use as structural reference, adapt to the actual content):\n${formatExample}`;
      }
    }
    if (instructionsTextKey) {
      const fieldInstructions = getInstructionWithDefault(aiInstructions, instructionsTextKey);
      if (fieldInstructions) {
        prompt += `\n\nAdditional Instructions:\n${fieldInstructions}`;
      }
    }
    prompt += `\n\nReturn ONLY the formatted ${fieldLabel} as plain text (no HTML). Keep the original language. Output the result in ${mainLanguage}.`;
  }

  // Create task entry (prompt is saved by AI service via savePromptToTask)
  const taskFieldLabel5 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "formatting",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: taskFieldLabel5,
      fieldType: taskFieldLabel5,
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

    logger.debug("[API-AI] Formatting AI text", {
      context: "AI",
      fieldType,
      textLength: currentValue.length,
      hasFormatExample: !!(formatKey && aiInstructions?.[formatKey]),
      hasInstructions: !!(instructionsTextKey && aiInstructions?.[instructionsTextKey]),
    });

    // Use appropriate method based on field type
    let formattedValue: string;
    const imageUrlToSend = sendImageToAI ? imageUrl : undefined;
    if (isLongContent) {
      formattedValue = await aiService.generateProductDescription(currentValue, prompt, imageUrlToSend);
    } else {
      formattedValue = await aiService.generateProductTitle(prompt, imageUrlToSend);
    }

    // Sanitize slugs
    if (field?.type === "slug") {
      formattedValue = sanitizeSlug(formattedValue);
    }

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: formattedValue,
      },
    });

    return json({
      success: true,
      generatedContent: formattedValue,
      fieldType
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

/**
 * `insertKeyword` — work a tracked keyword into ONE field without rewriting it.
 *
 * The narrow sibling of `formatAIText`. Formatting is allowed to restructure
 * the text and only works a missing primary in as a side effect; this pass has
 * the opposite contract: the text stays as it is, and the single permitted
 * change is that the target keyword now appears in it. That is what a merchant
 * wants after adding a keyword to an item whose copy is already final.
 *
 * Two things it will NOT do, both deliberate:
 *
 *  - **Nothing when the keyword is already there.** Presence is decided by
 *    `analyzeOnPage` (word-boundary aware, same rule the keywords tab shows),
 *    so the answer costs no AI call and the field is returned untouched with
 *    `skipped: true`. On a well-maintained item the whole run is free.
 *  - **No secondaries.** Only the PRIMARY keyword is inserted. Offering four
 *    optional phrases to a pass that is supposed to preserve the text is how
 *    "insert" turns into "rewrite" — the same reasoning that keeps them out of
 *    `keywordPreservationLine`.
 *
 * The SEO rules still apply: the field's character ceiling is enforced (a
 * keyword must not push an SEO title past its limit) and the stuffing guard
 * runs with one retry, exactly as in the generation path.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, CONTENT_CONFIGS } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { getCharacterCeilingRequirement } from "~/utils/character-limits";
import { sanitizePromptInput, isValidFieldType } from "~/utils/prompt-sanitizer";
import { analyzeOnPage } from "~/services/seo/keywords.service";
import {
  findStuffedKeyword,
  loadTrackedKeywords,
  resolveKeywordLocale,
  stuffingRetryWarning,
} from "./keyword-prompt";
import type { DataResponse } from "~/types/data-response";

export async function handleInsertKeyword(ctx: AIActionContext): Promise<DataResponse> {
  const { session, db, settings, seoTitleMaxChars, seoLimits, contentType, itemId } = ctx;
  const formData = ctx.formData;

  const fieldType = getFormString(formData, "fieldType");
  const currentValue = getFormString(formData, "currentValue");
  if (!fieldType) {
    return json({ success: false, error: "Missing fieldType" }, { status: 400 });
  }

  // A field with no text is not "missing its keyword" — it is empty, and
  // inventing content is generation's job, not this pass's.
  if (!currentValue.trim()) {
    return json({ success: true, skipped: true, reason: "empty", fieldType, value: currentValue });
  }

  const locale = resolveKeywordLocale(formData);
  const tracked = await loadTrackedKeywords(db, session.shop, itemId, locale, fieldType);
  if (!tracked.primary) {
    return json({ success: true, skipped: true, reason: "noKeyword", fieldType, value: currentValue });
  }

  // The whole point of the confirmed "skip" rule: already present → no call,
  // no change, no risk of the model touching a finished text.
  if (analyzeOnPage({ keyword: tracked.primary, bodyHtml: currentValue }).presence.body) {
    return json({ success: true, skipped: true, reason: "present", fieldType, value: currentValue });
  }

  const contentConfig = CONTENT_CONFIGS[contentType];
  const field = contentConfig?.fieldDefinitions.find((f) => f.key === fieldType);
  const instructionsKey = field?.aiInstructionsKey;

  // A slug is not prose: it cannot absorb a phrase by rewording, and changing
  // it breaks live URLs. Excluded outright rather than handled specially.
  if (field?.type === "slug") {
    return json({ success: true, skipped: true, reason: "slug", fieldType, value: currentValue });
  }

  // CEILING only — the same reasoning as the format path: a minimum would pad
  // a deliberately short value while we are supposed to be preserving it.
  const ceiling = instructionsKey
    ? getCharacterCeilingRequirement(instructionsKey, { seoTitleMaxChars, limits: seoLimits })
    : null;

  const isHtml = field?.type === "html";
  const sanitizedValue = sanitizePromptInput(currentValue, {
    fieldType: isValidFieldType(fieldType) ? fieldType : undefined,
    allowNewlines: true,
  });
  const keyword = sanitizePromptInput(tracked.primary, { fieldType: "general" });

  const basePrompt = `Below is an existing ${field?.label || fieldType} text. It does not yet contain the target keyword "${keyword}".

TEXT:
${sanitizedValue}

Your ONLY task is to make the exact phrase "${keyword}" appear in this text ONCE.

Rules:
- Change as little as possible. Reword ONE existing phrase or sentence so the keyword fits naturally.
- Do NOT append a new sentence, heading or list item.
- Do NOT rephrase, reorder, shorten or "improve" anything else — every other sentence must come back unchanged.
- Keep the original language, tone and meaning.
- Do NOT add any other keyword.${isHtml ? "\n- Preserve the HTML structure and every tag exactly." : ""}
- If the keyword genuinely cannot be worked in without distorting the meaning, return the text UNCHANGED.${ceiling ? `\n- ${ceiling}` : ""}

Return ONLY the resulting text. No explanation, no quotes, no markdown fences.`;

  // Task row like every other AI action: it is what carries the prompt into
  // the Tasks-tab audit trail (the AI service writes it via savePromptToTask)
  // and what createAIService needs to attribute the call.
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "insertKeyword",
      status: "running",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: field?.label || fieldType,
      fieldType,
      progress: 20,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiService = createAIService(settings, session.shop, task.id);
    let result = (await aiService["askAI"](basePrompt)).trim();

    // Same guard as generation: one retry, then accept with a warning rather
    // than silently persisting a stuffed value.
    const isLongContent = isHtml || fieldType === "description" || fieldType === "body";
    let stuffed = findStuffedKeyword(result, [keyword], isLongContent);
    if (stuffed) {
      result = (
        await aiService["askAI"](basePrompt + stuffingRetryWarning(stuffed, isLongContent))
      ).trim();
      stuffed = findStuffedKeyword(result, [keyword], isLongContent);
    }

    if (!result) {
      await db.task.update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: "AI returned an empty value" },
      });
      return json({ success: false, error: "AI returned an empty value" }, { status: 502 });
    }

    await db.task.update({
      where: { id: task.id },
      data: { status: "completed", progress: 100, completedAt: new Date() },
    });

    // The model was allowed to decline. Report that as a skip so the caller
    // does not mark the field dirty for an identical value.
    const changed = result !== currentValue.trim();
    if (!changed) {
      return json({
        success: true,
        skipped: true,
        reason: "notInsertable",
        fieldType,
        value: currentValue,
      });
    }

    return json({
      success: true,
      skipped: false,
      fieldType,
      value: result,
      keyword: tracked.primary,
      keywordStuffingWarning: !!stuffed,
    });
  } catch (error: unknown) {
    await db.task
      .update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage(error).substring(0, 1000),
        },
      })
      .catch(() => {});
    return json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}

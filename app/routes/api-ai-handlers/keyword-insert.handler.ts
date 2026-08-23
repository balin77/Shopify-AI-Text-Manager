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
 *  - **Never force a keyword in.** Every tracked keyword of the locale is
 *    offered, but only the ones still MISSING are asked for, and the prompt is
 *    explicit that a keyword which would distort the meaning — or would not
 *    fit a short field's character ceiling — is to be left out. Five keywords
 *    do not fit a 60-character SEO title, and pretending otherwise is how a
 *    preserving pass turns into stuffing.
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
  if (tracked.all.length === 0) {
    return json({ success: true, skipped: true, reason: "noKeyword", fieldType, value: currentValue });
  }

  // The confirmed skip rule, applied per keyword: whatever is already in the
  // text costs no AI call and is never mentioned to the model. All present →
  // no call at all, and the finished text is not touched.
  const missing = tracked.all.filter(
    (keyword) => !analyzeOnPage({ keyword, bodyHtml: currentValue }).presence.body,
  );
  if (missing.length === 0) {
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
  const sanitizedMissing = missing.map((keyword) =>
    sanitizePromptInput(keyword, { fieldType: "general" }),
  );
  const keywordList = sanitizedMissing.map((keyword) => `"${keyword}"`).join(", ");
  const isPrimaryMissing = !!tracked.primary && missing[0] === tracked.primary;

  const basePrompt = `Below is an existing ${field?.label || fieldType} text. These target keywords do not appear in it yet: ${keywordList}.

TEXT:
${sanitizedValue}

Your ONLY task is to make as many of those keywords as fit naturally appear in this text, each at most ONCE.

Rules:
- Change as little as possible. Reword existing phrases so a keyword fits; never write new content around one.
- Do NOT append a new sentence, heading or list item.
- Do NOT rephrase, reorder, shorten or "improve" anything else — every sentence you are not using to place a keyword must come back unchanged.
- Keep the original language, tone and meaning.
- Never place more than one keyword in the same sentence.
- LEAVE OUT any keyword that would distort the meaning, read as forced, or not fit. Fewer keywords worked in well is the correct outcome; cramming them all in is not.${
    isPrimaryMissing ? `\n- If only one fits, it must be "${sanitizedMissing[0]}".` : ""
  }${isHtml ? "\n- Preserve the HTML structure and every tag exactly." : ""}
- If none of them can be worked in, return the text UNCHANGED.${ceiling ? `\n- ${ceiling}` : ""}

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
    // The guard measures EVERY tracked keyword, not just the inserted ones —
    // adding one can push a keyword that was already present over the line.
    let stuffed = findStuffedKeyword(result, tracked.all, isLongContent);
    if (stuffed) {
      result = (
        await aiService["askAI"](basePrompt + stuffingRetryWarning(stuffed, isLongContent))
      ).trim();
      stuffed = findStuffedKeyword(result, tracked.all, isLongContent);
    }

    if (!result) {
      await db.task.update({
        where: { id: task.id },
        // A machine code for the Tasks card (`taskErrorText`); the HTTP body
        // below stays an English message — it is read by our own client.
        data: { status: "failed", completedAt: new Date(), error: "ai_empty_value" },
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
      // What actually landed — the model is allowed to leave keywords out, so
      // this is measured on the RESULT rather than assumed from the request.
      inserted: missing.filter(
        (keyword) => analyzeOnPage({ keyword, bodyHtml: result }).presence.body,
      ),
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

import { isThemeMediaValue } from "~/utils/theme-image-reference.shared";
import { data as json } from "react-router";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { withUserInstruction } from "~/utils/ai-user-instruction.server";
import { extractReadableName } from "~/utils/templates-field-factory";
import type { TemplatesActionContext } from "./shared";
import type { DataResponse } from "~/types/data-response";
import { aiServiceFor } from "~/services/ai/ai-credentials.server";
import { aiRefusalFor, managedRefusalResponseFromError } from "~/utils/ai-refusal-response.server";

export async function handleGenerateAIText(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { db, session, formData, groupId, firstGroup, domain } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const currentValue = getFormString(formData, "currentValue");
  const mainLanguage = getFormString(formData, "mainLanguage");
  const fieldLabel = extractReadableName(fieldType);
  if (isThemeMediaValue(currentValue)) {
    return json({ success: false, error: "Images and videos are not translated or rewritten by the AI.", code: "themeMediaValue" }, { status: 400 });
  }

  // Compliance gate: whose key, consent, kill switch and budget — before a
  // Task row exists (same as templates-translate-field).
  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  const refusal = await aiRefusalFor(settings, session.shop, { actionType: "generateAIText", fieldType });
  if (refusal) {
    return refusal;
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: domain,
      resourceId: `group_${groupId}`,
      resourceTitle: firstGroup.groupName,
      fieldType: fieldLabel,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const aiService = aiServiceFor(settings, session.shop, task.id).service;

    let prompt = `Improve the following template field content.

Field: ${fieldType}
Current value: ${currentValue}
Context: ${firstGroup.groupName}
Language: ${mainLanguage}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content in ${mainLanguage}.`;

    // Merchant's per-request instruction — last word, outranks everything above.
    prompt = withUserInstruction(prompt, formData);

    const generatedContent = await aiService["askAI"](prompt);

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: generatedContent.substring(0, 1000),
      },
    });

    return json({
      success: true,
      generatedContent,
      fieldType,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: msg.substring(0, 1000),
      },
    });
    const refused = managedRefusalResponseFromError(error, settings, { actionType: "generateAIText", fieldType });
    if (refused) return refused;
    return json({ success: false, error: msg, actionType: "generateAIText", fieldType }, { status: 500 });
  }
}

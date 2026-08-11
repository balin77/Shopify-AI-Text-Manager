import { data as json } from "react-router";
import { AIService, toValidProvider } from "../../../src/services/ai.service";
import { tryDecryptApiKey } from "~/utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { extractReadableName } from "~/utils/templates-field-factory";
import type { TemplatesActionContext } from "./shared";
import type { DataResponse } from "~/types/data-response";

export async function handleGenerateAIText(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { db, session, formData, groupId, firstGroup, domain } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const currentValue = getFormString(formData, "currentValue");
  const mainLanguage = getFormString(formData, "mainLanguage");
  const fieldLabel = extractReadableName(fieldType);

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
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });

    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const aiService = new AIService(
      toValidProvider(settings?.preferredProvider),
      {
        huggingfaceApiKey: tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface") || undefined,
        geminiApiKey: tryDecryptApiKey(settings?.geminiApiKey, "gemini") || undefined,
        claudeApiKey: tryDecryptApiKey(settings?.claudeApiKey, "claude") || undefined,
        openaiApiKey: tryDecryptApiKey(settings?.openaiApiKey, "openai") || undefined,
        grokApiKey: tryDecryptApiKey(settings?.grokApiKey, "grok") || undefined,
        deepseekApiKey: tryDecryptApiKey(settings?.deepseekApiKey, "deepseek") || undefined,
      },
      session.shop,
      task.id
    );

    const prompt = `Improve the following template field content.

Field: ${fieldType}
Current value: ${currentValue}
Context: ${firstGroup.groupName}
Language: ${mainLanguage}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content in ${mainLanguage}.`;

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
    return json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * Translation Actions
 *
 * Handles single-field translation operations:
 * - translateField: Translates a single field to one target locale
 * - translateSuggestion: Preview translation before applying
 */

import { json } from "@remix-run/node";
import { TranslationService } from "../../../src/services/translation.service";
import { loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";
import {
  createProductTask,
  updateTaskStatus,
  completeTask,
  failTask,
} from "./shared/task-helpers";
import { handleActionError } from "./shared/error-handlers";

interface TranslateFieldParams {
  fieldType: string;
  sourceText: string;
  targetLocale: string;
  productId: string;
}

interface TranslateSuggestionParams {
  suggestion: string;
  fieldType: string;
}

/**
 * Translates a single field to one target locale
 */
export async function handleTranslateField(
  context: ActionContext,
  formData: FormData,
  productId: string
): Promise<Response> {
  const action = "translateField";

  const params: TranslateFieldParams = {
    fieldType: formData.get("fieldType") as string,
    sourceText: formData.get("sourceText") as string,
    targetLocale: formData.get("targetLocale") as string,
    productId,
  };

  loggers.translation("info", "Starting field translation", {
    ...params,
    shop: context.session.shop,
  });

  // Create task
  const task = await createProductTask({
    shop: context.session.shop,
    type: "translation",
    resourceType: "product",
    resourceId: productId,
    fieldType: params.fieldType,
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
    changedFields[params.fieldType] = params.sourceText;

    await updateTaskStatus(task.id, "queued", { progress: 10 });

    const translations = await translationService.translateProduct(
      changedFields,
      [params.targetLocale],
      "product"
    );
    const translatedValue = translations[params.targetLocale]?.[params.fieldType] || "";

    await completeTask(task.id, {
      translatedValue,
      fieldType: params.fieldType,
      targetLocale: params.targetLocale,
    });

    loggers.translation("info", "Field translation completed", {
      taskId: task.id,
      fieldType: params.fieldType,
      targetLocale: params.targetLocale,
    });

    return json({
      success: true,
      translatedValue,
      fieldType: params.fieldType,
      targetLocale: params.targetLocale,
    });
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
 * Translates a suggestion for preview (no task tracking)
 */
export async function handleTranslateSuggestion(
  context: ActionContext,
  formData: FormData
): Promise<Response> {
  const action = "translateSuggestion";

  const params: TranslateSuggestionParams = {
    suggestion: formData.get("suggestion") as string,
    fieldType: formData.get("fieldType") as string,
  };

  loggers.translation("info", "Translating suggestion", {
    fieldType: params.fieldType,
    shop: context.session.shop,
  });

  try {
    const translationService = new TranslationService(
      context.provider,
      context.config,
      context.session.shop
    );

    const changedFields: any = {};
    changedFields[params.fieldType] = params.suggestion;

    const translations = await translationService.translateProduct(
      changedFields,
      undefined,
      "product"
    );

    loggers.translation("info", "Suggestion translation completed", {
      fieldType: params.fieldType,
      localesCount: Object.keys(translations).length,
    });

    return json({ success: true, translations, fieldType: params.fieldType });
  } catch (error: any) {
    return handleActionError(error, {
      action,
      provider: context.provider,
    });
  }
}

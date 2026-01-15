/**
 * Product Options Translation Action
 *
 * Handles translation of product options (variants):
 * - translateOption: Translates option name and all option values to target locale
 *
 * Example: Color option with values ["Red", "Blue", "Green"]
 * becomes Farbe with ["Rot", "Blau", "Grün"] in German
 */

import { json } from "@remix-run/node";
import { TranslationService } from "../../../src/services/translation.service";
import { loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";
import { handleActionError } from "./shared/error-handlers";

interface TranslateOptionParams {
  optionId: string;
  optionName: string;
  optionValues: string[];
  targetLocale: string;
}

/**
 * Translates a product option (name + all values) to target locale
 */
export async function handleTranslateOption(
  context: ActionContext,
  formData: FormData
): Promise<Response> {
  const action = "translateOption";

  const params: TranslateOptionParams = {
    optionId: formData.get("optionId") as string,
    optionName: formData.get("optionName") as string,
    optionValues: JSON.parse(formData.get("optionValues") as string),
    targetLocale: formData.get("targetLocale") as string,
  };

  loggers.translation("info", "Translating product option", {
    optionId: params.optionId,
    optionName: params.optionName,
    valuesCount: params.optionValues.length,
    targetLocale: params.targetLocale,
    shop: context.session.shop,
  });

  try {
    const translationService = new TranslationService(
      context.provider,
      context.config,
      context.session.shop
    );

    // Translate the option name
    const nameTranslations = await translationService.translateProduct(
      { optionName: params.optionName },
      [params.targetLocale],
      "product"
    );
    const translatedName = nameTranslations[params.targetLocale]?.optionName || "";

    // Translate all option values
    const valueFields: any = {};
    params.optionValues.forEach((value: string, index: number) => {
      valueFields[`value_${index}`] = value;
    });

    const valueTranslations = await translationService.translateProduct(
      valueFields,
      [params.targetLocale],
      "product"
    );

    const translatedValues = params.optionValues.map((_: string, index: number) => {
      return valueTranslations[params.targetLocale]?.[`value_${index}`] || "";
    });

    loggers.translation("info", "Option translation completed", {
      optionId: params.optionId,
      targetLocale: params.targetLocale,
      translatedValuesCount: translatedValues.length,
    });

    return json({
      success: true,
      optionId: params.optionId,
      translatedName,
      translatedValues,
      targetLocale: params.targetLocale,
    });
  } catch (error: any) {
    return handleActionError(error, {
      action,
      optionId: params.optionId,
      provider: context.provider,
    });
  }
}

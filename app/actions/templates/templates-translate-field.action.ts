import { json } from "@remix-run/node";
import { AIService, toValidProvider } from "../../../src/services/ai.service";
import { getMissingPreferredKey, noAiKeyResponse } from "~/routes/api-ai-handlers/shared";
import { tryDecryptApiKey } from "~/utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";
import { extractReadableName } from "~/utils/templates-field-factory";
import { TRANSLATE_CONTENT } from "~/graphql/content.mutations";
import type { TemplatesActionContext, TranslatableField } from "./shared";

export async function handleTranslateField(ctx: TemplatesActionContext): Promise<Response> {
  const { admin, db, session, formData, groupId, firstGroup, themeGroups, resourceId, keyToResourceId } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
  const translateFieldLabel = extractReadableName(fieldType);

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }

  // Compliance gate: require the shop's own AI key before creating a task.
  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  const missingKey = getMissingPreferredKey(settings);
  if (missingKey) {
    return noAiKeyResponse(settings, missingKey);
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: "templates",
      resourceId: `group_${groupId}`,
      resourceTitle: firstGroup.groupName,
      fieldType: translateFieldLabel,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const primaryLocale = primaryLocaleFromForm || "en";

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

    const translatedValue = await aiService.translateContent(sourceText, primaryLocale, targetLocale);

    // Save to Shopify FIRST — only persist to local DB on success
    const fieldResId = keyToResourceId.get(fieldType) || resourceId;
    const allContentForSingle = themeGroups.flatMap(
      (group) => (group.translatableContent as unknown) as TranslatableField[]
    );
    const singleFieldDigest = allContentForSingle.find((item) => item.key === fieldType)?.digest;

    if (!singleFieldDigest) {
      throw new Error(
        `No digest available for field "${fieldType}" — cannot save translation to Shopify`
      );
    }

    const response = await admin.graphql(TRANSLATE_CONTENT, {
      variables: {
        resourceId: fieldResId,
        translations: [
          {
            key: fieldType,
            value: translatedValue,
            locale: targetLocale,
            translatableContentDigest: singleFieldDigest,
          },
        ],
      },
    });
    const data = await response.json();

    if (data.data?.translationsRegister?.userErrors?.length > 0) {
      const errors = data.data.translationsRegister.userErrors;
      throw new Error(`Shopify rejected translation: ${errors[0].message}`);
    }

    logger.info("[TEMPLATES] translateField: Shopify translation registered", {
      context: "Templates",
      fieldType,
      targetLocale,
    });

    // Shopify succeeded — now save to local DB
    await db.themeTranslation.upsert({
      where: {
        shop_resourceId_groupId_key_locale: {
          shop: session.shop,
          resourceId: fieldResId,
          groupId: groupId,
          key: fieldType,
          locale: targetLocale,
        },
      },
      update: { value: translatedValue, updatedAt: new Date() },
      create: {
        shop: session.shop,
        groupId: groupId,
        resourceId: fieldResId,
        domain: "theme",
        locale: targetLocale,
        key: fieldType,
        value: translatedValue,
      },
    });

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: translatedValue.substring(0, 1000),
      },
    });

    return json({ success: true, translatedValue, fieldType, targetLocale });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}

export async function handleTranslateFieldToAllLocales(ctx: TemplatesActionContext): Promise<Response> {
  const { admin, db, session, formData, groupId, firstGroup, themeGroups, resourceId, keyToResourceId } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
  const translateAllFieldLabel = extractReadableName(fieldType);

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }

  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target locales specified" }, { status: 400 });
  }

  // Compliance gate: require the shop's own AI key before creating a task.
  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  const missingKey = getMissingPreferredKey(settings);
  if (missingKey) {
    return noAiKeyResponse(settings, missingKey);
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: "templates",
      resourceId: `group_${groupId}`,
      resourceTitle: firstGroup.groupName,
      fieldType: translateAllFieldLabel,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 10 },
    });

    const primaryLocale = primaryLocaleFromForm || "en";

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

    const translations: Record<string, string> = {};
    const pendingUpserts: Array<{ locale: string; value: string }> = [];

    // One batched/chunked AI call (1 field × M locales) replaces the old
    // per-locale translateContent loop.
    const batchResult = await aiService.translateFieldsToLocalesChunked(
      { [fieldType]: sourceText },
      primaryLocale,
      targetLocales,
      { preserveHtml: true, contextLabel: "template content" }
    );

    for (const locale of targetLocales) {
      const value = batchResult[locale]?.[fieldType];
      // Missing cell → skip (N-H3: never persist source as a translation).
      // Persistence below is driven exclusively by `pendingUpserts`.
      if (!value) continue;
      translations[locale] = value;
      pendingUpserts.push({ locale, value });
    }

    await db.task.update({ where: { id: task.id }, data: { progress: 60 } });

    // Save to Shopify FIRST — only persist to local DB on success
    const fieldResId2 = keyToResourceId.get(fieldType) || resourceId;
    const allContentForField = themeGroups.flatMap(
      (group) => (group.translatableContent as unknown) as TranslatableField[]
    );
    const fieldDigest = allContentForField.find((item) => item.key === fieldType)?.digest;

    if (!fieldDigest) {
      throw new Error(
        `No digest available for field "${fieldType}" — cannot save translations to Shopify`
      );
    }

    if (pendingUpserts.length > 0) {
      const translationInputs = pendingUpserts.map(({ locale, value }) => ({
        key: fieldType,
        value,
        locale,
        translatableContentDigest: fieldDigest,
      }));

      const response = await admin.graphql(TRANSLATE_CONTENT, {
        variables: { resourceId: fieldResId2, translations: translationInputs },
      });
      const data = await response.json();

      if (data.data?.translationsRegister?.userErrors?.length > 0) {
        const errors = data.data.translationsRegister.userErrors;
        throw new Error(`Shopify rejected translations: ${errors[0].message}`);
      }

      logger.info("[TEMPLATES] translateFieldToAllLocales: Shopify translations registered", {
        context: "Templates",
        fieldType,
        localeCount: translationInputs.length,
      });

      // Shopify succeeded — now save to local DB
      await db.$transaction(
        pendingUpserts.map(({ locale, value }) =>
          db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale: {
                shop: session.shop,
                resourceId: fieldResId2,
                groupId: groupId,
                key: fieldType,
                locale: locale,
              },
            },
            update: { value: value, updatedAt: new Date() },
            create: {
              shop: session.shop,
              groupId: groupId,
              resourceId: fieldResId2,
              domain: "theme",
              locale: locale,
              key: fieldType,
              value: value,
            },
          })
        )
      );
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: `Translated to ${Object.keys(translations).length} locales`,
      },
    });

    return json({ success: true, translations, fieldType });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}

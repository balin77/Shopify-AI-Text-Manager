import { json } from "@remix-run/node";
import { AIService, toValidProvider } from "../../../src/services/ai.service";
import { tryDecryptApiKey } from "~/utils/encryption.server";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "~/graphql/content.mutations";
import { extractThemeIdFromResourceId } from "~/utils/theme-id";
import type { TemplatesActionContext, TranslatableField } from "./shared";

export async function handleTranslateAll(
  ctx: TemplatesActionContext,
  actionType: "translateAll" | "translateAllForLocale"
): Promise<Response> {
  const { admin, db, session, formData, groupId, domain, firstGroup, themeGroups, resourceId, keyToResourceId } = ctx;
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const targetLocale = getFormString(formData, "targetLocale");
  const targetLocales = targetLocalesJson
    ? safeJsonParse<string[]>(targetLocalesJson, [targetLocale])
    : [targetLocale];

  // Get all translatable content
  const allContent = themeGroups.flatMap(
    (group) => (group.translatableContent as unknown) as TranslatableField[]
  );

  // Deduplicate
  const uniqueContent = new Map<string, TranslatableField>();
  for (const item of allContent) {
    if (!uniqueContent.has(item.key) && item.value) {
      uniqueContent.set(item.key, item);
    }
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: domain,
      resourceId: `group_${groupId}`,
      resourceTitle: firstGroup.groupName,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });

    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 5 },
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

    const primaryLocale = getFormString(formData, "primaryLocale") || "en";

    const translations: Record<string, Record<string, string>> = {};
    const pendingUpserts: Array<{ key: string; locale: string; value: string; resId: string }> = [];

    // Collect every field once; one batched/chunked AI call replaces the old
    // N-fields × M-locales nested translateContent loop.
    const fieldsToTranslate: Record<string, string> = {};
    for (const [key, item] of uniqueContent.entries()) {
      if (item.value) fieldsToTranslate[key] = item.value;
    }

    const batchResult = await aiService.translateFieldsToLocalesChunked(
      fieldsToTranslate,
      primaryLocale,
      targetLocales,
      { preserveHtml: true, contextLabel: "template content" }
    );

    for (const locale of targetLocales) {
      translations[locale] = {};
      for (const key of Object.keys(fieldsToTranslate)) {
        const value = batchResult[locale]?.[key];
        // Missing cell → skip (N-H3: never persist source as a translation).
        if (!value) continue;
        translations[locale][key] = value;
        const fieldResId = keyToResourceId.get(key) || resourceId;
        pendingUpserts.push({ key, locale, value, resId: fieldResId });
      }
    }

    // AI phase done — Shopify persistence (unchanged) finishes the task at 100%.
    await db.task.update({ where: { id: task.id }, data: { progress: 60 } });

    // Save to Shopify FIRST — only persist to local DB on success
    const digestMap = new Map<string, string>();
    for (const item of allContent) {
      if (item.digest) {
        digestMap.set(item.key, item.digest);
      }
    }

    // Group pending upserts by resourceId+locale for batched Shopify calls
    const shopifyBatches = new Map<
      string,
      {
        resId: string;
        locale: string;
        inputs: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }>;
      }
    >();
    const shopifySkippedKeys: string[] = [];

    for (const { key, locale, value, resId } of pendingUpserts) {
      const digest = digestMap.get(key);
      if (!digest) {
        shopifySkippedKeys.push(key);
        continue;
      }
      const batchKey = `${resId}::${locale}`;
      if (!shopifyBatches.has(batchKey)) {
        shopifyBatches.set(batchKey, { resId, locale, inputs: [] });
      }
      shopifyBatches.get(batchKey)!.inputs.push({ key, value, locale, translatableContentDigest: digest });
    }

    if (shopifySkippedKeys.length > 0) {
      logger.warn("[TEMPLATES] translateAll: Skipped keys without digest", {
        context: "Templates",
        count: shopifySkippedKeys.length,
        sampleKeys: shopifySkippedKeys.slice(0, 5),
      });
    }

    const successfulUpserts: Array<{ key: string; locale: string; value: string; resId: string }> = [];
    const failedBatches: string[] = [];

    for (const [, batch] of shopifyBatches) {
      try {
        const response = await admin.graphql(TRANSLATE_CONTENT, {
          variables: { resourceId: batch.resId, translations: batch.inputs },
        });
        const data = await response.json();

        if (data.data?.translationsRegister?.userErrors?.length > 0) {
          const errors = data.data.translationsRegister.userErrors;
          logger.error("[TEMPLATES] translateAll: Shopify rejected translations", {
            context: "Templates",
            errors,
            resourceId: batch.resId,
            locale: batch.locale,
          });
          failedBatches.push(`${batch.resId} (${batch.locale}): ${errors[0].message}`);
        } else {
          logger.info("[TEMPLATES] translateAll: Shopify translations registered", {
            context: "Templates",
            resourceId: batch.resId,
            locale: batch.locale,
            fieldCount: batch.inputs.length,
          });
          for (const input of batch.inputs) {
            const resId = keyToResourceId.get(input.key) || resourceId;
            successfulUpserts.push({ key: input.key, locale: input.locale, value: input.value, resId });
          }
        }
      } catch (shopifyError) {
        const errorMsg = shopifyError instanceof Error ? shopifyError.message : String(shopifyError);
        logger.error("[TEMPLATES] translateAll: translationsRegister failed", {
          context: "Templates",
          error: errorMsg,
          resourceId: batch.resId,
          locale: batch.locale,
        });
        failedBatches.push(`${batch.resId} (${batch.locale}): ${errorMsg}`);
      }
    }

    if (successfulUpserts.length === 0 && pendingUpserts.length > 0) {
      throw new Error(`Shopify rejected all translations: ${failedBatches.join("; ")}`);
    }

    if (successfulUpserts.length > 0) {
      await db.$transaction(
        successfulUpserts.map(({ key, locale, value, resId }) =>
          db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale_themeId: {
                shop: session.shop,
                resourceId: resId,
                groupId: groupId,
                key: key,
                locale: locale,
                themeId: extractThemeIdFromResourceId(resId) ?? "",
              },
            },
            update: { value: value, updatedAt: new Date() },
            create: {
              shop: session.shop,
              groupId: groupId,
              resourceId: resId,
              themeId: extractThemeIdFromResourceId(resId) ?? "",
              domain: domain,
              locale: locale,
              key: key,
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
        result: `Translated ${uniqueContent.size} fields to ${targetLocales.length} locales`,
      },
    });

    if (actionType === "translateAllForLocale") {
      return json({
        success: true,
        actionType: "translateAllForLocale",
        translations: translations[targetLocale] || {},
        targetLocale,
      });
    }

    return json({ success: true, actionType: "translateAll", translations });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    return json({ success: false, error: msg }, { status: 500 });
  }
}

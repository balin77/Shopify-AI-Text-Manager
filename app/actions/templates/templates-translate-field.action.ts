import { data as json } from "react-router";
import { aiRefusalFor, managedRefusalResponseFromError } from "~/utils/ai-refusal-response.server";
import { getTaskExpirationDate } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";
import { extractReadableName } from "~/utils/templates-field-factory";
import { extractThemeIdFromResourceId } from "~/utils/theme-id";
import { registerThemeResourceTranslations } from "~/utils/cookie-banner-availability.server";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { isThemeMediaValue, themeMediaRefusalBody } from "~/utils/theme-image-reference.shared";
import type { TemplatesActionContext, TranslatableField } from "./shared";
import type { DataResponse } from "~/types/data-response";
import { aiServiceFor } from "~/services/ai/ai-credentials.server";

export async function handleTranslateField(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { admin, db, session, formData, groupId, domain, firstGroup, themeGroups, resourceId, keyToResourceId } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
  const translateFieldLabel = extractReadableName(fieldType);

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }
  if (isThemeMediaValue(sourceText)) {
    return json(themeMediaRefusalBody("translateField", fieldType), { status: 400 });
  }

  // Compliance gate: whose key, consent, kill switch and budget — before a
  // Task row exists.
  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  // `actionType` + `fieldType` ride on every refusal and error so the editor's
  // generic handler lands it inside the field that fired it.
  const refusal = await aiRefusalFor(settings, session.shop, { actionType: "translateField", fieldType });
  if (refusal) {
    return refusal;
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: domain,
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

    const aiService = aiServiceFor(settings, session.shop, task.id).service;

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

    // Verified register: userErrors alone prove nothing, Shopify must ECHO the key.
    const verified = await registerThemeResourceTranslations(admin, session, fieldResId, [
      { key: fieldType, value: translatedValue, locale: targetLocale, translatableContentDigest: singleFieldDigest },
    ]);
    if (!verified.confirmedKeys.has(fieldType)) {
      throw new Error(
        verified.userErrors.length > 0
          ? `Shopify rejected translation: ${verified.userErrors[0].message}`
          : "Shopify did not store the translation although it reported no error",
      );
    }
    // What Shopify STORED is what gets mirrored.
    const storedValue = verified.confirmedValues.get(fieldType) ?? translatedValue;
    // Claim the resource the merchant just translated (global layer): a detached
    // theme repair must abandon the rest rather than overwrite this value.
    markTranslationSaved(fieldResId);

    logger.info("[TEMPLATES] translateField: Shopify translation registered", {
      context: "Templates",
      fieldType,
      targetLocale,
    });

    // Shopify succeeded — now save to local DB
    await db.themeTranslation.upsert({
      where: {
        shop_resourceId_groupId_key_locale_themeId_marketId: {
          marketId: "",
          shop: session.shop,
          resourceId: fieldResId,
          groupId: groupId,
          key: fieldType,
          locale: targetLocale,
          themeId: extractThemeIdFromResourceId(fieldResId) ?? "",
        },
      },
      update: { value: storedValue, updatedAt: new Date() },
      create: {
        shop: session.shop,
        groupId: groupId,
        resourceId: fieldResId,
        themeId: extractThemeIdFromResourceId(fieldResId) ?? "",
        domain: domain,
        locale: targetLocale,
        key: fieldType,
        value: storedValue,
      },
    });

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: storedValue.substring(0, 1000),
      },
    });

    return json({ success: true, translatedValue: storedValue, fieldType, targetLocale });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    // A managed-AI refusal thrown mid-run is a coded answer, never a raw 500.
    const refused = managedRefusalResponseFromError(error, settings, { actionType: "translateField", fieldType });
    if (refused) return refused;
    return json({ success: false, error: msg, actionType: "translateField", fieldType }, { status: 500 });
  }
}

export async function handleTranslateFieldToAllLocales(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { admin, db, session, formData, groupId, domain, firstGroup, themeGroups, resourceId, keyToResourceId } = ctx;
  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocaleFromForm = getFormString(formData, "primaryLocale");
  const translateAllFieldLabel = extractReadableName(fieldType);

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }
  if (isThemeMediaValue(sourceText)) {
    return json(themeMediaRefusalBody("translateFieldToAllLocales", fieldType), { status: 400 });
  }

  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target locales specified" }, { status: 400 });
  }

  // Compliance gate: whose key, consent, kill switch and budget — before a
  // Task row exists.
  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  const refusal = await aiRefusalFor(settings, session.shop, { actionType: "translateFieldToAllLocales", fieldType });
  if (refusal) {
    return refusal;
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: domain,
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

    const aiService = aiServiceFor(settings, session.shop, task.id).service;

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

    // One verified register per locale: the echo is matched per (key, locale),
    // and a result set keyed by key alone could not tell two locales apart.
    const confirmedUpserts: Array<{ locale: string; value: string }> = [];
    const failedLocales: string[] = [];
    const failureReasons: string[] = [];
    for (const { locale, value } of pendingUpserts) {
      try {
        const verified = await registerThemeResourceTranslations(admin, session, fieldResId2, [
          { key: fieldType, value, locale, translatableContentDigest: fieldDigest },
        ]);
        if (verified.confirmedKeys.has(fieldType)) {
          confirmedUpserts.push({ locale, value: verified.confirmedValues.get(fieldType) ?? value });
        } else {
          failedLocales.push(locale);
          failureReasons.push(verified.userErrors[0]?.message ?? "not stored by Shopify");
        }
      } catch (registerError) {
        failedLocales.push(locale);
        failureReasons.push(registerError instanceof Error ? registerError.message : String(registerError));
      }
    }

    if (pendingUpserts.length > 0 && confirmedUpserts.length === 0) {
      throw new Error(`Shopify rejected translations: ${failureReasons[0]}`);
    }

    if (confirmedUpserts.length > 0) {
      logger.info("[TEMPLATES] translateFieldToAllLocales: Shopify translations registered", {
        context: "Templates",
        fieldType,
        localeCount: confirmedUpserts.length,
        failedLocales,
      });
      markTranslationSaved(fieldResId2);

      // Only CONFIRMED locales are mirrored, with the value Shopify stored.
      await db.$transaction(
        confirmedUpserts.map(({ locale, value }) =>
          db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale_themeId_marketId: {
                marketId: "",
                shop: session.shop,
                resourceId: fieldResId2,
                groupId: groupId,
                key: fieldType,
                locale: locale,
                themeId: extractThemeIdFromResourceId(fieldResId2) ?? "",
              },
            },
            update: { value: value, updatedAt: new Date() },
            create: {
              shop: session.shop,
              groupId: groupId,
              resourceId: fieldResId2,
              themeId: extractThemeIdFromResourceId(fieldResId2) ?? "",
              domain: domain,
              locale: locale,
              key: fieldType,
              value: value,
            },
          })
        )
      );
    }
    for (const { locale, value } of confirmedUpserts) translations[locale] = value;
    for (const locale of failedLocales) delete translations[locale];

    await db.task.update({
      where: { id: task.id },
      data: {
        status: failedLocales.length > 0 ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: `Translated to ${Object.keys(translations).length} locales`,
        ...(failedLocales.length > 0
          ? { error: `Not stored by Shopify: ${failedLocales.join(", ")}`.substring(0, 1000) }
          : {}),
      },
    });

    return json({
      success: true,
      translations,
      fieldType,
      ...(failedLocales.length > 0 ? { failedLocales } : {}),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    // A managed-AI refusal thrown mid-run is a coded answer, never a raw 500.
    const refused = managedRefusalResponseFromError(error, settings, { actionType: "translateFieldToAllLocales", fieldType });
    if (refused) return refused;
    return json({ success: false, error: msg, actionType: "translateFieldToAllLocales", fieldType }, { status: 500 });
  }
}

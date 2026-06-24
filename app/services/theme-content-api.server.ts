/**
 * Shared server logic for the ThemeContent-backed content APIs.
 *
 * The Templates page and the new System / Online-Store-Extras / Selling-Plans
 * rubrics all persist into the same ThemeContent / ThemeTranslation tables,
 * distinguished by `domain`. Rather than duplicate the ~450-line lazy-load +
 * translate + save route for each rubric, both the legacy `api.templates.$`
 * route (domain="theme") and the generic `api.theme-content.$domain.$` route
 * call into the two helpers below, parameterised by `domain`.
 */

import { json } from "@remix-run/node";
import { AIService, toValidProvider } from "../../src/services/ai.service";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { tryDecryptApiKey } from "../utils/encryption.server";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse } from "~/utils/validation";
import { logger } from "~/utils/logger.server";

/** Domains that share the ThemeContent model. */
export const THEME_CONTENT_DOMAINS = ["theme", "system", "delivery", "online_store_extras", "selling_plans", "cookie_banner"] as const;
export type ThemeContentDomain = (typeof THEME_CONTENT_DOMAINS)[number];

export function isThemeContentDomain(value: string | undefined): value is ThemeContentDomain {
  return !!value && (THEME_CONTENT_DOMAINS as readonly string[]).includes(value);
}

/** Shape of individual items within ThemeContent.translatableContent JSON array */
interface TranslatableField {
  key: string;
  value?: string;
  digest?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
interface SessionLike {
  shop: string;
}

/**
 * Lazy-load one group's deduplicated, paginated translatable content.
 * Returns a Remix Response (json) so the route stays a thin delegate.
 */
export async function loadThemeGroupResponse(opts: {
  db: Db;
  shop: string;
  domain: ThemeContentDomain;
  groupId: string;
  page: number;
  limit: number;
  search: string;
}): Promise<Response> {
  const { db, shop, domain, groupId, page, limit, search } = opts;

  const themeGroups = await db.themeContent.findMany({
    where: { shop, groupId, domain },
  });

  if (themeGroups.length === 0) {
    return json({ success: false, error: "Group not found" }, { status: 404 });
  }

  // Merge translatable content across all resources in this group.
  const allContent = themeGroups.flatMap(
    (group: { translatableContent: unknown }) => group.translatableContent as TranslatableField[]
  );

  // DEDUPLICATION: same key can appear in multiple resources.
  const uniqueContent = new Map<string, TranslatableField>();
  for (const item of allContent) {
    if (!uniqueContent.has(item.key)) uniqueContent.set(item.key, item);
  }
  let deduplicatedContent = Array.from(uniqueContent.values());

  if (search) {
    const searchLower = search.toLowerCase();
    deduplicatedContent = deduplicatedContent.filter(
      (item) =>
        item.key.toLowerCase().includes(searchLower) ||
        (item.value && item.value.toLowerCase().includes(searchLower))
    );
  }

  const totalCount = deduplicatedContent.length;
  const totalPages = Math.ceil(totalCount / limit);
  const startIndex = (page - 1) * limit;
  const paginatedContent = deduplicatedContent.slice(startIndex, startIndex + limit);

  const firstGroup = themeGroups[0];
  const themeData = {
    id: `group_${groupId}`,
    title: firstGroup.groupName,
    name: firstGroup.groupName,
    icon: firstGroup.groupIcon,
    groupId,
    role: "THEME_GROUP",
    translatableContent: paginatedContent,
    contentCount: totalCount,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };

  return json({ theme: themeData }, { headers: { "Cache-Control": "no-store" } });
}

function buildAIService(settings: Record<string, string | null | undefined> | null) {
  return new AIService(toValidProvider(settings?.preferredProvider), {
    huggingfaceApiKey: tryDecryptApiKey(settings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(settings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(settings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(settings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(settings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(settings?.deepseekApiKey, "deepseek") || undefined,
  });
}

/**
 * Handle a content action (loadTranslations / generateAIText / translateField /
 * translateAll / updateContent) for one group within a domain. Returns a Remix
 * Response. Identical behaviour to the legacy api.templates action, now
 * domain-scoped.
 */
export async function handleThemeContentActionResponse(opts: {
  db: Db;
  admin: Admin;
  session: SessionLike;
  formData: FormData;
  domain: ThemeContentDomain;
  groupId: string;
}): Promise<Response> {
  const { db, admin, session, formData, domain, groupId } = opts;
  const actionType = getFormString(formData, "action");

  const themeGroups = await db.themeContent.findMany({
    where: { shop: session.shop, groupId, domain },
  });

  if (themeGroups.length === 0) {
    return json({ success: false, error: "Group not found" }, { status: 404 });
  }

  const firstGroup = themeGroups[0];
  const resourceId = firstGroup.resourceId;

  switch (actionType) {
    case "loadTranslations": {
      const locale = getFormString(formData, "locale");
      const translations = await db.themeTranslation.findMany({
        where: { shop: session.shop, groupId, locale, domain },
      });
      return json({ success: true, translations, locale });
    }

    case "generateAIText": {
      const fieldKey = getFormString(formData, "fieldKey");
      const currentValue = getFormString(formData, "currentValue");
      const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
      const aiService = buildAIService(settings);

      const prompt = `Improve the following template field content.

Field: ${fieldKey}
Current value: ${currentValue}
Context: ${firstGroup.groupName}

IMPORTANT: Return ONLY the improved text, nothing else. No explanations, no options, no formatting, no labels. Just output the single best improved version of the content.`;

      const generatedContent = await aiService["askAI"](prompt);
      return json({ success: true, generatedContent, fieldKey });
    }

    case "translateField": {
      const fieldKey = getFormString(formData, "fieldKey");
      const sourceText = getFormString(formData, "sourceText");
      const targetLocale = getFormString(formData, "targetLocale");
      const primaryLocale = getFormString(formData, "primaryLocale");

      if (!sourceText) {
        return json({ success: false, error: "No source text available" }, { status: 400 });
      }

      const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
      const aiService = buildAIService(settings);
      const translatedValue = await aiService.translateContent(sourceText, primaryLocale, targetLocale);
      return json({ success: true, translatedValue, fieldKey });
    }

    case "translateAll": {
      const primaryLocale = getFormString(formData, "primaryLocale");
      const targetLocale = getFormString(formData, "targetLocale");
      if (!primaryLocale || !targetLocale) {
        return json({ success: false, error: "Missing required field: primaryLocale or targetLocale" }, { status: 400 });
      }

      const allContent = themeGroups.flatMap(
        (group: { translatableContent: unknown }) => group.translatableContent as TranslatableField[]
      );
      const uniqueContent = new Map<string, TranslatableField>();
      for (const item of allContent) {
        if (!uniqueContent.has(item.key)) uniqueContent.set(item.key, item);
      }

      const fieldsToTranslate: Record<string, string> = {};
      for (const item of uniqueContent.values()) {
        if (item.value) fieldsToTranslate[item.key] = item.value;
      }

      const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
      const aiService = buildAIService(settings);

      const batchResult = await aiService.translateFieldsToLocalesChunked(
        fieldsToTranslate,
        primaryLocale,
        [targetLocale],
        { preserveHtml: true, contextLabel: "template content" }
      );

      const translatedFields: Record<string, string> = {};
      for (const key of Object.keys(fieldsToTranslate)) {
        const value = batchResult[targetLocale]?.[key];
        if (value) translatedFields[key] = value;
      }

      return json({ success: true, translatedFields });
    }

    case "updateContent": {
      const locale = getFormString(formData, "locale");
      const primaryLocale = getFormString(formData, "primaryLocale");
      const updatedFieldsJson = getFormString(formData, "updatedFields");
      if (!locale || !primaryLocale || !updatedFieldsJson) {
        return json({ success: false, error: "Missing required field: locale, primaryLocale, or updatedFields" }, { status: 400 });
      }
      const updatedFields = safeJsonParse<Record<string, string>>(updatedFieldsJson, {});

      const changedFieldsStr = getFormString(formData, "changedFields");
      const changedFields = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : [];

      // STEP 1: Register foreign-locale translations with Shopify.
      if (locale !== primaryLocale) {
        const translationInputs = Object.entries(updatedFields).map(([key, value]) => ({
          key,
          value: value as string,
          locale,
          translatableContentDigest: "",
        }));

        if (translationInputs.length > 0) {
          const response = await admin.graphql(TRANSLATE_CONTENT, {
            variables: { resourceId, translations: translationInputs },
          });
          const data = await response.json();
          if (data.data?.translationsRegister?.userErrors?.length > 0) {
            const errors = data.data.translationsRegister.userErrors;
            logger.error("Shopify translation errors", { context: "ThemeContent", domain, errors });
            return json({ success: false, error: `Shopify error: ${errors[0].message}` }, { status: 500 });
          }
        }
      }

      // STEP 2: Local DB.
      if (locale === primaryLocale) {
        for (const group of themeGroups) {
          const content = group.translatableContent as TranslatableField[];
          let hasChanges = false;
          for (const item of content) {
            if (updatedFields[item.key] !== undefined) {
              item.value = updatedFields[item.key];
              hasChanges = true;
            }
          }
          if (hasChanges) {
            await db.themeContent.update({
              where: { shop_resourceId_groupId: { shop: session.shop, resourceId: group.resourceId, groupId } },
              data: { translatableContent: content, lastSyncedAt: new Date() },
            });
          }
        }

        if (changedFields.length > 0) {
          await db.themeTranslation.deleteMany({
            where: { shop: session.shop, groupId, key: { in: changedFields }, domain },
          });
        }
        return json({ success: true });
      } else {
        for (const [key, value] of Object.entries(updatedFields)) {
          await db.themeTranslation.upsert({
            where: {
              shop_resourceId_groupId_key_locale: {
                shop: session.shop,
                resourceId,
                groupId,
                key,
                locale,
              },
            },
            update: { value: value as string, updatedAt: new Date() },
            create: { shop: session.shop, groupId, resourceId, domain, locale, key, value: value as string },
          });
        }
        return json({ success: true });
      }
    }

    default:
      return json({ success: false, error: "Unknown action" }, { status: 400 });
  }
}

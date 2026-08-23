import { data as json } from "react-router";
import type { AIActionContext, TranslatableContentItem, ShopifyGraphQLResponse } from "./shared";
import { errorMessage, errorStack, createAIService, isAuthError } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse, isValidLocale } from "~/utils/validation";
import { sanitizeSlug } from "~/utils/slug.utils";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { extractReadableName } from "~/utils/templates-field-factory";
import { extractThemeIdFromResourceId } from "~/utils/theme-id";
import { resolveSelectedThemeId } from "~/services/theme-selection.server";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";
import { parseMetaobjectFieldKey } from "~/services/metaobject-fields.shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../../graphql/content.mutations";
import { GroupedFieldTranslationService } from "../../../src/services/grouped-field-translation.service";
import { isGroupedFieldKey } from "~/utils/grouped-field.utils";
import { writeCookieBannerTranslations } from "~/utils/cookie-banner-availability.server";
import type { DataResponse } from "~/types/data-response";

/**
 * COOKIE_BANNER translatable resources are rejected by the pinned stable
 * `translationsRegister` with "invalid id" — they can only be written through
 * Shopify's `unstable` endpoint (see app.cookie-banner.tsx and
 * cookie-banner-availability.server.ts). Cookie-Banner is normalised into the
 * `templates` content-type family in api.ai.tsx, so its AI translations flow
 * through the two `contentType === 'templates'` send sites below. Without this
 * prefix check those sites push the CookieBanner GID at the stable endpoint and
 * every locale throws "invalid id". The manual save path already routes here.
 */
const COOKIE_BANNER_GID_PREFIX = "gid://shopify/CookieBanner/";

/**
 * Register one foreign-locale translation for a theme-content ("templates")
 * field. Routes COOKIE_BANNER resources to the `unstable` endpoint (via
 * writeCookieBannerTranslations, which never throws) and everything else to the
 * normal pinned-stable `admin.graphql` mutation (which throws on transport
 * errors, preserving the existing caller catch behaviour). Returns a normalised
 * accepted/error result so both send sites can share identical handling.
 */
async function registerTemplateFieldTranslation(params: {
  admin: AIActionContext["admin"];
  session: AIActionContext["session"];
  resourceId: string;
  key: string;
  value: string;
  locale: string;
  digest: string;
}): Promise<{ accepted: boolean; error?: string }> {
  const { admin, session, resourceId, key, value, locale, digest } = params;
  const input = [{ key, value, locale, translatableContentDigest: digest }];

  if (resourceId.startsWith(COOKIE_BANNER_GID_PREFIX)) {
    const res = await writeCookieBannerTranslations(
      { shop: session.shop, accessToken: session.accessToken },
      resourceId,
      [{ key, value, translatableContentDigest: digest, locale }]
    );
    return { accepted: res.ok, error: res.error };
  }

  const response = await admin.graphql(TRANSLATE_CONTENT, {
    variables: { resourceId, translations: input },
  });
  const data = (await response.json()) as ShopifyGraphQLResponse;
  if (data.errors && data.errors.length > 0) {
    return { accepted: false, error: JSON.stringify(data.errors) };
  }
  const userErrors = data.data?.translationsRegister?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { accepted: false, error: JSON.stringify(userErrors) };
  }
  return { accepted: true };
}

export async function handleTranslateField(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, formData, settings, contentType, itemId } = ctx;

  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocale = getFormString(formData, "targetLocale");
  const primaryLocale = getFormString(formData, "primaryLocale");

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }

  if (!isValidLocale(targetLocale)) {
    return json({ success: false, error: `Invalid target locale: ${targetLocale}` }, { status: 400 });
  }

  // Check if this is a URL slug/handle field
  const isSlugField = fieldType === 'handle' || fieldType === 'slug';

  // Create task entry (prompt is saved by AI service via savePromptToTask)
  const taskFieldLabel = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "translation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: taskFieldLabel,
      fieldType: taskFieldLabel,
      targetLocale,
      progress: 0,
      // prompt is saved by AI service via savePromptToTask
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 20 },
    });

    const aiService = createAIService(settings, session.shop, task.id);

    logger.debug("[API-AI] Translating field", {
      context: "AI",
      fieldType,
      from: primaryLocale,
      to: targetLocale,
      textLength: sourceText.length
    });

    // For grouped fields (productType) on products: check the shop-wide mapping first.
    const isGroupedProductsField =
      contentType === 'products' && isGroupedFieldKey(fieldType);
    const groupedService = isGroupedProductsField
      ? new GroupedFieldTranslationService(db)
      : null;
    let groupedHitValue: string | null = null;
    if (groupedService) {
      const lookupResult = await groupedService.lookup({
        shop: session.shop,
        fieldKey: fieldType,
        sourceLocale: primaryLocale,
        sourceValue: sourceText,
        targetLocales: [targetLocale],
      });
      if (lookupResult.hits[targetLocale]) {
        groupedHitValue = lookupResult.hits[targetLocale];
        logger.info("[API-AI] Grouped-field cache hit (single)", {
          context: "AI",
          fieldType,
          targetLocale,
        });
      }
    }

    // Use special method for URL slugs
    let translatedValue: string;
    if (groupedHitValue !== null) {
      translatedValue = groupedHitValue;
    } else if (isSlugField) {
      translatedValue = await aiService.translateSlug(sourceText, primaryLocale, targetLocale);
    } else {
      translatedValue = await aiService.translateContent(sourceText, primaryLocale, targetLocale);
    }

    // Persist the new grouped-field translation (only if it was freshly produced).
    if (groupedService && groupedHitValue === null && translatedValue) {
      try {
        await groupedService.upsertMany({
          shop: session.shop,
          fieldKey: fieldType,
          sourceLocale: primaryLocale,
          sourceValue: sourceText,
          entries: { [targetLocale]: translatedValue },
          source: "ai",
        });
      } catch (gErr) {
        logger.error("[API-AI] Failed to persist grouped-field translation (single)", {
          context: "AI",
          error: errorMessage(gErr),
          fieldType,
        });
      }
    }

    // For URL slugs: ensure the result is a valid slug (post-process as safety net)
    if (isSlugField) {
      const originalValue = translatedValue;
      translatedValue = sanitizeSlug(translatedValue);
      logger.debug("[API-AI] Sanitized slug translation", {
        context: "AI",
        original: originalValue,
        sanitized: translatedValue
      });

      // R5-H3: sanitizeSlug strips non-Latin chars; a CJK/Cyrillic/Arabic
      // handle can collapse to '' (or hyphens-only -> ''). Writing an empty
      // handle to Shopify produces a broken/404 URL + SEO loss. Fail loudly:
      // never persist an unusable handle (mirrors the !batchValue guard,
      // moved to AFTER sanitization).
      if (!translatedValue || !translatedValue.replace(/-/g, '').trim()) {
        logger.warn("[API-AI] Slug collapsed to empty after sanitization — rejecting (not writing broken handle)", {
          context: "AI",
          fieldType,
          targetLocale,
          original: originalValue,
        });
        await db.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            // A machine code for the Tasks card (`taskErrorText`); the HTTP
            // body below stays an English message for our own client.
            error: `slug_empty:${targetLocale}`,
          },
        });
        return json(
          {
            success: false,
            error: `Translated handle is empty/unusable after sanitization for locale ${targetLocale}`,
            fieldType,
            targetLocale,
          },
          { status: 422 },
        );
      }
    }

    // Update task to completed with full AI response
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: translatedValue, // Store full AI response
      },
    });

    return json({
      success: true,
      translatedValue,
      fieldType,
      targetLocale
    });
  } catch (error: unknown) {
    // Update task to failed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

export async function handleTranslateFieldToAllLocales(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, formData, settings, contentType, itemId } = ctx;

  const fieldType = getFormString(formData, "fieldType");
  const sourceText = getFormString(formData, "sourceText");
  const targetLocalesJson = getFormString(formData, "targetLocales");
  const primaryLocale = getFormString(formData, "primaryLocale");

  if (!sourceText) {
    return json({ success: false, error: "No source text available" }, { status: 400 });
  }

  const targetLocales = targetLocalesJson ? safeJsonParse<string[]>(targetLocalesJson, []) : [];
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target locales specified" }, { status: 400 });
  }

  // Locales that should be TRANSLATED (and returned) but NOT persisted here.
  // Used by foreign-locale "Accept & Translate": the shop's primary locale is
  // included as a target so the batch AI call also produces the primary-language
  // value, but the primary base content is saved by the client (via updateContent),
  // not registered as a foreign translation. Empty for all normal flows.
  const skipSaveLocalesJson = getFormString(formData, "skipSaveLocales");
  const skipSaveLocales = new Set(
    skipSaveLocalesJson ? safeJsonParse<string[]>(skipSaveLocalesJson, []) : []
  );

  const MAX_TARGET_LOCALES = 50;
  if (targetLocales.length > MAX_TARGET_LOCALES) {
    return json(
      { success: false, error: `Too many target locales (max ${MAX_TARGET_LOCALES}, got ${targetLocales.length})` },
      { status: 413 },
    );
  }

  const invalidLocales = targetLocales.filter((l) => !isValidLocale(l));
  if (invalidLocales.length > 0) {
    return json(
      { success: false, error: `Invalid target locale(s): ${invalidLocales.join(", ")}` },
      { status: 400 },
    );
  }

  // Check if this is a URL slug/handle field
  const isSlugField = fieldType === 'handle' || fieldType === 'slug';

  // Check if this is a short field that can use batch translation
  const SHORT_FIELDS = ['handle', 'slug', 'title', 'seoTitle', 'productType'];
  const isShortField = SHORT_FIELDS.includes(fieldType);

  // Create task entry (prompts will be saved by AI service via savePromptToTask)
  const taskFieldLabel2 = contentType === 'templates' ? extractReadableName(fieldType) : fieldType;
  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: contentType,
      resourceId: itemId,
      resourceTitle: taskFieldLabel2,
      fieldType: taskFieldLabel2,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 10 },
    });

    const aiService = createAIService(settings, session.shop, task.id);

    logger.debug("[API-AI] Translating field to all locales", {
      context: "AI",
      fieldType,
      from: primaryLocale,
      to: targetLocales,
      textLength: sourceText.length,
      useBatch: isShortField
    });

    const translations: Record<string, string> = {};
    const aiResponses: Array<{ locale: string; response: string }> = [];
    const rejectedFields: Record<string, string[]> = {};
    const totalLocales = targetLocales.length;

    // For templates: Load ALL themeContent rows for the group to map keys to correct resource IDs.
    // A template group can span multiple Shopify resources (e.g. a JSON template + metaobjects),
    // so each field key must be saved against its own resource ID.
    let templateGroupId: string | null = null;
    let templateResourceId: string | null = null;
    // The ThemeContent domain that owns this group (theme / system / delivery /
    // online_store_extras / selling_plans / customer_privacy). MUST be mirrored
    // onto every themeTranslation row we write — the Prisma default is "theme",
    // so persisting without it saves flat-domain translations (e.g. Abo-Gruppe)
    // under the wrong domain. That both hides them from the domain-scoped loader
    // AND makes the next reload collide (the @@unique omits domain, so a
    // re-create under the correct domain violates the constraint).
    let templateDomain = "theme";
    const templateKeyToResourceId = new Map<string, string>();
    if (contentType === 'templates' && itemId) {
      templateGroupId = itemId.replace("group_", "");
      // Theme-Auswahl: scope to the selected theme so key→resourceId mapping uses
      // the chosen theme's resources (legacy/flat rows with themeId "" stay in).
      const selectedThemeId = await resolveSelectedThemeId(session.shop, admin);
      const themeContentRows = await db.themeContent.findMany({
        where: {
          shop: session.shop,
          groupId: templateGroupId,
          ...(selectedThemeId ? { OR: [{ themeId: selectedThemeId }, { themeId: "" }] } : {}),
        }
      });
      if (themeContentRows.length > 0) {
        templateResourceId = themeContentRows[0].resourceId;
        templateDomain = themeContentRows[0].domain;
        // Build key → resourceId map from all rows
        for (const row of themeContentRows) {
          const items = (row.translatableContent as unknown) as Array<{ key: string; value?: string; digest?: string }>;
          if (Array.isArray(items)) {
            for (const item of items) {
              templateKeyToResourceId.set(item.key, row.resourceId);
            }
          }
        }
        logger.info("[API-AI] Found themeContent for templates", {
          context: "AI",
          groupId: templateGroupId,
          resourceCount: themeContentRows.length,
          keyCount: templateKeyToResourceId.size,
          defaultResourceId: templateResourceId
        });
      } else {
        logger.error("[API-AI] No themeContent found - translations will NOT be saved!", {
          context: "AI",
          groupId: templateGroupId,
          shop: session.shop
        });
      }
    }

    // Digest cache: fetches translatableContent once per resourceId instead of once per locale
    const digestCache = new Map<string, Map<string, string>>();
    const getCachedDigest = async (resId: string, key: string): Promise<string> => {
      if (!digestCache.has(resId)) {
        const digestResponse = await admin.graphql(`
          query getTranslatableContent($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              resourceId
              translatableContent {
                key
                digest
              }
            }
          }
        `, { variables: { resourceId: resId } });
        const digestData = await digestResponse.json();
        const translatableContent = digestData.data?.translatableResource?.translatableContent || [];
        const map = new Map<string, string>();
        for (const c of translatableContent as TranslatableContentItem[]) {
          if (c.digest) map.set(c.key, c.digest);
        }
        digestCache.set(resId, map);
      }
      return digestCache.get(resId)!.get(key) || "";
    };

    // Use batch translation for short fields (1 AI request for all locales)
    if (isShortField) {
      logger.info("[API-AI] Using BATCH translation for short field", {
        context: "AI",
        fieldType,
        targetLocales,
        isSlugField
      });

      try {
        let batchResults: Record<string, string>;

        // For grouped fields (productType), consult the shop-wide mapping first to keep
        // category labels consistent across all products that share a source value.
        const isGroupedProductsField =
          contentType === 'products' && isGroupedFieldKey(fieldType);
        const groupedService = isGroupedProductsField
          ? new GroupedFieldTranslationService(db)
          : null;
        let groupedHits: Record<string, string> = {};
        let localesToTranslate = targetLocales;

        if (groupedService) {
          const lookupResult = await groupedService.lookup({
            shop: session.shop,
            fieldKey: fieldType,
            sourceLocale: primaryLocale,
            sourceValue: sourceText,
            targetLocales,
          });
          groupedHits = lookupResult.hits;
          localesToTranslate = lookupResult.misses;
          if (Object.keys(groupedHits).length > 0) {
            logger.info("[API-AI] Grouped-field cache hits", {
              context: "AI",
              fieldType,
              hits: Object.keys(groupedHits),
              missing: localesToTranslate,
            });
          }
        }

        if (isSlugField) {
          // Use batch slug translation
          batchResults = await aiService.translateSlugBatch(sourceText, primaryLocale, targetLocales);
        } else if (localesToTranslate.length === 0) {
          // All locales served from grouped-field cache, no AI call needed
          batchResults = { ...groupedHits };
        } else {
          // Use batch short field translation (title, seoTitle, productType-misses)
          const fieldsToTranslate = { [fieldType]: sourceText };
          const batchFieldResults = await aiService.translateShortFieldsBatch(fieldsToTranslate, primaryLocale, localesToTranslate, contentType);
          // Extract just the single field from each locale
          batchResults = { ...groupedHits };
          for (const locale of localesToTranslate) {
            if (batchFieldResults[locale] && batchFieldResults[locale][fieldType]) {
              batchResults[locale] = batchFieldResults[locale][fieldType];
            }
          }
        }

        // Persist newly translated grouped-field values for future reuse.
        if (groupedService && localesToTranslate.length > 0) {
          const newEntries: Record<string, string> = {};
          for (const locale of localesToTranslate) {
            if (batchResults[locale]) {
              newEntries[locale] = batchResults[locale];
            }
          }
          if (Object.keys(newEntries).length > 0) {
            try {
              await groupedService.upsertMany({
                shop: session.shop,
                fieldKey: fieldType,
                sourceLocale: primaryLocale,
                sourceValue: sourceText,
                entries: newEntries,
                source: "ai",
              });
            } catch (gErr) {
              logger.error("[API-AI] Failed to persist grouped-field translations", {
                context: "AI",
                error: errorMessage(gErr),
                fieldType,
              });
            }
          }
        }

        // Process batch results and save to Shopify
        for (let i = 0; i < targetLocales.length; i++) {
          const locale = targetLocales[i];

          // R3-H10 / N-H3: a missing/empty batch result means this locale was
          // NOT translated (model dropped it, parse failure, etc.).
          // Substituting `sourceText` here would write the untranslated
          // source to Shopify + DB as if it were a real translation — the
          // exact silent-corruption class as N-H3. Skip the locale and
          // surface it as rejected, consistent with the digest/userError
          // failure branches below; never persist source-as-translation.
          const batchValue = batchResults[locale];
          if (!batchValue || !batchValue.trim()) {
            logger.warn("[API-AI] Batch: no translation returned for locale — skipping (not writing source)", {
              context: "AI",
              locale,
              fieldType,
            });
            if (!rejectedFields[locale]) rejectedFields[locale] = [];
            rejectedFields[locale].push(fieldType);
            continue;
          }
          let translatedValue = batchValue;

          // For URL slugs: ensure the result is a valid slug (post-process as safety net)
          if (isSlugField) {
            const originalValue = translatedValue;
            translatedValue = sanitizeSlug(translatedValue);
            logger.debug("[API-AI] Sanitized batch slug translation", {
              context: "AI",
              locale,
              original: originalValue,
              sanitized: translatedValue
            });

            // R5-H3: an empty (or hyphens-only) sanitized handle is unusable
            // and would produce a broken/404 storefront URL. Reject this
            // locale and skip — same fail-loudly contract as the !batchValue
            // guard above, but applied AFTER sanitization.
            if (!translatedValue || !translatedValue.replace(/-/g, '').trim()) {
              logger.warn("[API-AI] Batch: slug collapsed to empty after sanitization — skipping (not writing broken handle)", {
                context: "AI",
                locale,
                fieldType,
                original: originalValue,
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
              continue;
            }
          }

          translations[locale] = translatedValue;
          const isCacheHit = locale in groupedHits;
          aiResponses.push({
            locale,
            response: isCacheHit ? `${translatedValue} (cache)` : translatedValue,
          });

          // Translate-and-return only (e.g. primary locale for the client to save
          // as base content) — skip Shopify + DB persistence for this locale.
          if (skipSaveLocales.has(locale)) continue;

          // Save to Shopify for templates
          if (contentType === 'templates' && templateGroupId) {
            // Use the correct resourceId for this specific field key
            const fieldResourceId = templateKeyToResourceId.get(fieldType) || templateResourceId;
            let batchShopifyAccepted = false;

            if (!fieldResourceId) {
              logger.error("[API-AI] Batch: No resourceId found for template field", {
                context: "AI",
                fieldType,
                locale
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            } else {
            try {
              const digest = await getCachedDigest(fieldResourceId, fieldType);

              if (!digest) {
                logger.warn("[API-AI] Batch: No digest for template field — skipping Shopify save", {
                  context: "AI",
                  fieldType,
                  locale,
                  resourceId: fieldResourceId,
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
              const result = await registerTemplateFieldTranslation({
                admin,
                session,
                resourceId: fieldResourceId,
                key: fieldType,
                value: translatedValue,
                locale,
                digest,
              });

              if (!result.accepted) {
                logger.error("[API-AI] Batch: Shopify rejected template translation", {
                  context: "AI",
                  error: result.error,
                  locale,
                  fieldType,
                  resourceId: fieldResourceId
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
                batchShopifyAccepted = true;
              }
              } // end if digest
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Batch: Error saving template to Shopify", {
                context: "AI",
                error: errorMessage(shopifyError),
                locale,
                fieldType
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            }
            } // end if fieldResourceId

            // Only save to local DB when Shopify accepted
            if (batchShopifyAccepted && fieldResourceId) {
              try {
                await db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale_themeId_marketId: {
                      marketId: "",
                      shop: session.shop,
                      resourceId: fieldResourceId,
                      groupId: templateGroupId,
                      key: fieldType,
                      locale: locale,
                      themeId: extractThemeIdFromResourceId(fieldResourceId) ?? ""
                    }
                  },
                  update: {
                    // Heal the domain too: a row written before this fix (or by a
                    // path that omitted domain) may sit under the default "theme".
                    domain: templateDomain,
                    value: translatedValue,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: templateGroupId,
                    domain: templateDomain,
                    resourceId: fieldResourceId,
                    themeId: extractThemeIdFromResourceId(fieldResourceId) ?? "",
                    locale: locale,
                    key: fieldType,
                    value: translatedValue
                  }
                });
                logger.debug("[API-AI] Batch: Saved template translation", {
                  context: "AI",
                  locale,
                  fieldType,
                  resourceId: fieldResourceId
                });
              } catch (dbError: unknown) {
                logger.error("[API-AI] Batch: Error saving to DB", {
                  context: "AI",
                  error: errorMessage(dbError),
                  locale,
                  fieldType
                });
              }
            }
          }
          // Save to Shopify for products, collections, pages, etc.
          else if (itemId && (contentType === 'products' || contentType === 'collections' || contentType === 'pages' || contentType === 'blogs' || contentType === 'policies')) {
            const fieldKeyMap: Record<string, string> = {
              title: "title",
              description: "body_html",
              body: contentType === 'policies' ? "body" : "body_html",
              handle: "handle",
              seoTitle: "meta_title",
              metaDescription: "meta_description",
              productType: "product_type",
              summary: "summary_html",
            };
            const shopifyKey = fieldKeyMap[fieldType] || fieldType;

            try {
              const digest = await getCachedDigest(itemId, shopifyKey);

              // R5-C2: getCachedDigest returns "" on a cache miss / key-name
              // mismatch (metaDescription↔meta_description etc.) / transient
              // empty GraphQL response. Shopify's translationsRegister
              // SILENTLY no-ops on an empty digest, but the local
              // contentTranslation upsert below would still run — making the
              // UI claim "translated" while the storefront stays in the
              // source language (stale-digest divergence). Fail loudly:
              // skip Shopify + skip the local upsert, mark rejected. Mirrors
              // the templates branch `if (!digest)` guard for uniformity.
              if (!digest) {
                logger.warn("[API-AI] Batch: No digest for content field — skipping Shopify save AND local upsert", {
                  context: "AI",
                  fieldType,
                  shopifyKey,
                  locale,
                  resourceId: itemId,
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                // Update progress and move on, consistent with other skips.
                const skipProgress = Math.round(10 + ((i + 1) / targetLocales.length) * 80);
                await db.task.update({
                  where: { id: task.id },
                  data: { progress: skipProgress },
                });
                continue;
              }

              const translationInput = [{
                key: shopifyKey,
                value: translatedValue,
                locale: locale,
                translatableContentDigest: digest
              }];

              const shopifyResponse = await admin.graphql(TRANSLATE_CONTENT, {
                variables: {
                  resourceId: itemId,
                  translations: translationInput
                }
              });

              const shopifyData = await shopifyResponse.json() as ShopifyGraphQLResponse;
              let shopifyRejected = false;

              if (shopifyData.errors && shopifyData.errors.length > 0) {
                logger.error("[API-AI] Batch: GraphQL error saving translation", {
                  context: "AI",
                  errors: shopifyData.errors,
                  locale,
                  shopifyKey
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                shopifyRejected = true;
              } else if ((shopifyData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                logger.error("[API-AI] Batch: Shopify rejected translation", {
                  context: "AI",
                  errors: shopifyData.data?.translationsRegister?.userErrors,
                  locale,
                  shopifyKey
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                shopifyRejected = true;
              }

              if (!shopifyRejected) {
                // Only save to local DB when Shopify actually accepted
                const resourceTypeMap: Record<string, string> = {
                  products: "Product", collections: "Collection",
                  pages: "Page", blogs: "Article", policies: "ShopPolicy",
                };
                await db.contentTranslation.upsert({
                  where: {
                    shop_resourceId_key_locale_marketId: {
                      marketId: "",
                      shop: session.shop,
                      resourceId: itemId,
                      key: shopifyKey,
                      locale,
                    },
                  },
                  update: { value: translatedValue, digest, resourceType: resourceTypeMap[contentType] || "Product" },
                  create: {
                    shop: session.shop,
                    resourceId: itemId,
                    resourceType: resourceTypeMap[contentType] || "Product",
                    key: shopifyKey,
                    value: translatedValue,
                    locale,
                    digest,
                  },
                });

                logger.debug("[API-AI] Batch: Saved translation to Shopify + DB", {
                  context: "AI",
                  resourceId: itemId,
                  fieldType,
                  shopifyKey,
                  locale
                });
              }
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Batch: Error sending to Shopify", {
                context: "AI",
                error: errorMessage(shopifyError),
                locale,
                fieldType
              });
            }
          }
          // Save to Shopify for metaobjects.
          // `fieldType` is the editor's compound key `<Metaobject GID>#<field
          // key>` (PLAN_METAOBJECTS_EDITOR §6.1). It used to be the bare entry
          // GID, which is why this branch hunted for "the label field": there
          // was no other field the key could have named. Now it names one.
          else if (contentType === 'metaobjects' && fieldType) {
            const parsedMetaKey = parseMetaobjectFieldKey(fieldType);
            const metaobjectGid = parsedMetaKey?.metaobjectId ?? '';
            let batchMetaAccepted = false;
            let metaLabelKey = parsedMetaKey?.fieldKey ?? '';

            try {
              // Populate the digest cache for this entry.
              await getCachedDigest(metaobjectGid, metaLabelKey || 'display_name');
              const metaDigests = metaobjectGid ? digestCache.get(metaobjectGid) : undefined;

              // A key with no digest has no PRIMARY value, so there is nothing
              // to translate — reported, never guessed around by falling back
              // to a different field.
              if (!metaLabelKey || !metaDigests?.has(metaLabelKey)) {
                logger.warn("[API-AI] Batch: No digest for this metaobject field", {
                  context: "AI",
                  fieldKey: fieldType,
                  metaobjectGid,
                  locale,
                  availableKeys: metaDigests ? Array.from(metaDigests.keys()) : []
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
                const digest = metaDigests!.get(metaLabelKey)!;

                const translationInput = [{
                  key: metaLabelKey,
                  value: translatedValue,
                  locale: locale,
                  translatableContentDigest: digest
                }];

                const metaResponse = await admin.graphql(TRANSLATE_CONTENT, {
                  variables: {
                    resourceId: metaobjectGid,
                    translations: translationInput
                  }
                });

                const metaData = await metaResponse.json() as ShopifyGraphQLResponse;

                if (metaData.errors && metaData.errors.length > 0) {
                  logger.error("[API-AI] Batch: GraphQL error saving metaobject translation", {
                    context: "AI",
                    errors: metaData.errors,
                    locale,
                    metaobjectGid,
                    metaLabelKey
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                } else if ((metaData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                  logger.error("[API-AI] Batch: Shopify rejected metaobject translation", {
                    context: "AI",
                    errors: metaData.data?.translationsRegister?.userErrors,
                    locale,
                    metaobjectGid,
                    metaLabelKey
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                } else {
                  batchMetaAccepted = true;
                }
              }
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Batch: Error saving metaobject translation", {
                context: "AI",
                error: errorMessage(shopifyError),
                locale,
                metaobjectGid
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            }

            if (batchMetaAccepted && metaLabelKey) {
              try {
                const metaType = itemId.replace('metaobject_type_', '');
                await db.metaobjectTranslation.upsert({
                  where: {
                    shop_metaobjectId_key_locale_marketId: {
                      marketId: "",
                      shop: session.shop,
                      metaobjectId: metaobjectGid,
                      key: metaLabelKey,
                      locale
                    }
                  },
                  create: {
                    shop: session.shop,
                    metaobjectId: metaobjectGid,
                    type: metaType,
                    key: metaLabelKey,
                    value: translatedValue,
                    locale,
                    outdated: false
                  },
                  update: {
                    value: translatedValue,
                    outdated: false,
                    updatedAt: new Date()
                  }
                });
                logger.debug("[API-AI] Batch: Saved metaobject translation to Shopify + DB", {
                  context: "AI",
                  metaobjectGid,
                  metaLabelKey,
                  locale
                });
              } catch (dbError: unknown) {
                logger.error("[API-AI] Batch: Error saving metaobject translation to DB", {
                  context: "AI",
                  error: errorMessage(dbError),
                  metaobjectGid,
                  locale
                });
              }
            }
          }

          // Update progress
          const progress = Math.round(10 + ((i + 1) / targetLocales.length) * 80);
          await db.task.update({
            where: { id: task.id },
            data: { progress },
          });
        }

        // Progress already updated in loop above

      } catch (batchError: unknown) {
        // An invalid API key will fail the sequential fallback too — don't mask
        // it as a fallback, surface it so the whole request fails loudly.
        if (isAuthError(batchError)) throw batchError;
        logger.error("[API-AI] Batch translation failed, falling back to sequential", {
          context: "AI",
          error: errorMessage(batchError),
          fieldType
        });
        // Fall through to sequential processing below
      }
    }

    // Sequential translation for long fields OR if batch failed
    if (!isShortField || Object.keys(translations).length === 0) {
      // Long, non-slug fields: fetch ALL locales in one batched/chunked AI call
      // up front, then read each locale's value inside the loop below — the
      // per-locale Shopify/DB persistence stays untouched. Slug fields keep
      // their dedicated translateSlug path (see Phase 3.2 / translateSlugBatch).
      let batchTranslations: Record<string, Record<string, string>> = {};
      let batchTranslationFailed = false;
      if (!isSlugField) {
        try {
          batchTranslations = await aiService.translateFieldsToLocalesChunked(
            { [fieldType]: sourceText },
            primaryLocale,
            targetLocales,
            { preserveHtml: true, contextLabel: contentType }
          );
        } catch (batchErr: unknown) {
          // An invalid API key will fail every per-locale fallback too — surface
          // it instead of silently degrading to a doomed sequential pass.
          if (isAuthError(batchErr)) throw batchErr;
          // Whole batch failed (all chunks broke) — fall back to the original
          // per-locale translateContent path below for every locale.
          batchTranslationFailed = true;
          logger.error("[API-AI] Long-field batch translation failed, falling back to sequential translateContent", {
            context: "AI",
            error: errorMessage(batchErr),
            fieldType,
          });
        }
      }

      for (let i = 0; i < targetLocales.length; i++) {
        const locale = targetLocales[i];
        try {
          // Use special method for URL slugs; otherwise prefer the prefetched
          // batch value and only fall back to a per-locale call on total failure.
          let translatedValue: string;
          if (isSlugField) {
            translatedValue = await aiService.translateSlug(sourceText, primaryLocale, locale);
          } else {
            const batched = batchTranslations[locale]?.[fieldType];
            if (batched) {
              translatedValue = batched;
            } else if (batchTranslationFailed) {
              translatedValue = await aiService.translateContent(sourceText, primaryLocale, locale);
            } else {
              // Batch succeeded overall but this locale's cell is missing →
              // reject the locale (N-H3: never persist source-as-translation).
              logger.warn("[API-AI] Locale missing from batch translation — skipping (not writing source)", {
                context: "AI",
                fieldType,
                locale,
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
              aiResponses.push({ locale, response: `REJECTED: missing from batch translation` });
              continue;
            }
          }

          // For URL slugs: ensure the result is a valid slug (post-process as safety net)
          if (isSlugField) {
            const originalValue = translatedValue;
            translatedValue = sanitizeSlug(translatedValue);
            logger.debug("[API-AI] Sanitized slug translation", {
              context: "AI",
              locale,
              original: originalValue,
              sanitized: translatedValue
            });

            // R5-H3: empty/hyphens-only sanitized handle is unusable (broken
            // 404 URL + SEO loss). Reject this locale and skip rather than
            // persisting a broken handle — fail loudly, same contract as the
            // batch path and the !batchValue guard.
            if (!translatedValue || !translatedValue.replace(/-/g, '').trim()) {
              logger.warn("[API-AI] Slug collapsed to empty after sanitization — skipping locale (not writing broken handle)", {
                context: "AI",
                locale,
                fieldType,
                original: originalValue,
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
              aiResponses.push({ locale, response: `REJECTED: handle empty after sanitization` });
              continue;
            }
          }

          translations[locale] = translatedValue;
          aiResponses.push({ locale, response: translatedValue });

          // Translate-and-return only (e.g. primary locale for the client to save
          // as base content) — skip Shopify + DB persistence for this locale.
          if (skipSaveLocales.has(locale)) continue;

          // For templates: Send to Shopify AND save to database
          if (contentType === 'templates' && templateGroupId) {
            // Use the correct resourceId for this specific field key
            const fieldResourceId = templateKeyToResourceId.get(fieldType) || templateResourceId;
            let seqShopifyAccepted = false;

            if (!fieldResourceId) {
              logger.error("[API-AI] No resourceId found for template field", {
                context: "AI",
                fieldType,
                locale
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            } else {
            try {
              const digest = await getCachedDigest(fieldResourceId, fieldType);

              if (!digest) {
                logger.warn("[API-AI] No digest for template field — skipping Shopify save", {
                  context: "AI",
                  fieldType,
                  locale,
                  resourceId: fieldResourceId,
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
              const result = await registerTemplateFieldTranslation({
                admin,
                session,
                resourceId: fieldResourceId,
                key: fieldType,
                value: translatedValue,
                locale,
                digest,
              });

              if (!result.accepted) {
                logger.error("[API-AI] Shopify rejected translation", {
                  context: "AI",
                  error: result.error,
                  locale,
                  fieldType,
                  resourceId: fieldResourceId
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
                seqShopifyAccepted = true;
                logger.info("[API-AI] SUCCESS - Translation saved to Shopify", {
                  context: "AI",
                  resourceId: fieldResourceId,
                  fieldType,
                  locale
                });
              }
              } // end if digest
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Exception sending to Shopify", {
                context: "AI",
                error: errorMessage(shopifyError),
                stack: errorStack(shopifyError)?.substring(0, 500),
                locale,
                fieldType,
                resourceId: fieldResourceId
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            }
            } // end if fieldResourceId

            // Only save to local DB when Shopify accepted
            if (seqShopifyAccepted && fieldResourceId) {
              try {
                await db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale_themeId_marketId: {
                      marketId: "",
                      shop: session.shop,
                      resourceId: fieldResourceId,
                      groupId: templateGroupId,
                      key: fieldType,
                      locale: locale,
                      themeId: extractThemeIdFromResourceId(fieldResourceId) ?? ""
                    }
                  },
                  update: {
                    // Heal the domain too: a row written before this fix (or by a
                    // path that omitted domain) may sit under the default "theme".
                    domain: templateDomain,
                    value: translatedValue,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: templateGroupId,
                    domain: templateDomain,
                    resourceId: fieldResourceId,
                    themeId: extractThemeIdFromResourceId(fieldResourceId) ?? "",
                    locale: locale,
                    key: fieldType,
                    value: translatedValue
                  }
                });
                logger.info("[API-AI] Saved template translation to DB", {
                  context: "AI",
                  groupId: templateGroupId,
                  fieldType,
                  locale
                });
              } catch (dbError: unknown) {
                logger.error("[API-AI] Error saving to DB", {
                  context: "AI",
                  error: errorMessage(dbError),
                  groupId: templateGroupId,
                  fieldType,
                  locale
                });
              }
            }
          }
          // For products and other content types: Send to Shopify
          else if (itemId && (contentType === 'products' || contentType === 'collections' || contentType === 'pages' || contentType === 'blogs' || contentType === 'policies')) {
            // Map fieldType to Shopify key
            const fieldKeyMap: Record<string, string> = {
              title: "title",
              description: "body_html",
              body: contentType === 'policies' ? "body" : "body_html",
              handle: "handle",
              seoTitle: "meta_title",
              metaDescription: "meta_description",
              productType: "product_type",
              summary: "summary_html",
            };
            const shopifyKey = fieldKeyMap[fieldType] || fieldType;

            try {
              const digest = await getCachedDigest(itemId, shopifyKey);

              // R5-C2: empty digest -> Shopify translationsRegister silently
              // no-ops while the local contentTranslation upsert below would
              // still mark the field "translated" (stale-digest divergence:
              // UI says done, storefront still source language). Fail loudly:
              // skip Shopify + skip the local upsert and mark rejected.
              // Mirrors the templates branch `if (!digest)` guard.
              if (!digest) {
                logger.warn("[API-AI] No digest for content field — skipping Shopify save AND local upsert", {
                  context: "AI",
                  fieldType,
                  shopifyKey,
                  locale,
                  resourceId: itemId,
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                const skipProgress = Math.round(10 + ((i + 1) / totalLocales) * 80);
                await db.task.update({
                  where: { id: task.id },
                  data: { progress: skipProgress },
                });
                continue;
              }

              const translationInput = [{
                key: shopifyKey,
                value: translatedValue,
                locale: locale,
                translatableContentDigest: digest
              }];

              const response = await admin.graphql(TRANSLATE_CONTENT, {
                variables: {
                  resourceId: itemId,
                  translations: translationInput
                }
              });

              const data = await response.json() as ShopifyGraphQLResponse;
              let seqRejected = false;

              if (data.errors && data.errors.length > 0) {
                logger.error("[API-AI] GraphQL error saving translation for " + contentType, {
                  context: "AI",
                  errors: data.errors,
                  locale,
                  shopifyKey
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                seqRejected = true;
              } else if ((data.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                logger.error("[API-AI] Shopify rejected translation for " + contentType, {
                  context: "AI",
                  errors: data.data?.translationsRegister?.userErrors,
                  locale,
                  fieldType,
                  shopifyKey
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
                seqRejected = true;
              }

              if (!seqRejected) {
                // Only save to local DB when Shopify accepted
                const resourceTypeMap: Record<string, string> = {
                  products: "Product", collections: "Collection",
                  pages: "Page", blogs: "Article", policies: "ShopPolicy",
                };
                await db.contentTranslation.upsert({
                  where: {
                    shop_resourceId_key_locale_marketId: {
                      marketId: "",
                      shop: session.shop,
                      resourceId: itemId,
                      key: shopifyKey,
                      locale,
                    },
                  },
                  update: { value: translatedValue, digest, resourceType: resourceTypeMap[contentType] || "Product" },
                  create: {
                    shop: session.shop,
                    resourceId: itemId,
                    resourceType: resourceTypeMap[contentType] || "Product",
                    key: shopifyKey,
                    value: translatedValue,
                    locale,
                    digest,
                  },
                });

                logger.debug("[API-AI] Saved translation to Shopify + DB for " + contentType, {
                  context: "AI",
                  resourceId: itemId,
                  fieldType,
                  shopifyKey,
                  locale
                });
              }
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Error sending to Shopify for " + contentType, {
                context: "AI",
                error: errorMessage(shopifyError),
                locale,
                fieldType
              });
            }
          }
          // For metaobjects `fieldType` is the compound key `<GID>#<field key>`
          // — see the batch branch above for why it is no longer a bare GID.
          else if (contentType === 'metaobjects' && fieldType) {
            const parsedMetaKey = parseMetaobjectFieldKey(fieldType);
            const metaobjectGid = parsedMetaKey?.metaobjectId ?? '';
            let seqMetaAccepted = false;
            let metaLabelKey = parsedMetaKey?.fieldKey ?? '';

            try {
              // Populate the digest cache for this entry.
              await getCachedDigest(metaobjectGid, metaLabelKey || 'display_name');
              const metaDigests = metaobjectGid ? digestCache.get(metaobjectGid) : undefined;

              // No digest ⇒ no primary value ⇒ nothing to translate. Reported,
              // never worked around by translating a different field.
              if (!metaLabelKey || !metaDigests?.has(metaLabelKey)) {
                logger.warn("[API-AI] No digest for this metaobject field", {
                  context: "AI",
                  fieldKey: fieldType,
                  metaobjectGid,
                  locale,
                  availableKeys: metaDigests ? Array.from(metaDigests.keys()) : []
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else {
                const digest = metaDigests!.get(metaLabelKey)!;

                const translationInput = [{
                  key: metaLabelKey,
                  value: translatedValue,
                  locale: locale,
                  translatableContentDigest: digest
                }];

                const metaResponse = await admin.graphql(TRANSLATE_CONTENT, {
                  variables: {
                    resourceId: metaobjectGid,
                    translations: translationInput
                  }
                });

                const metaData = await metaResponse.json() as ShopifyGraphQLResponse;

                if (metaData.errors && metaData.errors.length > 0) {
                  logger.error("[API-AI] GraphQL error saving metaobject translation", {
                    context: "AI",
                    errors: metaData.errors,
                    locale,
                    metaobjectGid,
                    metaLabelKey
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                } else if ((metaData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                  logger.error("[API-AI] Shopify rejected metaobject translation", {
                    context: "AI",
                    errors: metaData.data?.translationsRegister?.userErrors,
                    locale,
                    metaobjectGid,
                    metaLabelKey
                  });
                  if (!rejectedFields[locale]) rejectedFields[locale] = [];
                  rejectedFields[locale].push(fieldType);
                } else {
                  seqMetaAccepted = true;
                  logger.info("[API-AI] SUCCESS - Metaobject translation saved to Shopify", {
                    context: "AI",
                    metaobjectGid,
                    metaLabelKey,
                    locale
                  });
                }
              }
            } catch (shopifyError: unknown) {
              logger.error("[API-AI] Error saving metaobject translation", {
                context: "AI",
                error: errorMessage(shopifyError),
                locale,
                metaobjectGid
              });
              if (!rejectedFields[locale]) rejectedFields[locale] = [];
              rejectedFields[locale].push(fieldType);
            }

            if (seqMetaAccepted && metaLabelKey) {
              try {
                const metaType = itemId.replace('metaobject_type_', '');
                await db.metaobjectTranslation.upsert({
                  where: {
                    shop_metaobjectId_key_locale_marketId: {
                      marketId: "",
                      shop: session.shop,
                      metaobjectId: metaobjectGid,
                      key: metaLabelKey,
                      locale
                    }
                  },
                  create: {
                    shop: session.shop,
                    metaobjectId: metaobjectGid,
                    type: metaType,
                    key: metaLabelKey,
                    value: translatedValue,
                    locale,
                    outdated: false
                  },
                  update: {
                    value: translatedValue,
                    outdated: false,
                    updatedAt: new Date()
                  }
                });
                logger.debug("[API-AI] Saved metaobject translation to Shopify + DB", {
                  context: "AI",
                  metaobjectGid,
                  metaLabelKey,
                  locale
                });
              } catch (dbError: unknown) {
                logger.error("[API-AI] Error saving metaobject translation to DB", {
                  context: "AI",
                  error: errorMessage(dbError),
                  metaobjectGid,
                  locale
                });
              }
            }
          }

          // Update progress
          const progress = Math.round(10 + ((i + 1) / totalLocales) * 80);
          await db.task.update({
            where: { id: task.id },
            data: { progress },
          });
        } catch (error: unknown) {
          // Invalid API key: abort the whole loop — every remaining locale would
          // 401 too. Re-throw so the outer handler fails loudly (success: false)
          // instead of marking all locales "rejected" and reporting success.
          if (isAuthError(error)) throw error;
          logger.error("[API-AI] Error translating to locale", {
            context: "AI",
            fieldType,
            locale,
            error: errorMessage(error)
          });
          // The AI call (or its Shopify/DB persistence) failed for this
          // locale — nothing was written to Shopify/DB. Mark the locale as
          // rejected and do NOT put it into `translations`: that map is
          // returned to the client and used to populate the editor, so writing
          // `sourceText` here (a) surfaced the untranslated source as if it
          // were a real translation (N-H3) and (b) kept `translations`
          // non-empty even when EVERY locale failed (e.g. invalid AI API key
          // → 401 for all locales), so the handler reported success: true
          // while nothing was translated. The task log keeps an explicit
          // ERROR entry for diagnostics.
          if (!rejectedFields[locale]) rejectedFields[locale] = [];
          rejectedFields[locale].push(fieldType);
          aiResponses.push({ locale, response: `ERROR: ${errorMessage(error)}` });
        }
      }
    } // End of sequential translation if block

    // No locale produced a real translation → the whole operation failed
    // (e.g. an invalid AI API key returning 401 for every locale, or all
    // batch chunks broke). Previously this still marked the task "completed"
    // and returned success: true, so the frontend reported success while
    // nothing was translated or saved — the silent-failure bug. Fail loudly:
    // mark the task failed and return an error so the editor surfaces it.
    if (Object.keys(translations).length === 0) {
      const firstError = aiResponses.find((r) => r.response.startsWith("ERROR:"))?.response;
      const failMsg = (firstError
        ? firstError.replace(/^ERROR:\s*/, "")
        : "Translation failed for all locales").trim();
      logger.error("[API-AI] translateFieldToAllLocales produced no translations — failing loudly", {
        context: "AI",
        fieldType,
        targetLocales,
        error: failMsg,
      });
      await db.task.update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: failMsg.substring(0, 1000) },
      });
      return json({ success: false, error: failMsg, fieldType, rejectedFields }, { status: 502 });
    }

    // Update task to completed with all AI responses
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify(aiResponses, null, 2), // Store all AI responses
      },
    });

    if (Object.keys(rejectedFields).length > 0) {
      logger.warn("[API-AI] translateFieldToAllLocales completed with rejected fields", {
        context: "AI",
        fieldType,
        rejectedFields
      });
    }

    return json({
      success: true,
      translations,
      fieldType,
      rejectedFields
    });
  } catch (error: unknown) {
    // Update task to failed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage(error).substring(0, 1000),
      },
    });
    throw error;
  }
}

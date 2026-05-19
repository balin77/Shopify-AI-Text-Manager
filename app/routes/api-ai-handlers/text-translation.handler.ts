import { json } from "@remix-run/node";
import type { AIActionContext, TranslatableContentItem, ShopifyGraphQLResponse } from "./shared";
import { errorMessage, errorStack, createAIService } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { safeJsonParse, isValidLocale } from "~/utils/validation";
import { sanitizeSlug } from "~/utils/slug.utils";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { extractReadableName } from "~/utils/templates-field-factory";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";
import { METAOBJECT_LABEL_FIELD_KEYS } from "~/constants/shopifyFields";
import { getCharacterLimitRequirement } from "~/utils/character-limits";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT } from "../../graphql/content.mutations";
import { GroupedFieldTranslationService } from "../../../src/services/grouped-field-translation.service";
import { isGroupedFieldKey } from "~/utils/grouped-field.utils";

export async function handleTranslateField(ctx: AIActionContext): Promise<Response> {
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

export async function handleTranslateFieldToAllLocales(ctx: AIActionContext): Promise<Response> {
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
    const templateKeyToResourceId = new Map<string, string>();
    if (contentType === 'templates' && itemId) {
      templateGroupId = itemId.replace("group_", "");
      const themeContentRows = await db.themeContent.findMany({
        where: {
          shop: session.shop,
          groupId: templateGroupId
        }
      });
      if (themeContentRows.length > 0) {
        templateResourceId = themeContentRows[0].resourceId;
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
          let translatedValue = batchResults[locale] || sourceText;

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
          }

          translations[locale] = translatedValue;
          const isCacheHit = locale in groupedHits;
          aiResponses.push({
            locale,
            response: isCacheHit ? `${translatedValue} (cache)` : translatedValue,
          });

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
              const translationInput = [{
                key: fieldType,
                value: translatedValue,
                locale: locale,
                translatableContentDigest: digest
              }];

              const templateResponse = await admin.graphql(TRANSLATE_CONTENT, {
                variables: {
                  resourceId: fieldResourceId,
                  translations: translationInput
                }
              });

              const templateData = await templateResponse.json() as ShopifyGraphQLResponse;

              if (templateData.errors && templateData.errors.length > 0) {
                logger.error("[API-AI] Batch: GraphQL error saving template translation", {
                  context: "AI",
                  errors: templateData.errors,
                  locale,
                  fieldType
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else if ((templateData.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                logger.error("[API-AI] Batch: Shopify rejected template translation", {
                  context: "AI",
                  errors: templateData.data?.translationsRegister?.userErrors,
                  locale,
                  fieldType
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
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: fieldResourceId,
                      groupId: templateGroupId,
                      key: fieldType,
                      locale: locale
                    }
                  },
                  update: {
                    value: translatedValue,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: templateGroupId,
                    resourceId: fieldResourceId,
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
                    shop_resourceId_key_locale: {
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
          // Save to Shopify for metaobjects
          // fieldType is the metaobject GID (e.g., gid://shopify/Metaobject/123)
          else if (contentType === 'metaobjects' && fieldType) {
            const metaobjectGid = fieldType;
            let batchMetaAccepted = false;
            let metaLabelKey = '';

            try {
              // Populate digest cache for this metaobject
              await getCachedDigest(metaobjectGid, 'display_name');
              const metaDigests = digestCache.get(metaobjectGid);

              // Find the label field key (display_name, name, or label)
              metaLabelKey = (metaDigests
                ? METAOBJECT_LABEL_FIELD_KEYS.find(k => metaDigests.has(k))
                : null) || '';

              if (!metaLabelKey) {
                logger.warn("[API-AI] Batch: No label field digest found for metaobject", {
                  context: "AI",
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
                    shop_metaobjectId_key_locale: {
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
      for (let i = 0; i < targetLocales.length; i++) {
        const locale = targetLocales[i];
        try {
          // Use special method for URL slugs
          let translatedValue = isSlugField
            ? await aiService.translateSlug(sourceText, primaryLocale, locale)
            : await aiService.translateContent(sourceText, primaryLocale, locale);

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
          }

          translations[locale] = translatedValue;
          aiResponses.push({ locale, response: translatedValue });

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
              const translationInput = [{
                key: fieldType,
                value: translatedValue,
                locale: locale,
                translatableContentDigest: digest
              }];

              const response = await admin.graphql(TRANSLATE_CONTENT, {
                variables: {
                  resourceId: fieldResourceId,
                  translations: translationInput
                }
              });

              const data = await response.json() as ShopifyGraphQLResponse;

              if (data.errors && data.errors.length > 0) {
                logger.error("[API-AI] Shopify GraphQL errors", {
                  context: "AI",
                  errors: data.errors,
                  locale,
                  fieldType,
                  resourceId: fieldResourceId
                });
                if (!rejectedFields[locale]) rejectedFields[locale] = [];
                rejectedFields[locale].push(fieldType);
              } else if ((data.data?.translationsRegister?.userErrors?.length ?? 0) > 0) {
                logger.error("[API-AI] Shopify translation userErrors", {
                  context: "AI",
                  errors: data.data?.translationsRegister?.userErrors,
                  locale,
                  fieldType
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
                    shop_resourceId_groupId_key_locale: {
                      shop: session.shop,
                      resourceId: fieldResourceId,
                      groupId: templateGroupId,
                      key: fieldType,
                      locale: locale
                    }
                  },
                  update: {
                    value: translatedValue,
                    updatedAt: new Date()
                  },
                  create: {
                    shop: session.shop,
                    groupId: templateGroupId,
                    resourceId: fieldResourceId,
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
                    shop_resourceId_key_locale: {
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
          // For metaobjects: fieldType is the metaobject GID, use it as resourceId
          else if (contentType === 'metaobjects' && fieldType) {
            const metaobjectGid = fieldType;
            let seqMetaAccepted = false;
            let metaLabelKey = '';

            try {
              // Populate digest cache for this metaobject
              await getCachedDigest(metaobjectGid, 'display_name');
              const metaDigests = digestCache.get(metaobjectGid);

              // Find the label field key (display_name, name, or label)
              metaLabelKey = (metaDigests
                ? METAOBJECT_LABEL_FIELD_KEYS.find(k => metaDigests.has(k))
                : null) || '';

              if (!metaLabelKey) {
                logger.warn("[API-AI] No label field digest found for metaobject", {
                  context: "AI",
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
                    shop_metaobjectId_key_locale: {
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
          logger.error("[API-AI] Error translating to locale", {
            context: "AI",
            fieldType,
            locale,
            error: errorMessage(error)
          });
          translations[locale] = sourceText; // Fallback to original
          aiResponses.push({ locale, response: `ERROR: ${errorMessage(error)}` });
        }
      }
    } // End of sequential translation if block

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

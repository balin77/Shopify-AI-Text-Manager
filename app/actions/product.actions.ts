import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { getTaskExpirationDate } from "../../src/utils/task.utils";
import { ShopifyApiGateway } from "../services/shopify-api-gateway.service";
import { sanitizeSlug } from "../utils/slug.utils";
import { decryptApiKey } from "../utils/encryption.server";

export async function handleProductActions({ request }: ActionFunctionArgs) {
  console.log('📮 [PRODUCT.ACTIONS] === PRODUCT ACTION HANDLER CALLED ===');
  console.log('📮 [PRODUCT.ACTIONS] Request method:', request.method);
  console.log('📮 [PRODUCT.ACTIONS] Request URL:', request.url);
  console.log('📮 [PRODUCT.ACTIONS] Headers:', Object.fromEntries(request.headers.entries()));

  try {
    console.log('🔐 [PRODUCT.ACTIONS] Authenticating request...');
    const { admin, session } = await authenticate.admin(request);
    console.log('✅ [PRODUCT.ACTIONS] Authentication successful - Shop:', session.shop);

    console.log('📥 [PRODUCT.ACTIONS] Parsing form data...');
    const formData = await request.formData();

    // Log all form data
    console.log('📋 [PRODUCT.ACTIONS] Form Data Contents:');
    for (const [key, value] of formData.entries()) {
      console.log(`   - ${key}:`, typeof value === 'string' ? value.substring(0, 100) : value);
    }

    const action = formData.get("action");
    const productId = formData.get("productId") as string;

    console.log('🎯 [PRODUCT.ACTIONS] Action:', action);
    console.log('🎯 [PRODUCT.ACTIONS] Product ID:', productId);

  // Load AI settings and instructions from database
  const { db } = await import("../db.server");
  const aiSettings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  let aiInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  console.log('🔍 [PRODUCT.ACTIONS] AI Instructions loaded:', {
    exists: !!aiInstructions,
    shop: session.shop,
    productSeoTitleInstructions: aiInstructions?.productSeoTitleInstructions ? 'EXISTS (' + aiInstructions.productSeoTitleInstructions.substring(0, 50) + '...)' : 'NULL/UNDEFINED',
    productSeoTitleFormat: aiInstructions?.productSeoTitleFormat || 'NULL/UNDEFINED',
  });

  // If no AI Instructions exist OR they are empty, create/update defaults
  const { DEFAULT_PRODUCT_INSTRUCTIONS } = await import("../constants/aiInstructionsDefaults");

  if (!aiInstructions) {
    aiInstructions = await db.aIInstructions.create({
      data: {
        shop: session.shop,
        productTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
        productTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
        productDescriptionFormat: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
        productDescriptionInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
        productHandleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
        productHandleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
        productSeoTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
        productSeoTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
        productMetaDescFormat: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
        productMetaDescInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
        productAltTextFormat: DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
        productAltTextInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
      },
    });
    console.log('✅ [PRODUCT.ACTIONS] Created default AI Instructions for shop:', session.shop);
  } else if (!aiInstructions.productSeoTitleInstructions) {
    // Entry exists but fields are NULL - update with defaults
    aiInstructions = await db.aIInstructions.update({
      where: { shop: session.shop },
      data: {
        productTitleFormat: aiInstructions.productTitleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
        productTitleInstructions: aiInstructions.productTitleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
        productDescriptionFormat: aiInstructions.productDescriptionFormat || DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
        productDescriptionInstructions: aiInstructions.productDescriptionInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
        productHandleFormat: aiInstructions.productHandleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
        productHandleInstructions: aiInstructions.productHandleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
        productSeoTitleFormat: aiInstructions.productSeoTitleFormat || DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
        productSeoTitleInstructions: aiInstructions.productSeoTitleInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
        productMetaDescFormat: aiInstructions.productMetaDescFormat || DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
        productMetaDescInstructions: aiInstructions.productMetaDescInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
        productAltTextFormat: aiInstructions.productAltTextFormat || DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
        productAltTextInstructions: aiInstructions.productAltTextInstructions || DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
      },
    });
    console.log('✅ [PRODUCT.ACTIONS] Updated AI Instructions with defaults for shop:', session.shop);
  }

  const provider = (aiSettings?.preferredProvider as any) || process.env.AI_PROVIDER || "huggingface";
  const config = {
    huggingfaceApiKey: decryptApiKey(aiSettings?.huggingfaceApiKey) || undefined,
    geminiApiKey: decryptApiKey(aiSettings?.geminiApiKey) || undefined,
    claudeApiKey: decryptApiKey(aiSettings?.claudeApiKey) || undefined,
    openaiApiKey: decryptApiKey(aiSettings?.openaiApiKey) || undefined,
    grokApiKey: decryptApiKey(aiSettings?.grokApiKey) || undefined,
    deepseekApiKey: decryptApiKey(aiSettings?.deepseekApiKey) || undefined,
  };

  // Update queue rate limits from settings
  const { AIQueueService } = await import("../../src/services/ai-queue.service");
  const queue = AIQueueService.getInstance();
  await queue.updateRateLimits(aiSettings);

  // Note: loadTranslations action removed - translations are now pre-loaded from database in the loader

  if (action === "generateAIText") {
    console.log('🤖 [PRODUCT.ACTIONS] Generating AI text for field:', formData.get("fieldType"));
    return handleGenerateAIText(provider, config, aiInstructions, formData, session.shop, productId);
  }

  if (action === "formatAIText") {
    console.log('🎨 [PRODUCT.ACTIONS] Formatting AI text for field:', formData.get("fieldType"));
    return handleFormatAIText(provider, config, aiInstructions, formData, session.shop, productId);
  }

  if (action === "translateField") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating field:', formData.get("fieldType"), 'to locale:', formData.get("targetLocale"));
    return handleTranslateField(provider, config, formData, session.shop, aiInstructions);
  }

  if (action === "translateFieldToAllLocales") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating field to all locales:', formData.get("fieldType"));
    return handleTranslateFieldToAllLocales(admin, provider, config, formData, session.shop, aiInstructions);
  }

  if (action === "translateSuggestion") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating suggestion for field:', formData.get("fieldType"));
    return handleTranslateSuggestion(provider, config, formData, session.shop, aiInstructions);
  }

  if (action === "translateAll") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating all fields for product:', productId);
    return handleTranslateAll(admin, provider, config, formData, productId, session.shop, aiInstructions);
  }

  if (action === "updateProduct") {
    console.log('💾 [PRODUCT.ACTIONS] Updating product:', productId, 'for locale:', formData.get("locale"));
    return handleUpdateProduct(admin, formData, productId, session.shop);
  }

  if (action === "translateOption") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating option:', formData.get("optionId"), 'to locale:', formData.get("targetLocale"));
    return handleTranslateOption(provider, config, formData, session.shop);
  }

  if (action === "generateAltText") {
    console.log('🖼️ [PRODUCT.ACTIONS] Generating alt text for image:', formData.get("imageIndex"));
    return handleGenerateAltText(provider, config, formData, session.shop, productId);
  }

  if (action === "generateAllAltTexts") {
    console.log('🖼️ [PRODUCT.ACTIONS] Generating alt texts for all images');
    return handleGenerateAllAltTexts(admin, provider, config, formData, session.shop, productId);
  }

  if (action === "translateAltText") {
    console.log('🌐 [PRODUCT.ACTIONS] Translating alt text for image:', formData.get("imageIndex"), 'to locale:', formData.get("targetLocale"));
    return handleTranslateAltText(provider, config, formData, session.shop);
  }

  console.error('❌ [PRODUCT.ACTIONS] Unknown action:', action);
  return json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error('❌ [PRODUCT.ACTIONS] Top-level error:', error);
    console.error('❌ [PRODUCT.ACTIONS] Error stack:', error instanceof Error ? error.stack : 'No stack');
    throw error;
  }
}

async function handleLoadTranslations(admin: any, formData: FormData, productId: string, shop: string) {
  const locale = formData.get("locale") as string;

  try {
    console.log('=== LOADING TRANSLATIONS ===');
    console.log('Product ID:', productId);
    console.log('Locale:', locale);

    // Initialize Gateway for rate-limited requests
    const gateway = new ShopifyApiGateway(admin, shop);

    const translationsResponse = await gateway.graphql(
      `#graphql
        query getProductTranslations($resourceId: ID!, $locale: String!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              value
              digest
              locale
            }
            translations(locale: $locale) {
              key
              value
              locale
            }
          }
        }`,
      { variables: { resourceId: productId, locale } }
    );

    const translationsData = await translationsResponse.json();
    console.log('Full response:', JSON.stringify(translationsData, null, 2));

    const translatableContent = translationsData.data?.translatableResource?.translatableContent || [];
    const translations = translationsData.data?.translatableResource?.translations || [];

    console.log('Available translatable keys:', translatableContent.map((c: any) => c.key));
    console.log('Loaded translations:', translations);

    return json({ success: true, translations, locale, translatableContent });
  } catch (error: any) {
    console.error('Error loading translations:', error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleGenerateAIText(
  provider: any,
  config: any,
  aiInstructions: any,
  formData: FormData,
  shop: string,
  productId: string
) {
  const fieldType = formData.get("fieldType") as string;
  const currentValue = formData.get("currentValue") as string;
  const contextTitle = formData.get("contextTitle") as string;
  const contextDescription = formData.get("contextDescription") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: contextTitle,
      fieldType,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    // Create AI service with shop and taskId for queue management
    const aiService = new AIService(provider, config, shop, task.id);

    let generatedContent = "";

    // Update task to queued (queue will update to running)
    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    if (fieldType === "title") {
      let prompt = `Erstelle einen optimierten Produkttitel.`;
      if (aiInstructions?.productTitleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productTitleFormat}`;
      }
      if (aiInstructions?.productTitleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.productTitleInstructions}`;
      }
      prompt += `\n\nKontext:\n${contextDescription || currentValue}`;
      generatedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "description") {
      let prompt = `Erstelle eine optimierte Produktbeschreibung für: ${contextTitle}`;
      if (aiInstructions?.productDescriptionFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productDescriptionFormat}`;
      }
      if (aiInstructions?.productDescriptionInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.productDescriptionInstructions}`;
      }
      prompt += `\n\nAktueller Inhalt:\n${currentValue}`;
      generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
    } else if (fieldType === "handle") {
      let prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.productHandleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productHandleFormat}`;
      }
      if (aiInstructions?.productHandleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.productHandleInstructions}`;
      }
      generatedContent = await aiService.generateProductTitle(prompt);
      generatedContent = sanitizeSlug(generatedContent);
    } else if (fieldType === "seoTitle") {
      let prompt = `Erstelle einen optimierten SEO-Titel für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.productSeoTitleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productSeoTitleFormat}`;
      }
      if (aiInstructions?.productSeoTitleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.productSeoTitleInstructions}`;
      }
      generatedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "metaDescription") {
      let prompt = `Erstelle eine optimierte Meta-Description für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.productMetaDescFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productMetaDescFormat}`;
      }
      if (aiInstructions?.productMetaDescInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.productMetaDescInstructions}`;
      }
      generatedContent = await aiService.generateProductTitle(prompt);
    }

    // Update task to completed
    let resultString = "";
    try {
      resultString = JSON.stringify({ generatedContent: generatedContent.substring(0, 500), fieldType });
    } catch (e) {
      resultString = JSON.stringify({ fieldType, success: true });
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: resultString,
      },
    });

    return json({ success: true, generatedContent, fieldType });
  } catch (error: any) {
    // Update task to failed
    const errorMessage = (error.message || String(error)).substring(0, 1000);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleFormatAIText(
  provider: any,
  config: any,
  aiInstructions: any,
  formData: FormData,
  shop: string,
  productId: string
) {
  const fieldType = formData.get("fieldType") as string;
  const currentValue = formData.get("currentValue") as string;
  const contextTitle = formData.get("contextTitle") as string;
  const contextDescription = formData.get("contextDescription") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "aiFormatting",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: contextTitle,
      fieldType,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiService = new AIService(provider, config, shop, task.id);

    let formattedContent = "";

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    if (fieldType === "title") {
      let prompt = `Formatiere den folgenden Produkttitel gemäß den Formatierungsrichtlinien:\n\nAktueller Titel:\n${currentValue}`;
      if (aiInstructions?.productTitleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productTitleFormat}`;
      }
      if (aiInstructions?.productTitleInstructions) {
        prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions.productTitleInstructions}`;
      }
      formattedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "description") {
      let prompt = `Formatiere die folgende Produktbeschreibung gemäß den Formatierungsrichtlinien:\n\nAktuelle Beschreibung:\n${currentValue}`;
      if (aiInstructions?.productDescriptionFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productDescriptionFormat}`;
      }
      if (aiInstructions?.productDescriptionInstructions) {
        prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions.productDescriptionInstructions}`;
      }
      formattedContent = await aiService.generateProductDescription(currentValue, prompt);
    } else if (fieldType === "handle") {
      let prompt = `Formatiere den folgenden URL-Slug gemäß den Formatierungsrichtlinien:\n\nAktueller Slug:\n${currentValue}\n\nKontext - Titel: ${contextTitle}`;
      if (aiInstructions?.productHandleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productHandleFormat}`;
      }
      if (aiInstructions?.productHandleInstructions) {
        prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions.productHandleInstructions}`;
      }
      formattedContent = await aiService.generateProductTitle(prompt);
      formattedContent = sanitizeSlug(formattedContent);
    } else if (fieldType === "seoTitle") {
      let prompt = `Formatiere den folgenden SEO-Titel gemäß den Formatierungsrichtlinien:\n\nAktueller SEO-Titel:\n${currentValue}\n\nKontext - Titel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.productSeoTitleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productSeoTitleFormat}`;
      }
      if (aiInstructions?.productSeoTitleInstructions) {
        prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions.productSeoTitleInstructions}`;
      }
      formattedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "metaDescription") {
      let prompt = `Formatiere die folgende Meta-Description gemäß den Formatierungsrichtlinien:\n\nAktuelle Meta-Description:\n${currentValue}\n\nKontext - Titel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.productMetaDescFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.productMetaDescFormat}`;
      }
      if (aiInstructions?.productMetaDescInstructions) {
        prompt += `\n\nFormatierungsanweisungen:\n${aiInstructions.productMetaDescInstructions}`;
      }
      formattedContent = await aiService.generateProductTitle(prompt);
    }

    let resultString = "";
    try {
      resultString = JSON.stringify({ formattedContent: formattedContent.substring(0, 500), fieldType });
    } catch (e) {
      resultString = JSON.stringify({ fieldType, success: true });
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: resultString,
      },
    });

    return json({ success: true, generatedContent: formattedContent, fieldType });
  } catch (error: any) {
    const errorMessage = (error.message || String(error)).substring(0, 1000);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateField(
  provider: any,
  config: any,
  formData: FormData,
  shop: string,
  aiInstructions?: any
) {
  const fieldType = formData.get("fieldType") as string;
  const sourceText = formData.get("sourceText") as string;
  const targetLocale = formData.get("targetLocale") as string;
  const productId = formData.get("productId") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "translation",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      fieldType,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const translationService = new TranslationService(provider, config, shop, task.id);

    const changedFields: any = {};
    changedFields[fieldType] = sourceText;

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    const translations = await translationService.translateProduct(changedFields, [targetLocale], 'product');
    const translatedValue = translations[targetLocale]?.[fieldType] || "";

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
      },
    });

    return json({ success: true, translatedValue, fieldType, targetLocale });
  } catch (error: any) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: error.message,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateFieldToAllLocales(
  admin: any,
  provider: any,
  config: any,
  formData: FormData,
  shop: string,
  aiInstructions?: any
) {
  const fieldType = formData.get("fieldType") as string;
  const sourceText = formData.get("sourceText") as string;
  const productId = formData.get("productId") as string;
  const targetLocalesStr = formData.get("targetLocales") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      fieldType,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const translationService = new TranslationService(provider, config, shop, task.id);
    const gateway = new ShopifyApiGateway(admin, shop);

    const changedFields: any = {};
    changedFields[fieldType] = sourceText;

    // Get target locales from request or use default
    const targetLocales = targetLocalesStr ? JSON.parse(targetLocalesStr) : ['en', 'fr', 'es', 'it'];
    const totalLocales = targetLocales.length;
    let processedLocales = 0;
    const allTranslations: Record<string, string> = {};

    console.log(`[TranslateFieldToAllLocales] Starting translation for field ${fieldType} in product ${productId}`);
    console.log(`[TranslateFieldToAllLocales] Target locales:`, targetLocales);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10, total: totalLocales, processed: 0 },
    });

    // Get the translatableContent for this product
    const translatableResponse = await gateway.graphql(
      `#graphql
        query getTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              value
              digest
              locale
            }
          }
        }`,
      { variables: { resourceId: productId } }
    );

    const translatableData = await translatableResponse.json();
    const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

    // Create a map of key -> digest
    const digestMap: Record<string, string> = {};
    for (const content of translatableContent) {
      digestMap[content.key] = content.digest;
    }

    // Map fieldType to Shopify key
    const fieldKeyMap: Record<string, string> = {
      title: "title",
      description: "body_html",
      handle: "handle",
      seoTitle: "meta_title",
      metaDescription: "meta_description",
    };
    const shopifyKey = fieldKeyMap[fieldType];

    if (!shopifyKey) {
      throw new Error(`Unknown field type: ${fieldType}`);
    }

    // Translate to each locale one by one
    for (const locale of targetLocales) {
      try {
        console.log(`[TranslateFieldToAllLocales] Translating ${fieldType} to ${locale}`);

        const localeTranslations = await translationService.translateProduct(changedFields, [locale], 'product');
        const translatedValue = localeTranslations[locale]?.[fieldType] || "";

        if (!translatedValue) {
          console.warn(`[TranslateFieldToAllLocales] No translation returned for ${locale}`);
          continue;
        }

        allTranslations[locale] = translatedValue;

        // Save to Shopify
        if (digestMap[shopifyKey]) {
          console.log(`[TranslateFieldToAllLocales] Saving ${shopifyKey} to Shopify for ${locale}`);

          const response = await gateway.graphql(
            `#graphql
              mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors {
                    field
                    message
                  }
                  translations {
                    locale
                    key
                    value
                  }
                }
              }`,
            {
              variables: {
                resourceId: productId,
                translations: [{
                  key: shopifyKey,
                  value: translatedValue,
                  locale,
                  translatableContentDigest: digestMap[shopifyKey]
                }]
              },
            }
          );

          const responseData = await response.json();
          if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
            console.error(`[TranslateFieldToAllLocales] Shopify API error for ${locale}:`, responseData.data.translationsRegister.userErrors);
          } else {
            console.log(`[TranslateFieldToAllLocales] Successfully saved ${shopifyKey} for ${locale}`);

            // Update local database
            const product = await db.product.findFirst({
              where: { id: productId },
              select: { shop: true }
            });

            if (product) {
              await db.translation.deleteMany({
                where: {
                  productId: productId,
                  locale: locale,
                  key: shopifyKey,
                },
              });

              await db.translation.create({
                data: {
                  productId: productId,
                  key: shopifyKey,
                  value: translatedValue,
                  locale: locale,
                  digest: digestMap[shopifyKey] || null,
                },
              });
              console.log(`[TranslateFieldToAllLocales] ✓ Saved translation to DB for ${locale}`);
            }
          }
        }

        processedLocales++;
        const progressPercent = Math.round(10 + (processedLocales / totalLocales) * 90);
        await db.task.update({
          where: { id: task.id },
          data: { progress: progressPercent, processed: processedLocales },
        });
      } catch (localeError: any) {
        console.error(`[TranslateFieldToAllLocales] ERROR: Failed to translate to ${locale}:`, localeError);
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: processedLocales > 0 ? "completed" : "failed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ translations: allTranslations, fieldType }),
      },
    });

    return json({ success: processedLocales > 0, translations: allTranslations, fieldType, processedLocales, totalLocales });
  } catch (error: any) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: error.message,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateSuggestion(
  provider: any,
  config: any,
  formData: FormData,
  shop: string,
  aiInstructions?: any
) {
  const suggestion = formData.get("suggestion") as string;
  const fieldType = formData.get("fieldType") as string;

  try {
    const translationService = new TranslationService(provider, config, shop);
    const changedFields: any = {};
    changedFields[fieldType] = suggestion;

    const translations = await translationService.translateProduct(changedFields, undefined, 'product');

    return json({ success: true, translations, fieldType });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateAll(
  admin: any,
  provider: any,
  config: any,
  formData: FormData,
  productId: string,
  shop: string,
  aiInstructions?: any
) {
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const handle = formData.get("handle") as string;
  const seoTitle = formData.get("seoTitle") as string;
  const metaDescription = formData.get("metaDescription") as string;
  const targetLocalesStr = formData.get("targetLocales") as string;

  const { db } = await import("../db.server");

  // Create task entry first
  const task = await db.task.create({
    data: {
      shop,
      type: "bulkTranslation",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: title,
      fieldType: "all",
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Create TranslationService instance with task ID
  const translationService = new TranslationService(provider, config, shop, task.id);

  // Initialize Gateway for rate-limited requests
  const gateway = new ShopifyApiGateway(admin, shop);
  console.log('[TranslateAll] Using Shopify API Gateway for rate limiting');

  try {
    const changedFields: any = {};
    if (title) changedFields.title = title;
    if (description) changedFields.description = description;
    if (handle) changedFields.handle = handle;
    if (seoTitle) changedFields.seoTitle = seoTitle;
    if (metaDescription) changedFields.metaDescription = metaDescription;

    if (Object.keys(changedFields).length === 0) {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: "No fields to translate",
        },
      });
      return json({ success: false, error: "No fields to translate" }, { status: 400 });
    }

    // Get target locales from request or use default
    const targetLocales = targetLocalesStr ? JSON.parse(targetLocalesStr) : ['en', 'fr', 'es', 'it'];
    const totalLocales = targetLocales.length;
    let processedLocales = 0;
    const allTranslations: Record<string, any> = {};

    console.log(`[TranslateAll] Starting translation for product ${productId}`);
    console.log(`[TranslateAll] Fields to translate:`, Object.keys(changedFields));
    console.log(`[TranslateAll] Target locales:`, targetLocales);

    // Update progress
    await db.task.update({
      where: { id: task.id },
      data: { progress: 10, total: totalLocales, processed: 0 },
    });

    // First, get the translatableContent for this product using Gateway
    console.log(`[TranslateAll] Fetching translatableContent for product ${productId}`);
    const translatableResponse = await gateway.graphql(
      `#graphql
        query getTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            resourceId
            translatableContent {
              key
              value
              digest
              locale
            }
          }
        }`,
      { variables: { resourceId: productId } }
    );

    const translatableData = await translatableResponse.json();
    const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];
    console.log(`[TranslateAll] Found ${translatableContent.length} translatable content items`);

    // Create a map of key -> digest
    const digestMap: Record<string, string> = {};
    for (const content of translatableContent) {
      digestMap[content.key] = content.digest;
    }
    console.log(`[TranslateAll] Digest map:`, digestMap);

    // Translate each locale one by one to prevent data loss
    for (const locale of targetLocales) {
      try {
        console.log(`[TranslateAll] Starting translation for locale: ${locale}`);

        // Translate to this specific locale
        const localeTranslations = await translationService.translateProduct(changedFields, [locale], 'product');
        console.log(`[TranslateAll] Translation response for ${locale}:`, JSON.stringify(localeTranslations).substring(0, 200));

        const fields = localeTranslations[locale];

        if (!fields) {
          console.warn(`[TranslateAll] No translations returned for locale ${locale}`);
          console.warn(`[TranslateAll] Full response:`, localeTranslations);
          continue;
        }

        console.log(`[TranslateAll] Successfully got translations for ${locale}, fields:`, Object.keys(fields));

        // Store translations
        allTranslations[locale] = fields;

        // Save to Shopify immediately
        const translationsInput = [];
        if (fields.title && digestMap['title']) {
          translationsInput.push({
            key: "title",
            value: fields.title,
            locale,
            translatableContentDigest: digestMap['title']
          });
        }
        if (fields.description && digestMap['body_html']) {
          translationsInput.push({
            key: "body_html",
            value: fields.description,
            locale,
            translatableContentDigest: digestMap['body_html']
          });
        }
        if (fields.handle && digestMap['handle']) {
          translationsInput.push({
            key: "handle",
            value: fields.handle,
            locale,
            translatableContentDigest: digestMap['handle']
          });
        }
        if (fields.seoTitle && digestMap['meta_title']) {
          translationsInput.push({
            key: "meta_title",
            value: fields.seoTitle,
            locale,
            translatableContentDigest: digestMap['meta_title']
          });
        }
        if (fields.metaDescription && digestMap['meta_description']) {
          translationsInput.push({
            key: "meta_description",
            value: fields.metaDescription,
            locale,
            translatableContentDigest: digestMap['meta_description']
          });
        }

        console.log(`[TranslateAll] Saving ${translationsInput.length} translations to Shopify for ${locale}`);

        for (const translation of translationsInput) {
          console.log(`[TranslateAll] Saving field ${translation.key} for ${locale} with digest ${translation.translatableContentDigest}`);
          const response = await gateway.graphql(
            `#graphql
              mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors {
                    field
                    message
                  }
                  translations {
                    locale
                    key
                    value
                  }
                }
              }`,
            {
              variables: {
                resourceId: productId,
                translations: [translation]
              },
            }
          );

          const responseData = await response.json();
          if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
            console.error(`[TranslateAll] Shopify API error for ${locale}:`, responseData.data.translationsRegister.userErrors);
          } else {
            console.log(`[TranslateAll] Successfully saved ${translation.key} for ${locale}`);
          }
        }

        // 🔥 DIRECT DB UPDATE: Update local database immediately after Shopify success
        console.log(`[TranslateAll] Updating DB translations for product ${productId}, locale ${locale}`);

        // Get the shop from the product
        const product = await db.product.findFirst({
          where: { id: productId },
          select: { shop: true }
        });

        if (product && translationsInput.length > 0) {
          // Delete existing translations for this locale and product
          await db.translation.deleteMany({
            where: {
              productId: productId,
              locale: locale,
            },
          });

          // Insert new translations
          await db.translation.createMany({
            data: translationsInput.map(t => ({
              productId: productId,
              key: t.key,
              value: t.value,
              locale: locale,
              digest: t.translatableContentDigest || null,
            })),
          });
          console.log(`[TranslateAll] ✓ Saved ${translationsInput.length} translations to DB for ${locale}`);
        }

        processedLocales++;
        console.log(`[TranslateAll] Completed locale ${locale}. Progress: ${processedLocales}/${totalLocales}`);

        // Update progress after each locale
        const progressPercent = Math.round(10 + (processedLocales / totalLocales) * 90);
        await db.task.update({
          where: { id: task.id },
          data: { progress: progressPercent, processed: processedLocales },
        });
      } catch (localeError: any) {
        console.error(`[TranslateAll] ERROR: Failed to translate to ${locale}:`, localeError);
        console.error(`[TranslateAll] ERROR Stack:`, localeError.stack);

        // Check if it's an API limit error
        const errorMessage = localeError.message || String(localeError);
        if (errorMessage.includes('usage limit') || errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
          console.error(`[TranslateAll] AI Provider quota exceeded. Please check Settings to switch AI provider or add API keys.`);
        }

        // Continue with other locales even if one fails
      }
    }

    console.log(`[TranslateAll] Finished all locales. Processed: ${processedLocales}/${totalLocales}`);

    // Mark task as completed
    let resultString = "";
    try {
      resultString = JSON.stringify({
        success: true,
        localesProcessed: processedLocales,
        locales: Object.keys(allTranslations),
        attempted: totalLocales
      });
    } catch (e) {
      // Fallback if JSON.stringify fails
      resultString = `{"success":true,"localesProcessed":${processedLocales},"attempted":${totalLocales}}`;
    }

    // Determine error message if no locales were processed
    let finalError = null;
    if (processedLocales === 0) {
      finalError = "No locales were successfully translated. This may be due to API quota limits. Please check your AI provider settings and ensure you have sufficient API credits.";
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: processedLocales > 0 ? "completed" : "failed",
        progress: 100,
        completedAt: new Date(),
        result: resultString,
        error: finalError,
      },
    });

    return json({ success: processedLocales > 0, translations: allTranslations, processedLocales, totalLocales });
  } catch (error: any) {
    // Mark task as failed
    const errorMessage = (error.message || String(error)).substring(0, 1000);
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: errorMessage,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleUpdateProduct(admin: any, formData: FormData, productId: string, shop: string) {
  const locale = formData.get("locale") as string;
  const primaryLocale = formData.get("primaryLocale") as string;
  const title = formData.get("title") as string;
  const descriptionHtml = formData.get("descriptionHtml") as string;
  let handle = formData.get("handle") as string;
  const seoTitle = formData.get("seoTitle") as string;
  const metaDescription = formData.get("metaDescription") as string;
  const imageAltTextsStr = formData.get("imageAltTexts") as string;

  console.log('[UPDATE-PRODUCT] ========== UPDATE PRODUCT START ==========');
  console.log('[UPDATE-PRODUCT] Product ID:', productId);
  console.log('[UPDATE-PRODUCT] Locale:', locale);
  console.log('[UPDATE-PRODUCT] Primary Locale:', primaryLocale);
  console.log('[UPDATE-PRODUCT] Title:', title);
  console.log('[UPDATE-PRODUCT] SEO Title:', seoTitle);
  console.log('[UPDATE-PRODUCT] Meta Description:', metaDescription);
  console.log('[UPDATE-PRODUCT] Handle:', handle);
  console.log('[UPDATE-PRODUCT] Has alt-texts:', !!imageAltTextsStr);

  // Sanitize handle to ensure it's a valid URL slug
  if (handle) {
    handle = sanitizeSlug(handle);
    if (!handle) {
      return json({ success: false, error: "Invalid URL slug: Handle must contain at least one alphanumeric character" }, { status: 400 });
    }
  }

  try {
    const { db } = await import("../db.server");

    // Initialize Gateway for rate-limited requests
    const gateway = new ShopifyApiGateway(admin, shop);
    console.log('[UPDATE-PRODUCT] Using Shopify API Gateway for rate limiting');

    // Parse alt-texts if provided
    let imageAltTexts: Record<number, string> = {};
    if (imageAltTextsStr) {
      try {
        imageAltTexts = JSON.parse(imageAltTextsStr);
      } catch (e) {
        console.error('[UPDATE-PRODUCT] Failed to parse imageAltTexts:', e);
      }
    }

    // Update alt-texts first (works for both primary and translated locales)
    if (Object.keys(imageAltTexts).length > 0) {
      console.log('[UPDATE-PRODUCT] Updating alt-texts:', imageAltTexts);

      // Get product images to update (both from Shopify and DB)
      const productResponse = await gateway.graphql(
        `#graphql
          query getProduct($id: ID!) {
            product(id: $id) {
              media(first: 50) {
                edges {
                  node {
                    ... on MediaImage {
                      id
                      alt
                    }
                  }
                }
              }
            }
          }`,
        { variables: { id: productId } }
      );

      const productData = await productResponse.json();
      const mediaEdges = productData.data?.product?.media?.edges || [];

      // Get DB product images
      const dbProduct = await db.product.findUnique({
        where: { id: productId },
        include: { images: true }
      });

      // Update each image with new alt-text
      for (const [indexStr, altText] of Object.entries(imageAltTexts)) {
        const index = parseInt(indexStr);
        if (index < mediaEdges.length) {
          const imageId = mediaEdges[index].node.id;
          console.log(`[UPDATE-PRODUCT] Updating alt-text for image ${index} (${imageId}): ${altText}`);

          // Save to Shopify
          await gateway.graphql(
            `#graphql
              mutation updateMedia($media: [UpdateMediaInput!]!) {
                productUpdateMedia(media: $media, productId: "${productId}") {
                  media {
                    alt
                    mediaErrors {
                      field
                      message
                    }
                  }
                  mediaUserErrors {
                    field
                    message
                  }
                  product {
                    id
                  }
                }
              }`,
            {
              variables: {
                media: [{
                  id: imageId,
                  alt: altText
                }]
              }
            }
          );

          // 🔥 NEW: Save to Database
          const dbImage = dbProduct?.images[index];
          if (dbImage) {
            console.log(`[UPDATE-PRODUCT] Saving alt-text to DB for image ${index}, locale: ${locale}`);

            if (locale === primaryLocale) {
              // Primary locale: Update the ProductImage table directly
              await db.productImage.update({
                where: { id: dbImage.id },
                data: { altText }
              });
              console.log(`[UPDATE-PRODUCT] ✓ Updated primary alt-text in DB for image ${index}`);
            } else {
              // Translation: Update the ProductImageAltTranslation table
              // Check for existing translation first
              const existing = await db.productImageAltTranslation.findUnique({
                where: {
                  imageId_locale: {
                    imageId: dbImage.id,
                    locale: locale
                  }
                }
              });

              if (existing) {
                await db.productImageAltTranslation.update({
                  where: { id: existing.id },
                  data: { altText }
                });
              } else {
                await db.productImageAltTranslation.create({
                  data: {
                    imageId: dbImage.id,
                    locale: locale,
                    altText: altText
                  }
                });
              }
              console.log(`[UPDATE-PRODUCT] ✓ Saved alt-text translation in DB for image ${index}, locale: ${locale}`);
            }
          }
        }
      }
    }

    if (locale !== formData.get("primaryLocale")) {
      const translationsInput = [];
      if (title) translationsInput.push({ key: "title", value: title, locale });
      if (descriptionHtml) translationsInput.push({ key: "body_html", value: descriptionHtml, locale });
      if (handle) translationsInput.push({ key: "handle", value: handle, locale });
      if (seoTitle) translationsInput.push({ key: "meta_title", value: seoTitle, locale });
      if (metaDescription) translationsInput.push({ key: "meta_description", value: metaDescription, locale });

      // Save to Shopify using Gateway
      for (const translation of translationsInput) {
        const response = await gateway.graphql(
          `#graphql
            mutation translateProduct($resourceId: ID!, $translations: [TranslationInput!]!) {
              translationsRegister(resourceId: $resourceId, translations: $translations) {
                userErrors {
                  field
                  message
                }
                translations {
                  locale
                  key
                  value
                }
              }
            }`,
          {
            variables: {
              resourceId: productId,
              translations: [translation]
            },
          }
        );

        // Check for errors - only update DB if Shopify confirms success
        const responseData = await response.json();
        if (responseData.data?.translationsRegister?.userErrors?.length > 0) {
          console.error(`[UPDATE-PRODUCT] Shopify API error for translation:`, responseData.data.translationsRegister.userErrors);
          return json({
            success: false,
            error: responseData.data.translationsRegister.userErrors[0].message
          }, { status: 500 });
        }
      }

      // 🔥 DIRECT DB UPDATE: Update local database immediately after Shopify success
      console.log(`[UPDATE-PRODUCT] Updating DB translations for product ${productId}`);

      // Get the shop from the product ID or extract from context
      const product = await db.product.findFirst({
        where: { id: productId },
        select: { shop: true }
      });

      if (product) {
        // Delete existing translations for this locale and product
        await db.translation.deleteMany({
          where: {
            productId: productId,
            locale: locale,
          },
        });

        // Insert new translations
        if (translationsInput.length > 0) {
          await db.translation.createMany({
            data: translationsInput.map(t => ({
              productId: productId,
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: null,
            })),
          });
          console.log(`[UPDATE-PRODUCT] ✓ Saved ${translationsInput.length} translations to DB`);
        }
      }

      return json({ success: true });
    } else {
      const response = await gateway.graphql(
        `#graphql
          mutation updateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                title
                handle
                descriptionHtml
                seo {
                  title
                  description
                }
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            input: {
              id: productId,
              title,
              handle,
              descriptionHtml,
              seo: {
                title: seoTitle,
                description: metaDescription,
              },
            },
          },
        }
      );

      const data = await response.json();

      if (data.data.productUpdate.userErrors.length > 0) {
        return json({
          success: false,
          error: data.data.productUpdate.userErrors[0].message
        }, { status: 500 });
      }

      // 🔥 UPDATE LOCAL DATABASE: Update the Product table with the saved values
      console.log(`[UPDATE-PRODUCT] Updating DB for primary locale product ${productId}`);

      try {
        const updateData: any = {};
        if (title) updateData.title = title;
        if (descriptionHtml) updateData.descriptionHtml = descriptionHtml;
        if (handle) updateData.handle = handle;
        if (seoTitle !== undefined) updateData.seoTitle = seoTitle || null;
        if (metaDescription !== undefined) updateData.seoDescription = metaDescription || null;

        // Always update lastSyncedAt
        updateData.lastSyncedAt = new Date();

        await db.product.update({
          where: { id: productId },
          data: updateData,
        });

        console.log(`[UPDATE-PRODUCT] ✓ Updated Product DB for ${productId}:`, Object.keys(updateData));
      } catch (dbError: any) {
        console.error(`[UPDATE-PRODUCT] Failed to update DB for ${productId}:`, dbError);
        // Don't fail the entire request if DB update fails - Shopify is the source of truth
      }

      return json({ success: true, product: data.data.productUpdate.product });
    }
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateOption(
  provider: any,
  config: any,
  formData: FormData,
  shop: string
) {
  const optionId = formData.get("optionId") as string;
  const optionName = formData.get("optionName") as string;
  const optionValuesStr = formData.get("optionValues") as string;
  const targetLocale = formData.get("targetLocale") as string;

  try {
    const translationService = new TranslationService(provider, config, shop);
    const optionValues = JSON.parse(optionValuesStr);

    // Translate the option name
    const nameTranslations = await translationService.translateProduct({ optionName }, [targetLocale]);
    const translatedName = nameTranslations[targetLocale]?.optionName || "";

    // Translate all option values
    const valueFields: any = {};
    optionValues.forEach((value: string, index: number) => {
      valueFields[`value_${index}`] = value;
    });

    const valueTranslations = await translationService.translateProduct(valueFields, [targetLocale]);
    const translatedValues = optionValues.map((_: string, index: number) => {
      return valueTranslations[targetLocale]?.[`value_${index}`] || "";
    });

    return json({
      success: true,
      optionId,
      translatedName,
      translatedValues,
      targetLocale
    });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleGenerateAltText(
  provider: any,
  config: any,
  formData: FormData,
  shop: string,
  productId: string
) {
  const imageIndex = parseInt(formData.get("imageIndex") as string);
  const imageUrl = formData.get("imageUrl") as string;
  const productTitle = formData.get("productTitle") as string;

  const { db } = await import("../db.server");

  // Load AI instructions
  const aiInstructions = await db.aIInstructions.findUnique({
    where: { shop },
  });

  const task = await db.task.create({
    data: {
      shop,
      type: "aiGeneration",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: productTitle,
      fieldType: `altText_${imageIndex}`,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiService = new AIService(provider, config, shop, task.id);

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    let prompt = `Erstelle einen optimierten Alt-Text für ein Produktbild.
Produkt: ${productTitle}
Bild-URL: ${imageUrl}`;

    if (aiInstructions?.productAltTextFormat) {
      prompt += `\n\nFormatbeispiel:\n${aiInstructions.productAltTextFormat}`;
    }

    if (aiInstructions?.productAltTextInstructions) {
      prompt += `\n\nAnweisungen:\n${aiInstructions.productAltTextInstructions}`;
    }

    const altText = await aiService.generateImageAltText(imageUrl, productTitle, prompt);

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ altText, imageIndex }),
      },
    });

    return json({ success: true, altText, imageIndex });
  } catch (error: any) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: error.message,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleGenerateAllAltTexts(
  admin: any,
  provider: any,
  config: any,
  formData: FormData,
  shop: string,
  productId: string
) {
  const imagesDataStr = formData.get("imagesData") as string;
  const productTitle = formData.get("productTitle") as string;

  const { db } = await import("../db.server");

  const task = await db.task.create({
    data: {
      shop,
      type: "bulkAIGeneration",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: productTitle,
      fieldType: "allAltTexts",
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const imagesData = JSON.parse(imagesDataStr);
    const totalImages = imagesData.length;
    const generatedAltTexts: Record<number, string> = {};

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10, total: totalImages, processed: 0 },
    });

    const aiService = new AIService(provider, config, shop, task.id);

    for (let i = 0; i < imagesData.length; i++) {
      const image = imagesData[i];
      try {
        const altText = await aiService.generateImageAltText(image.url, productTitle);
        generatedAltTexts[i] = altText;

        const progressPercent = Math.round(10 + ((i + 1) / totalImages) * 90);
        await db.task.update({
          where: { id: task.id },
          data: { progress: progressPercent, processed: i + 1 },
        });
      } catch (error: any) {
        console.error(`Failed to generate alt text for image ${i}:`, error);
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ generatedAltTexts }),
      },
    });

    return json({ success: true, generatedAltTexts });
  } catch (error: any) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: error.message,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateAltText(
  provider: any,
  config: any,
  formData: FormData,
  shop: string
) {
  const imageIndex = parseInt(formData.get("imageIndex") as string);
  const sourceAltText = formData.get("sourceAltText") as string;
  const targetLocale = formData.get("targetLocale") as string;
  const productId = formData.get("productId") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "translation",
      status: "pending",
      resourceType: "product",
      resourceId: productId,
      fieldType: `altText_${imageIndex}`,
      targetLocale,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const translationService = new TranslationService(provider, config, shop, task.id);

    const changedFields: any = {};
    changedFields[`altText_${imageIndex}`] = sourceAltText;

    await db.task.update({
      where: { id: task.id },
      data: { status: "queued", progress: 10 },
    });

    const translations = await translationService.translateProduct(changedFields, [targetLocale]);
    const translatedAltText = translations[targetLocale]?.[`altText_${imageIndex}`] || "";

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
      },
    });

    return json({ success: true, translatedAltText, imageIndex, targetLocale });
  } catch (error: any) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: error.message,
      },
    });

    return json({ success: false, error: error.message }, { status: 500 });
  }
}

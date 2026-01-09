import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";

export async function handleProductActions({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");
  const productId = formData.get("productId") as string;

  // Load AI settings and instructions from database
  const { db } = await import("../db.server");
  const aiSettings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  const aiInstructions = await db.aIInstructions.findUnique({
    where: { shop: session.shop },
  });

  const provider = (aiSettings?.preferredProvider as any) || process.env.AI_PROVIDER || "huggingface";
  const config = {
    huggingfaceApiKey: aiSettings?.huggingfaceApiKey || undefined,
    geminiApiKey: aiSettings?.geminiApiKey || undefined,
    claudeApiKey: aiSettings?.claudeApiKey || undefined,
    openaiApiKey: aiSettings?.openaiApiKey || undefined,
  };

  const aiService = new AIService(provider, config);
  const translationService = new TranslationService(provider, config);

  if (action === "loadTranslations") {
    return handleLoadTranslations(admin, formData, productId);
  }

  if (action === "generateAIText") {
    return handleGenerateAIText(aiService, aiInstructions, formData, session.shop, productId);
  }

  if (action === "translateField") {
    return handleTranslateField(translationService, formData);
  }

  if (action === "translateSuggestion") {
    return handleTranslateSuggestion(translationService, formData);
  }

  if (action === "translateAll") {
    return handleTranslateAll(admin, translationService, formData, productId, session.shop);
  }

  if (action === "updateProduct") {
    return handleUpdateProduct(admin, formData, productId);
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}

async function handleLoadTranslations(admin: any, formData: FormData, productId: string) {
  const locale = formData.get("locale") as string;

  try {
    const translationsResponse = await admin.graphql(
      `#graphql
        query getProductTranslations($resourceId: ID!, $locale: String!) {
          translatableResource(resourceId: $resourceId) {
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
    const translations = translationsData.data?.translatableResource?.translations || [];

    return json({ success: true, translations, locale });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleGenerateAIText(
  aiService: AIService,
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
      status: "running",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: contextTitle,
      fieldType,
      progress: 0,
    },
  });

  try {
    let generatedContent = "";

    // Update task to running
    await db.task.update({
      where: { id: task.id },
      data: { status: "running", progress: 10 },
    });

    if (fieldType === "title") {
      let prompt = `Erstelle einen optimierten Produkttitel.`;
      if (aiInstructions?.titleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.titleFormat}`;
      }
      if (aiInstructions?.titleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.titleInstructions}`;
      }
      prompt += `\n\nKontext:\n${contextDescription || currentValue}\n\nGib nur den Titel zurück, ohne Erklärungen.`;
      generatedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "description") {
      let prompt = `Erstelle eine optimierte Produktbeschreibung für: ${contextTitle}`;
      if (aiInstructions?.descriptionFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.descriptionFormat}`;
      }
      if (aiInstructions?.descriptionInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.descriptionInstructions}`;
      }
      prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur die Beschreibung zurück, ohne Erklärungen.`;
      generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
    } else if (fieldType === "handle") {
      let prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.handleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.handleFormat}`;
      }
      if (aiInstructions?.handleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.handleInstructions}`;
      } else {
        prompt += `\n\nDer Slug sollte:\n- Nur Kleinbuchstaben und Bindestriche enthalten\n- Keine Sonderzeichen oder Umlaute haben\n- Kurz und prägnant sein (2-5 Wörter)\n- SEO-optimiert sein`;
      }
      prompt += `\n\nGib nur den Slug zurück, ohne Erklärungen.`;
      generatedContent = await aiService.generateProductTitle(prompt);
      generatedContent = generatedContent.toLowerCase().trim();
    } else if (fieldType === "seoTitle") {
      let prompt = `Erstelle einen optimierten SEO-Titel für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.seoTitleFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.seoTitleFormat}`;
      }
      if (aiInstructions?.seoTitleInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.seoTitleInstructions}`;
      } else {
        prompt += `\n\nDer SEO-Titel sollte:\n- Max. 60 Zeichen lang sein\n- Keywords enthalten\n- Zum Klicken anregen\n- Den Produktnutzen kommunizieren`;
      }
      prompt += `\n\nGib nur den SEO-Titel zurück, ohne Erklärungen.`;
      generatedContent = await aiService.generateProductTitle(prompt);
    } else if (fieldType === "metaDescription") {
      let prompt = `Erstelle eine optimierte Meta-Description für dieses Produkt:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
      if (aiInstructions?.metaDescFormat) {
        prompt += `\n\nFormatbeispiel:\n${aiInstructions.metaDescFormat}`;
      }
      if (aiInstructions?.metaDescInstructions) {
        prompt += `\n\nAnweisungen:\n${aiInstructions.metaDescInstructions}`;
      } else {
        prompt += `\n\nDie Meta-Description sollte:\n- 150-160 Zeichen lang sein\n- Keywords enthalten\n- Zum Klicken anregen\n- Den Produktnutzen klar kommunizieren\n- Einen Call-to-Action enthalten`;
      }
      prompt += `\n\nGib nur die Meta-Description als reinen Text zurück, ohne HTML-Tags und ohne Erklärungen.`;
      generatedContent = await aiService.generateProductTitle(prompt);
    }

    // Update task to completed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ generatedContent, fieldType }),
      },
    });

    return json({ success: true, generatedContent, fieldType });
  } catch (error: any) {
    // Update task to failed
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

async function handleTranslateField(translationService: TranslationService, formData: FormData) {
  const fieldType = formData.get("fieldType") as string;
  const sourceText = formData.get("sourceText") as string;
  const targetLocale = formData.get("targetLocale") as string;

  try {
    const changedFields: any = {};
    changedFields[fieldType] = sourceText;

    const translations = await translationService.translateProduct(changedFields);
    const translatedValue = translations[targetLocale]?.[fieldType] || "";

    return json({ success: true, translatedValue, fieldType, targetLocale });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateSuggestion(translationService: TranslationService, formData: FormData) {
  const suggestion = formData.get("suggestion") as string;
  const fieldType = formData.get("fieldType") as string;

  try {
    const changedFields: any = {};
    changedFields[fieldType] = suggestion;

    const translations = await translationService.translateProduct(changedFields);

    return json({ success: true, translations, fieldType });
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleTranslateAll(
  admin: any,
  translationService: TranslationService,
  formData: FormData,
  productId: string,
  shop: string
) {
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const handle = formData.get("handle") as string;
  const seoTitle = formData.get("seoTitle") as string;
  const metaDescription = formData.get("metaDescription") as string;

  const { db } = await import("../db.server");

  // Create task entry
  const task = await db.task.create({
    data: {
      shop,
      type: "bulkTranslation",
      status: "running",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: title,
      fieldType: "all",
      progress: 0,
    },
  });

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

    // Update progress
    await db.task.update({
      where: { id: task.id },
      data: { progress: 20 },
    });

    const translations = await translationService.translateProduct(changedFields);
    const totalLocales = Object.keys(translations).length;
    let processedLocales = 0;

    // Update progress
    await db.task.update({
      where: { id: task.id },
      data: { progress: 40, total: totalLocales, processed: 0 },
    });

    // Save translations to Shopify for all non-primary locales
    for (const [locale, fields] of Object.entries(translations)) {
      const translationsInput = [];

      if (fields.title) translationsInput.push({ key: "title", value: fields.title, locale });
      if (fields.description) translationsInput.push({ key: "body_html", value: fields.description, locale });
      if (fields.handle) translationsInput.push({ key: "handle", value: fields.handle, locale });
      if (fields.seoTitle) translationsInput.push({ key: "seo_title", value: fields.seoTitle, locale });
      if (fields.metaDescription) translationsInput.push({ key: "seo_description", value: fields.metaDescription, locale });

      for (const translation of translationsInput) {
        await admin.graphql(
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
      }

      processedLocales++;
      // Update progress after each locale
      const progressPercent = Math.round(40 + (processedLocales / totalLocales) * 60);
      await db.task.update({
        where: { id: task.id },
        data: { progress: progressPercent, processed: processedLocales },
      });
    }

    // Mark task as completed
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ translations }),
      },
    });

    return json({ success: true, translations });
  } catch (error: any) {
    // Mark task as failed
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

async function handleUpdateProduct(admin: any, formData: FormData, productId: string) {
  const locale = formData.get("locale") as string;
  const title = formData.get("title") as string;
  const descriptionHtml = formData.get("descriptionHtml") as string;
  const handle = formData.get("handle") as string;
  const seoTitle = formData.get("seoTitle") as string;
  const metaDescription = formData.get("metaDescription") as string;

  try {
    if (locale !== formData.get("primaryLocale")) {
      const translationsInput = [];
      if (title) translationsInput.push({ key: "title", value: title, locale });
      if (descriptionHtml) translationsInput.push({ key: "body_html", value: descriptionHtml, locale });
      if (handle) translationsInput.push({ key: "handle", value: handle, locale });
      if (seoTitle) translationsInput.push({ key: "seo_title", value: seoTitle, locale });
      if (metaDescription) translationsInput.push({ key: "seo_description", value: metaDescription, locale });

      for (const translation of translationsInput) {
        await admin.graphql(
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
      }

      return json({ success: true });
    } else {
      const response = await admin.graphql(
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

      return json({ success: true, product: data.data.productUpdate.product });
    }
  } catch (error: any) {
    return json({ success: false, error: error.message }, { status: 500 });
  }
}

import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { SeoSidebar } from "../components/SeoSidebar";
import { ProductList } from "../components/products/ProductList";
import { ProductEditor } from "../components/products/ProductEditor";
import { ApiKeyWarningBanner } from "../components/ApiKeyWarningBanner";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useProductFields } from "../hooks/useProductFields";
import { useAISuggestions } from "../hooks/useAISuggestions";
import { handleProductActions } from "../actions/product.actions";

/**
 * Fetch and store image alt-text translations from Shopify
 */
async function fetchAndStoreImageTranslations(
  admin: any,
  db: any,
  product: any,
  locales: any[]
) {
  // Step 1: Fetch product with media IDs
  const productResponse = await admin.graphql(
    `#graphql
      query getProductMedia($id: ID!) {
        product(id: $id) {
          media(first: 250) {
            edges {
              node {
                ... on MediaImage {
                  id
                  alt
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }`,
    { variables: { id: product.id } }
  );

  const productData = await productResponse.json();
  const mediaEdges = productData.data?.product?.media?.edges || [];

  if (mediaEdges.length === 0) {
    console.log(`[IMAGE-TRANSLATIONS] No media found for product ${product.id}`);
    return;
  }

  // Step 2: Update images with mediaId
  for (let i = 0; i < mediaEdges.length && i < product.images.length; i++) {
    const mediaNode = mediaEdges[i].node;
    const dbImage = product.images[i];

    if (mediaNode && dbImage && !dbImage.mediaId) {
      await db.productImage.update({
        where: { id: dbImage.id },
        data: { mediaId: mediaNode.id },
      });
    }
  }

  // Step 3: Fetch alt-text translations for all images at once per locale
  const mediaIds = mediaEdges.map((edge: any) => edge.node.id).filter(Boolean);

  if (mediaIds.length === 0) return;

  for (const locale of locales) {
    if (!locale.published) continue;

    console.log(`[IMAGE-TRANSLATIONS] Fetching image translations for locale: ${locale.locale}`);

    try {
      const translationsResponse = await admin.graphql(
        `#graphql
          query getImageTranslations($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on MediaImage {
                id
                translations(locale: "${locale.locale}") {
                  key
                  value
                  locale
                }
              }
            }
          }`,
        { variables: { ids: mediaIds } }
      );

      const translationsData = await translationsResponse.json();
      const nodes = translationsData.data?.nodes || [];

      // Step 4: Store translations in database
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node) continue;

        const dbImage = product.images.find((img: any) => img.mediaId === node.id);
        if (!dbImage) continue;

        // Find the translated alt-text
        const translation = node.translations?.find((t: any) => t.key === "alt");
        if (translation && translation.value) {
          // Check if translation already exists
          const existing = await db.productImageAltTranslation.findUnique({
            where: {
              imageId_locale: {
                imageId: dbImage.id,
                locale: locale.locale,
              },
            },
          });

          if (!existing) {
            await db.productImageAltTranslation.create({
              data: {
                imageId: dbImage.id,
                locale: locale.locale,
                altText: translation.value,
              },
            });
            console.log(`[IMAGE-TRANSLATIONS] Stored translation for image ${i} in ${locale.locale}`);
          }
        }
      }
    } catch (error) {
      console.error(`[IMAGE-TRANSLATIONS] Error fetching translations for ${locale.locale}:`, error);
    }
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  console.log("[LOADER] Loading products from DATABASE for shop:", session.shop);

  try {
    const { db } = await import("../db.server");
    const { getPlanLimits } = await import("../utils/planUtils");

    // Load plan settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    console.log("[LOADER] Current plan:", plan);
    console.log("[LOADER] Max products:", planLimits.maxProducts);

    // 1. Fetch shop locales (still from Shopify, as this changes rarely)
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data.shopLocales;
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    console.log("[LOADER] Primary locale:", primaryLocale);
    console.log("[LOADER] Available locales:", shopLocales.length);

    // 2. Fetch products from DATABASE with plan-based limit
    const takeLimit = planLimits.maxProducts === Infinity ? 50 : Math.min(planLimits.maxProducts, 50);

    const dbProducts = await db.product.findMany({
      where: {
        shop: session.shop,
      },
      include: {
        translations: true,
        images: planLimits.cacheEnabled.productImages ? {
          include: {
            altTextTranslations: true,
          },
        } : false, // Don't load images if not cached in free plan
        options: planLimits.cacheEnabled.productOptions,
        metafields: planLimits.cacheEnabled.productMetafields,
      },
      orderBy: {
        title: "asc",
      },
      take: takeLimit,
    });

    console.log("[LOADER] Loaded", dbProducts.length, "products from database (limit:", takeLimit, ")");

    // 3. Transform to frontend format
    const products = dbProducts.map((p) => ({
      id: p.id,
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      handle: p.handle,
      status: p.status,
      featuredImage: {
        url: p.featuredImageUrl,
        altText: p.featuredImageAlt,
      },
      images: p.images ? p.images.map((img: any) => ({
        url: img.url,
        altText: img.altText,
        altTextTranslations: img.altTextTranslations ? img.altTextTranslations.map((t: any) => ({
          locale: t.locale,
          altText: t.altText,
        })) : [],
      })) : [],
      seo: {
        title: p.seoTitle,
        description: p.seoDescription,
      },
      options: p.options ? p.options.map((opt) => ({
        id: opt.id,
        name: opt.name,
        position: opt.position,
        values: JSON.parse(opt.values),
      })) : [],
      metafields: p.metafields ? p.metafields.map((mf) => ({
        id: mf.id,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
        type: mf.type,
      })) : [],
      // IMPORTANT: All translations are already loaded!
      translations: p.translations.map((t) => ({
        key: t.key,
        value: t.value,
        locale: t.locale,
      })),
    }));

    console.log("[LOADER] Total translations loaded:", products.reduce((sum, p) => sum + p.translations.length, 0));

    // Load AI settings for API key validation
    const aiSettingsForValidation = {
      huggingfaceApiKey: settings?.huggingfaceApiKey || null,
      geminiApiKey: settings?.geminiApiKey || null,
      claudeApiKey: settings?.claudeApiKey || null,
      openaiApiKey: settings?.openaiApiKey || null,
      grokApiKey: settings?.grokApiKey || null,
      deepseekApiKey: settings?.deepseekApiKey || null,
      preferredProvider: settings?.preferredProvider || null,
    };

    return json({
      products,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      plan,
      maxProducts: planLimits.maxProducts,
      productCount: dbProducts.length,
      aiSettings: aiSettingsForValidation,
    });
  } catch (error: any) {
    console.error("[LOADER] Error:", error);
    return json(
      {
        products: [],
        shop: session.shop,
        shopLocales: [],
        primaryLocale: "de",
        error: error.message,
        plan: "basic",
        maxProducts: 100,
        productCount: 0,
        aiSettings: {
          huggingfaceApiKey: null,
          geminiApiKey: null,
          claudeApiKey: null,
          openaiApiKey: null,
          grokApiKey: null,
          deepseekApiKey: null,
          preferredProvider: null,
        },
      },
      { status: 500 }
    );
  }
};

export const action = async (args: ActionFunctionArgs) => {
  return handleProductActions(args);
};

export default function Products() {
  const { products, shop, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t, locale } = useI18n();
  const { showInfoBox } = useInfoBox();

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [optionTranslations, setOptionTranslations] = useState<Record<string, { name: string; values: string[] }>>({});
  const [imageAltTexts, setImageAltTexts] = useState<Record<number, string>>({});
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(
    shopLocales.map((l: any) => l.locale)
  );

  const selectedProduct = products.find((p: any) => p.id === selectedProductId);

  const {
    editableTitle,
    setEditableTitle,
    editableDescription,
    setEditableDescription,
    editableHandle,
    setEditableHandle,
    editableSeoTitle,
    setEditableSeoTitle,
    editableMetaDescription,
    setEditableMetaDescription,
    hasChanges,
    getFieldBackgroundColor,
  } = useProductFields({
    selectedProduct,
    currentLanguage,
    primaryLocale,
    imageAltTexts,
  });

  const { aiSuggestions, removeSuggestion } = useAISuggestions(fetcher.data);

  // Auto-refresh: Reload data when actions complete successfully
  // This ensures that webhook updates in the background are reflected in the UI
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // Check if this is a "translateAll" response (which saves to Shopify)
      const isTranslateAll = 'translations' in fetcher.data &&
                            !('locale' in fetcher.data) &&
                            !('fieldType' in fetcher.data);

      // Don't reload for AI suggestions or single field translations (they're just displayed, not saved yet)
      if ('generatedContent' in fetcher.data ||
          ('translatedValue' in fetcher.data && !isTranslateAll) ||
          ('translatedName' in fetcher.data) || // Option translations
          ('altText' in fetcher.data) || // Single alt-text generation
          ('generatedAltTexts' in fetcher.data)) { // Bulk alt-text generation
        return; // Skip reload for suggestions
      }

      console.log('[AUTO-REFRESH] Reloading product data from database after save operation');
      // Longer delay to ensure:
      // 1. Shopify has processed the update
      // 2. Webhook has been triggered (if registered)
      // 3. Database transaction is complete
      setTimeout(() => {
        revalidator.revalidate();
      }, 1500);
    }
  }, [fetcher.state, fetcher.data]);

  // Handle language change (no more loading needed - all translations pre-loaded!)
  const handleLanguageChange = (newLanguage: string) => {
    console.log('[LANGUAGE-CHANGE] Switching to:', newLanguage);
    setCurrentLanguage(newLanguage);
    // That's it! All translations are already in the product object from the loader
  };

  // Handle language toggle (Ctrl+Click on language button)
  const handleToggleLanguage = (locale: string) => {
    // Don't allow disabling the primary locale
    if (locale === primaryLocale) return;

    setEnabledLanguages((prev) => {
      if (prev.includes(locale)) {
        // Disable this language
        return prev.filter((l) => l !== locale);
      } else {
        // Enable this language
        return [...prev, locale];
      }
    });
  };

  // Handle translated field response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data) {
      const { fieldType, translatedValue } = fetcher.data as any;
      const setters: Record<string, (value: string) => void> = {
        title: setEditableTitle,
        description: setEditableDescription,
        handle: setEditableHandle,
        seoTitle: setEditableSeoTitle,
        metaDescription: setEditableMetaDescription,
      };
      setters[fieldType]?.(translatedValue);
    }
  }, [fetcher.data]);

  // Handle "translateAll" response
  useEffect(() => {
    if (
      fetcher.data?.success &&
      'translations' in fetcher.data &&
      !('locale' in fetcher.data) &&
      !('fieldType' in fetcher.data)
    ) {
      const translations = (fetcher.data as any).translations as Record<string, {
        title?: string;
        description?: string;
        handle?: string;
        seoTitle?: string;
        metaDescription?: string;
      }>;
      if (selectedProduct) {
        for (const [locale, fields] of Object.entries(translations)) {
          const newTranslations = [];
          if (fields.title) newTranslations.push({ key: "title", value: fields.title, locale });
          if (fields.description) newTranslations.push({ key: "body_html", value: fields.description, locale });
          if (fields.handle) newTranslations.push({ key: "handle", value: fields.handle, locale });
          if (fields.seoTitle) newTranslations.push({ key: "meta_title", value: fields.seoTitle, locale });
          if (fields.metaDescription) newTranslations.push({ key: "meta_description", value: fields.metaDescription, locale });

          // Store directly in product translations
          selectedProduct.translations = [
            ...selectedProduct.translations.filter((t: any) => t.locale !== locale),
            ...newTranslations
          ];

          // If we're currently viewing this locale, update the editable fields
          if (currentLanguage === locale) {
            if (fields.title) setEditableTitle(fields.title);
            if (fields.description) setEditableDescription(fields.description);
            if (fields.handle) setEditableHandle(fields.handle);
            if (fields.seoTitle) setEditableSeoTitle(fields.seoTitle);
            if (fields.metaDescription) setEditableMetaDescription(fields.metaDescription);
          }
        }
      }
    }
  }, [fetcher.data, currentLanguage]);

  // Update translations in product object after saving
  useEffect(() => {
    if (fetcher.data?.success &&
        !('translations' in fetcher.data) &&
        !('generatedContent' in fetcher.data) &&
        !('translatedValue' in fetcher.data) &&
        !('translatedName' in fetcher.data) &&
        selectedProduct &&
        currentLanguage !== primaryLocale) {
      // This was a successful updateProduct action for a translation
      const existingTranslations = selectedProduct.translations.filter((t: any) => t.locale !== currentLanguage);

      // Add new translations
      if (editableTitle) existingTranslations.push({ key: "title", value: editableTitle, locale: currentLanguage });
      if (editableDescription) existingTranslations.push({ key: "body_html", value: editableDescription, locale: currentLanguage });
      if (editableHandle) existingTranslations.push({ key: "handle", value: editableHandle, locale: currentLanguage });
      if (editableSeoTitle) existingTranslations.push({ key: "meta_title", value: editableSeoTitle, locale: currentLanguage });
      if (editableMetaDescription) existingTranslations.push({ key: "meta_description", value: editableMetaDescription, locale: currentLanguage });

      selectedProduct.translations = existingTranslations;
    }
  }, [fetcher.data]);

  // Handle translated option response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedName' in fetcher.data && 'translatedValues' in fetcher.data) {
      const { optionId, translatedName, translatedValues } = fetcher.data as any;
      setOptionTranslations(prev => ({
        ...prev,
        [optionId]: {
          name: translatedName,
          values: translatedValues
        }
      }));
    }
  }, [fetcher.data]);

  // Handle bulk alt-text generation - auto-accept all suggestions
  useEffect(() => {
    if (fetcher.data?.success && 'generatedAltTexts' in fetcher.data) {
      const { generatedAltTexts } = fetcher.data as any;
      console.log('[ALT-TEXT] Auto-accepting bulk generated alt-texts:', generatedAltTexts);
      // Automatically accept all generated alt-texts
      setImageAltTexts(prev => ({
        ...prev,
        ...generatedAltTexts
      }));
    }
  }, [fetcher.data]);

  // Handle translated alt-text response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedAltText' in fetcher.data) {
      const { translatedAltText, imageIndex } = fetcher.data as any;
      console.log('[ALT-TEXT] Setting translated alt-text for image', imageIndex, ':', translatedAltText);
      setImageAltTexts(prev => ({
        ...prev,
        [imageIndex]: translatedAltText
      }));
    }
  }, [fetcher.data]);

  // Show global InfoBox for success/error messages
  useEffect(() => {
    if (fetcher.data?.success &&
        !(fetcher.data as any).generatedContent &&
        !(fetcher.data as any).translatedValue &&
        !(fetcher.data as any).translatedName &&
        !(fetcher.data as any).altText &&
        !(fetcher.data as any).generatedAltTexts) {
      showInfoBox(t.common?.changesSaved || "Changes saved successfully!", "success", t.common?.success || "Success");
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.common?.error || "Error");
    }
  }, [fetcher.data, showInfoBox]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.common?.error || "Error");
    }
  }, [error, showInfoBox]);

  // Reset alt-text state when product changes
  useEffect(() => {
    setImageAltTexts({});
  }, [selectedProductId]);

  // Load translated alt-texts when language changes
  useEffect(() => {
    if (!selectedProduct || !selectedProduct.images) return;

    if (currentLanguage === primaryLocale) {
      // Reset to primary locale alt-texts
      setImageAltTexts({});
    } else {
      // Load translated alt-texts from DB
      const translatedAltTexts: Record<number, string> = {};
      selectedProduct.images.forEach((img: any, index: number) => {
        const translation = img.altTextTranslations?.find(
          (t: any) => t.locale === currentLanguage
        );
        if (translation) {
          translatedAltTexts[index] = translation.altText;
        }
      });
      setImageAltTexts(translatedAltTexts);
    }
  }, [currentLanguage, selectedProductId, primaryLocale]);

  const handleSaveProduct = () => {
    if (!selectedProductId || !hasChanges) return;
    fetcher.submit(
      {
        action: "updateProduct",
        productId: selectedProductId,
        locale: currentLanguage,
        primaryLocale,
        title: editableTitle,
        descriptionHtml: editableDescription,
        handle: editableHandle,
        seoTitle: editableSeoTitle,
        metaDescription: editableMetaDescription,
        imageAltTexts: JSON.stringify(imageAltTexts),
      },
      { method: "POST" }
    );
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedProductId) return;
    const currentValue = { title: editableTitle, description: editableDescription, handle: editableHandle, seoTitle: editableSeoTitle, metaDescription: editableMetaDescription }[fieldType] || "";
    fetcher.submit(
      { action: "generateAIText", productId: selectedProductId, fieldType, currentValue, contextTitle: editableTitle, contextDescription: editableDescription },
      { method: "POST" }
    );
  };

  const handleFormatAI = (fieldType: string) => {
    if (!selectedProductId) return;
    const currentValue = { title: editableTitle, description: editableDescription, handle: editableHandle, seoTitle: editableSeoTitle, metaDescription: editableMetaDescription }[fieldType] || "";
    if (!currentValue) {
      showInfoBox("Kein Inhalt zum Formatieren vorhanden", "warning", "Warnung");
      return;
    }
    fetcher.submit(
      { action: "formatAIText", productId: selectedProductId, fieldType, currentValue, contextTitle: editableTitle, contextDescription: editableDescription },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedProductId || !selectedProduct) return;
    const sourceMap: Record<string, string> = {
      title: selectedProduct.title,
      description: selectedProduct.descriptionHtml || "",
      handle: selectedProduct.handle,
      seoTitle: selectedProduct.seo?.title || "",
      metaDescription: selectedProduct.seo?.description || "",
    };
    const sourceText = sourceMap[fieldType] || "";
    if (!sourceText) {
      alert("Kein Text in der Hauptsprache vorhanden zum Übersetzen");
      return;
    }
    fetcher.submit(
      { action: "translateField", productId: selectedProductId, fieldType, sourceText, targetLocale: currentLanguage },
      { method: "POST" }
    );
  };

  const handleTranslateFieldToAllLocales = (fieldType: string) => {
    if (!selectedProductId || !selectedProduct) return;
    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox("Keine Zielsprachen ausgewählt", "warning", "Warnung");
      return;
    }
    const sourceMap: Record<string, string> = {
      title: selectedProduct.title,
      description: selectedProduct.descriptionHtml || "",
      handle: selectedProduct.handle,
      seoTitle: selectedProduct.seo?.title || "",
      metaDescription: selectedProduct.seo?.description || "",
    };
    const sourceText = sourceMap[fieldType] || "";
    if (!sourceText) {
      alert("Kein Text in der Hauptsprache vorhanden zum Übersetzen");
      return;
    }
    fetcher.submit(
      { action: "translateFieldToAllLocales", productId: selectedProductId, fieldType, sourceText, targetLocales: JSON.stringify(targetLocales) },
      { method: "POST" }
    );
  };

  const handleAcceptSuggestion = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;
    const setters: Record<string, (value: string) => void> = {
      title: setEditableTitle,
      description: setEditableDescription,
      handle: setEditableHandle,
      seoTitle: setEditableSeoTitle,
      metaDescription: setEditableMetaDescription,
    };
    setters[fieldType]?.(suggestion);
    removeSuggestion(fieldType);
  };

  const handleAcceptAndTranslate = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;
    handleAcceptSuggestion(fieldType);
    fetcher.submit({ action: "translateSuggestion", suggestion, fieldType }, { method: "POST" });
  };

  const handleDiscardChanges = () => {
    if (!selectedProduct) return;

    if (currentLanguage === primaryLocale) {
      setEditableTitle(selectedProduct.title);
      setEditableDescription(selectedProduct.descriptionHtml || "");
      setEditableHandle(selectedProduct.handle);
      setEditableSeoTitle(selectedProduct.seo?.title || "");
      setEditableMetaDescription(selectedProduct.seo?.description || "");
    } else {
      const getTranslation = (key: string) => {
        return selectedProduct.translations.find((t: any) => t.key === key && t.locale === currentLanguage)?.value || "";
      };
      setEditableTitle(getTranslation("title"));
      setEditableDescription(getTranslation("body_html"));
      setEditableHandle(getTranslation("handle"));
      setEditableSeoTitle(getTranslation("meta_title"));
      setEditableMetaDescription(getTranslation("meta_description"));
    }
    setImageAltTexts({});
  };

  const handleTranslateAll = () => {
    if (!selectedProductId || !selectedProduct) return;
    // Filter out primary locale and disabled languages
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) {
      showInfoBox("Keine Zielsprachen ausgewählt", "warning", "Warnung");
      return;
    }
    // Always use the primary locale values (original product data), not the current editable values
    fetcher.submit(
      {
        action: "translateAll",
        productId: selectedProductId,
        title: selectedProduct.title,
        description: selectedProduct.descriptionHtml || "",
        handle: selectedProduct.handle,
        seoTitle: selectedProduct.seo?.title || "",
        metaDescription: selectedProduct.seo?.description || "",
        targetLocales: JSON.stringify(targetLocales),
      },
      { method: "POST" }
    );
  };

  // Product Options Handlers
  const handleOptionNameChange = (optionId: string, value: string) => {
    setOptionTranslations(prev => ({
      ...prev,
      [optionId]: {
        ...prev[optionId],
        name: value,
        values: prev[optionId]?.values || []
      }
    }));
  };

  const handleOptionValueChange = (optionId: string, valueIndex: number, value: string) => {
    setOptionTranslations(prev => {
      const option = prev[optionId] || { name: "", values: [] };
      const newValues = [...option.values];
      newValues[valueIndex] = value;
      return {
        ...prev,
        [optionId]: {
          ...option,
          values: newValues
        }
      };
    });
  };

  const handleTranslateOption = (optionId: string) => {
    if (!selectedProduct) return;
    const option = selectedProduct.options?.find((opt: any) => opt.id === optionId);
    if (!option) return;

    fetcher.submit(
      {
        action: "translateOption",
        productId: selectedProduct.id,
        optionId,
        optionName: option.name,
        optionValues: JSON.stringify(option.values),
        targetLocale: currentLanguage,
      },
      { method: "POST" }
    );
  };

  const handleGenerateAltText = (imageIndex: number) => {
    if (!selectedProduct || !selectedProduct.images || !selectedProduct.images[imageIndex]) return;

    fetcher.submit(
      {
        action: "generateAltText",
        productId: selectedProduct.id,
        imageIndex: imageIndex.toString(),
        imageUrl: selectedProduct.images[imageIndex].url,
        productTitle: selectedProduct.title,
      },
      { method: "POST" }
    );
  };

  const handleGenerateAllAltTexts = () => {
    if (!selectedProduct || !selectedProduct.images || selectedProduct.images.length === 0) return;

    fetcher.submit(
      {
        action: "generateAllAltTexts",
        productId: selectedProduct.id,
        imagesData: JSON.stringify(selectedProduct.images),
        productTitle: selectedProduct.title,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAltText = (imageIndex: number) => {
    if (!selectedProduct || !selectedProduct.images || !selectedProduct.images[imageIndex]) return;

    // Get the source alt-text from the primary locale (original product data)
    const sourceAltText = selectedProduct.images[imageIndex].altText;

    if (!sourceAltText) {
      alert("Kein Alt-Text in der Hauptsprache vorhanden zum Übersetzen");
      return;
    }

    fetcher.submit(
      {
        action: "translateAltText",
        productId: selectedProduct.id,
        imageIndex: imageIndex.toString(),
        sourceAltText,
        targetLocale: currentLanguage,
      },
      { method: "POST" }
    );
  };

  return (
    <Page fullWidth>
      <style>{`
        .description-editor h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; }
        .description-editor h2 { font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
        .description-editor h3 { font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
        .description-editor p { margin: 1em 0; }
        .description-editor ul, .description-editor ol { margin: 1em 0; padding-left: 40px; }

        @keyframes pulse {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(255, 149, 0, 0.7);
          }
          50% {
            box-shadow: 0 0 20px 10px rgba(255, 149, 0, 0.3);
          }
        }

        @keyframes pulseBlue {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
          }
          50% {
            box-shadow: 0 0 20px 10px rgba(59, 130, 246, 0.3);
          }
        }
      `}</style>
      <MainNavigation />
      <ApiKeyWarningBanner aiSettings={aiSettings} t={t} />
      <div style={{ height: "calc(100vh - 60px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left: Product List (Fixed) */}
        <div style={{ width: "350px", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ProductList
            products={products}
            selectedProductId={selectedProductId}
            onProductSelect={setSelectedProductId}
            searchPlaceholder={t.products.search}
            countLabel={t.products.count}
            resourceName={t.products.resourceName}
            paginationOf={t.products.pagination.of}
            paginationPrevious={t.products.pagination.previous}
            paginationNext={t.products.pagination.next}
          />
        </div>

        {/* Middle: Product Editor */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          <ProductEditor
            product={selectedProduct}
            shopLocales={shopLocales}
            primaryLocale={primaryLocale}
            currentLanguage={currentLanguage}
            onLanguageChange={handleLanguageChange}
            enabledLanguages={enabledLanguages}
            onToggleLanguage={handleToggleLanguage}
            editableTitle={editableTitle}
            setEditableTitle={setEditableTitle}
            editableDescription={editableDescription}
            setEditableDescription={setEditableDescription}
            editableHandle={editableHandle}
            setEditableHandle={setEditableHandle}
            editableSeoTitle={editableSeoTitle}
            setEditableSeoTitle={setEditableSeoTitle}
            editableMetaDescription={editableMetaDescription}
            setEditableMetaDescription={setEditableMetaDescription}
            aiSuggestions={aiSuggestions}
            hasChanges={hasChanges}
            getFieldBackgroundColor={getFieldBackgroundColor}
            onSave={handleSaveProduct}
            onTranslateAll={handleTranslateAll}
            onGenerateAI={handleGenerateAI}
            onFormatAI={handleFormatAI}
            onTranslateField={handleTranslateField}
            onTranslateFieldToAllLocales={handleTranslateFieldToAllLocales}
            onAcceptSuggestion={handleAcceptSuggestion}
            onAcceptAndTranslate={handleAcceptAndTranslate}
            onRejectSuggestion={removeSuggestion}
            isLoading={fetcher.state !== "idle"}
            isSaving={fetcher.state !== "idle" && fetcher.formData?.get("action") === "updateProduct"}
            isTranslatingAll={fetcher.state !== "idle" && fetcher.formData?.get("action") === "translateAll"}
            fetcherFormData={fetcher.formData}
            showSuccessBanner={fetcher.data?.success && !(fetcher.data as any).generatedContent}
            selectProductText={t.products.selectProduct}
            optionTranslations={optionTranslations}
            onOptionNameChange={handleOptionNameChange}
            onOptionValueChange={handleOptionValueChange}
            onTranslateOption={handleTranslateOption}
            isTranslatingOption={fetcher.state !== "idle" && fetcher.formData?.get("action") === "translateOption"}
            translatingOptionId={fetcher.formData?.get("optionId")?.toString()}
            onGenerateAltText={handleGenerateAltText}
            onGenerateAllAltTexts={handleGenerateAllAltTexts}
            onTranslateAltText={handleTranslateAltText}
            fetcherData={fetcher.data}
            imageAltTexts={imageAltTexts}
            setImageAltTexts={setImageAltTexts}
            onDiscardChanges={handleDiscardChanges}
            fetcherState={fetcher.state}
          />
        </div>

        {/* Right: SEO Sidebar (Fixed) */}
        {selectedProduct && currentLanguage === primaryLocale && (
          <div style={{ width: "320px", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto" }}>
              <SeoSidebar
                title={editableTitle}
                description={editableDescription}
                handle={editableHandle}
                seoTitle={editableSeoTitle}
                metaDescription={editableMetaDescription}
                imagesWithAlt={
                  selectedProduct.images?.filter((img: any, index: number) => {
                    // Check if there's a new alt-text in state OR an existing alt-text
                    return imageAltTexts[index] || img.altText;
                  }).length || 0
                }
                totalImages={selectedProduct.images?.length || 0}
              />
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

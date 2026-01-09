import { useState, useRef, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Banner,
  Thumbnail,
  Icon,
  ButtonGroup,
} from "@shopify/polaris";
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { MainNavigation } from "../components/MainNavigation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Fetch shop locales
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

    // Fetch products
    const response = await admin.graphql(
      `#graphql
        query getProducts($first: Int!) {
          products(first: $first) {
            edges {
              node {
                id
                title
                handle
                status
                descriptionHtml
                featuredImage {
                  url
                  altText
                }
                seo {
                  title
                  description
                }
              }
            }
          }
        }`,
      { variables: { first: 50 } }
    );

    const data = await response.json();
    let products = data.data.products.edges.map((edge: any) => edge.node);

    // Initialize empty translations array for each product
    // We'll load translations on-demand when a product is selected to avoid slow page loads
    for (const product of products) {
      product.translations = [];
    }

    return json({
      products,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    return json({
      products: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
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

  if (action === "generateAIText") {
    const fieldType = formData.get("fieldType") as string;
    const currentValue = formData.get("currentValue") as string;
    const contextTitle = formData.get("contextTitle") as string;
    const contextDescription = formData.get("contextDescription") as string;

    try {
      let generatedContent = "";

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

      return json({ success: true, generatedContent, fieldType });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "translateField") {
    const fieldType = formData.get("fieldType") as string;
    const sourceText = formData.get("sourceText") as string;
    const targetLocale = formData.get("targetLocale") as string;

    try {
      // Translate single field to target locale
      const changedFields: any = {};
      changedFields[fieldType] = sourceText;

      const translations = await translationService.translateProduct(changedFields);

      // Extract translation for target locale
      const translatedValue = translations[targetLocale]?.[fieldType] || "";

      return json({ success: true, translatedValue, fieldType, targetLocale });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "translateSuggestion") {
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

  if (action === "translateAll") {
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;

    try {
      const changedFields: any = {};
      if (title) changedFields.title = title;
      if (description) changedFields.description = description;
      if (handle) changedFields.handle = handle;
      if (seoTitle) changedFields.seoTitle = seoTitle;
      if (metaDescription) changedFields.metaDescription = metaDescription;

      // If no fields have content, return error
      if (Object.keys(changedFields).length === 0) {
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      // Get translations for all locales
      const translations = await translationService.translateProduct(changedFields);

      // Save translations to Shopify for all non-primary locales
      for (const [locale, fields] of Object.entries(translations)) {
        const translationsInput = [];

        // Map field names to Shopify translation keys
        if (fields.title) translationsInput.push({ key: "title", value: fields.title, locale });
        if (fields.description) translationsInput.push({ key: "body_html", value: fields.description, locale });
        if (fields.handle) translationsInput.push({ key: "handle", value: fields.handle, locale });
        if (fields.seoTitle) translationsInput.push({ key: "seo_title", value: fields.seoTitle, locale });
        if (fields.metaDescription) translationsInput.push({ key: "seo_description", value: fields.metaDescription, locale });

        // Register all translations for this locale
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
      }

      return json({ success: true, translations });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "updateProduct") {
    const locale = formData.get("locale") as string;
    const title = formData.get("title") as string;
    const descriptionHtml = formData.get("descriptionHtml") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;

    try {
      // If it's not the primary locale, we need to use translations API
      if (locale !== formData.get("primaryLocale")) {
        const translationsInput = [];
        if (title) translationsInput.push({ key: "title", value: title, locale });
        if (descriptionHtml) translationsInput.push({ key: "body_html", value: descriptionHtml, locale });
        if (handle) translationsInput.push({ key: "handle", value: handle, locale });
        if (seoTitle) translationsInput.push({ key: "seo_title", value: seoTitle, locale });
        if (metaDescription) translationsInput.push({ key: "seo_description", value: metaDescription, locale });

        // Register translations
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
        // Update primary locale using productUpdate
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

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function Index() {
  const { products, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // State
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const productsPerPage = 10;

  // Editable fields
  const [editableTitle, setEditableTitle] = useState("");
  const [editableDescription, setEditableDescription] = useState("");
  const [editableHandle, setEditableHandle] = useState("");
  const [editableSeoTitle, setEditableSeoTitle] = useState("");
  const [editableMetaDescription, setEditableMetaDescription] = useState("");
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const descriptionEditorRef = useRef<HTMLDivElement>(null);

  // Filter and pagination
  const filteredProducts = products.filter((p: any) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  const startIndex = (currentPage - 1) * productsPerPage;
  const paginatedProducts = filteredProducts.slice(startIndex, startIndex + productsPerPage);

  const selectedProduct = products.find((p: any) => p.id === selectedProductId);

  // Helper function to get translated value
  const getTranslatedValue = (key: string, locale: string, fallback: string) => {
    if (!selectedProduct || locale === primaryLocale) {
      return fallback;
    }

    const translation = selectedProduct.translations?.find(
      (t: any) => t.key === key && t.locale === locale
    );

    return translation?.value || "";
  };

  // Load product data when product or language changes
  useEffect(() => {
    if (selectedProduct) {
      if (currentLanguage === primaryLocale) {
        setEditableTitle(selectedProduct.title);
        setEditableDescription(selectedProduct.descriptionHtml || "");
        setEditableHandle(selectedProduct.handle);
        setEditableSeoTitle(selectedProduct.seo?.title || "");
        setEditableMetaDescription(selectedProduct.seo?.description || "");
      } else {
        // Check if translations for this locale are already loaded
        const hasTranslations = selectedProduct.translations?.some(
          (t: any) => t.locale === currentLanguage
        );

        if (!hasTranslations) {
          // Load translations for this locale
          fetcher.submit(
            {
              action: "loadTranslations",
              productId: selectedProduct.id,
              locale: currentLanguage,
            },
            { method: "POST" }
          );
        }

        setEditableTitle(getTranslatedValue("title", currentLanguage, ""));
        setEditableDescription(getTranslatedValue("body_html", currentLanguage, ""));
        setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
        setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
        setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
      }
      setHasChanges(false);
    }
  }, [selectedProductId, currentLanguage]);

  // Handle loaded translations
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const loadedLocale = (fetcher.data as any).locale;
      const loadedTranslations = (fetcher.data as any).translations;

      // Update the product with new translations
      if (selectedProduct && loadedLocale) {
        selectedProduct.translations = [
          ...selectedProduct.translations.filter((t: any) => t.locale !== loadedLocale),
          ...loadedTranslations
        ];

        // Update fields if this is the current language
        if (loadedLocale === currentLanguage) {
          setEditableTitle(getTranslatedValue("title", currentLanguage, ""));
          setEditableDescription(getTranslatedValue("body_html", currentLanguage, ""));
          setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
          setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
          setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
        }
      }
    }
  }, [fetcher.data]);

  // Track changes
  useEffect(() => {
    if (selectedProduct) {
      const getOriginalValue = (key: string, fallback: string) => {
        if (currentLanguage === primaryLocale) {
          return fallback;
        }
        return getTranslatedValue(key, currentLanguage, "");
      };

      const titleChanged = editableTitle !== getOriginalValue("title", selectedProduct.title);
      const descChanged = editableDescription !== getOriginalValue("body_html", selectedProduct.descriptionHtml || "");
      const handleChanged = editableHandle !== getOriginalValue("handle", selectedProduct.handle);
      const seoTitleChanged = editableSeoTitle !== getOriginalValue("seo_title", selectedProduct.seo?.title || "");
      const metaDescChanged = editableMetaDescription !== getOriginalValue("seo_description", selectedProduct.seo?.description || "");

      setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
    }
  }, [editableTitle, editableDescription, editableHandle, editableSeoTitle, editableMetaDescription, selectedProduct, currentLanguage]);

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
      },
      { method: "POST" }
    );
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedProductId) return;

    const currentValue = {
      title: editableTitle,
      description: editableDescription,
      handle: editableHandle,
      seoTitle: editableSeoTitle,
      metaDescription: editableMetaDescription,
    }[fieldType] || "";

    fetcher.submit(
      {
        action: "generateAIText",
        productId: selectedProductId,
        fieldType,
        currentValue,
        contextTitle: editableTitle,
        contextDescription: editableDescription,
      },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedProductId || !selectedProduct) return;

    // Get source text from primary locale
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
      {
        action: "translateField",
        productId: selectedProductId,
        fieldType,
        sourceText,
        targetLocale: currentLanguage,
      },
      { method: "POST" }
    );
  };

  const handleAcceptSuggestion = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;

    switch (fieldType) {
      case "title":
        setEditableTitle(suggestion);
        break;
      case "description":
        setEditableDescription(suggestion);
        break;
      case "handle":
        setEditableHandle(suggestion);
        break;
      case "seoTitle":
        setEditableSeoTitle(suggestion);
        break;
      case "metaDescription":
        setEditableMetaDescription(suggestion);
        break;
    }

    setAiSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldType];
      return newSuggestions;
    });
  };

  const handleAcceptAndTranslate = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;

    // First accept the suggestion
    handleAcceptSuggestion(fieldType);

    // Then trigger translation
    fetcher.submit(
      {
        action: "translateSuggestion",
        suggestion,
        fieldType,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedProductId) return;

    // Use current editable field values (including AI-generated or manually edited content)
    // This translates the current working state, not the saved product data
    fetcher.submit(
      {
        action: "translateAll",
        productId: selectedProductId,
        title: editableTitle,
        description: editableDescription,
        handle: editableHandle,
        seoTitle: editableSeoTitle,
        metaDescription: editableMetaDescription,
      },
      { method: "POST" }
    );
  };

  const handleFormatText = (command: string) => {
    if (descriptionMode !== "rendered" || !descriptionEditorRef.current) return;

    descriptionEditorRef.current.focus();

    switch (command) {
      case "bold":
        document.execCommand("bold", false);
        break;
      case "italic":
        document.execCommand("italic", false);
        break;
      case "underline":
        document.execCommand("underline", false);
        break;
      case "h1":
        document.execCommand("formatBlock", false, "<h1>");
        break;
      case "h2":
        document.execCommand("formatBlock", false, "<h2>");
        break;
      case "h3":
        document.execCommand("formatBlock", false, "<h3>");
        break;
      case "p":
        document.execCommand("formatBlock", false, "<p>");
        break;
      case "ul":
        document.execCommand("insertUnorderedList", false);
        break;
      case "ol":
        document.execCommand("insertOrderedList", false);
        break;
      case "br":
        document.execCommand("insertHTML", false, "<br>");
        break;
    }

    setEditableDescription(descriptionEditorRef.current.innerHTML);
  };

  const toggleDescriptionMode = () => {
    setDescriptionMode(descriptionMode === "html" ? "rendered" : "html");
  };

  // Handle AI generation response
  useEffect(() => {
    if (fetcher.data?.success && (fetcher.data as any).generatedContent) {
      const fieldType = (fetcher.data as any).fieldType;
      setAiSuggestions(prev => ({
        ...prev,
        [fieldType]: (fetcher.data as any).generatedContent,
      }));
    }
  }, [fetcher.data]);

  // Handle translated field response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data) {
      const fieldType = (fetcher.data as any).fieldType;
      const translatedValue = (fetcher.data as any).translatedValue;

      // Directly set the translated value in the field
      switch (fieldType) {
        case "title":
          setEditableTitle(translatedValue);
          break;
        case "description":
          setEditableDescription(translatedValue);
          break;
        case "handle":
          setEditableHandle(translatedValue);
          break;
        case "seoTitle":
          setEditableSeoTitle(translatedValue);
          break;
        case "metaDescription":
          setEditableMetaDescription(translatedValue);
          break;
      }
    }
  }, [fetcher.data]);

  // Handle "translateAll" response - update product translations in local state
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && !('locale' in fetcher.data) && !('fieldType' in fetcher.data)) {
      const translations = (fetcher.data as any).translations;

      // This is a "translateAll" response - update all translations in the product
      if (selectedProduct) {
        // Convert translations object to Shopify translation format
        for (const [locale, fields] of Object.entries(translations)) {
          const newTranslations = [];

          if (fields.title) newTranslations.push({ key: "title", value: fields.title, locale });
          if (fields.description) newTranslations.push({ key: "body_html", value: fields.description, locale });
          if (fields.handle) newTranslations.push({ key: "handle", value: fields.handle, locale });
          if (fields.seoTitle) newTranslations.push({ key: "seo_title", value: fields.seoTitle, locale });
          if (fields.metaDescription) newTranslations.push({ key: "seo_description", value: fields.metaDescription, locale });

          // Update product translations for this locale
          selectedProduct.translations = [
            ...selectedProduct.translations.filter((t: any) => t.locale !== locale),
            ...newTranslations
          ];
        }

        // If currently viewing a non-primary locale, refresh the fields
        if (currentLanguage !== primaryLocale) {
          setEditableTitle(getTranslatedValue("title", currentLanguage, ""));
          setEditableDescription(getTranslatedValue("body_html", currentLanguage, ""));
          setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
          setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
          setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
        }
      }
    }
  }, [fetcher.data]);

  // Check if field is translated
  const isFieldTranslated = (key: string) => {
    if (currentLanguage === primaryLocale) return true;
    if (!selectedProduct) return false;

    const translation = selectedProduct.translations?.find(
      (t: any) => t.key === key && t.locale === currentLanguage
    );

    return !!translation && !!translation.value;
  };

  const getFieldBackgroundColor = (key: string) => {
    if (currentLanguage === primaryLocale) return "white";
    return isFieldTranslated(key) ? "white" : "#fff4e5";
  };

  return (
    <Page fullWidth>
      <style>{`
        .description-editor h1 {
          font-size: 2em;
          font-weight: bold;
          margin: 0.67em 0;
        }
        .description-editor h2 {
          font-size: 1.5em;
          font-weight: bold;
          margin: 0.75em 0;
        }
        .description-editor h3 {
          font-size: 1.17em;
          font-weight: bold;
          margin: 0.83em 0;
        }
        .description-editor p {
          margin: 1em 0;
        }
        .description-editor ul, .description-editor ol {
          margin: 1em 0;
          padding-left: 40px;
        }
      `}</style>
      <MainNavigation />
      <div style={{ height: "calc(100vh - 60px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left: Product List */}
        <div style={{ width: "350px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Produkte ({filteredProducts.length})</Text>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                    <Icon source={SearchIcon} />
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setCurrentPage(1);
                    }}
                    placeholder="Produkte suchen..."
                    style={{
                      width: "100%",
                      padding: "8px 12px 8px 36px",
                      border: "1px solid #babfc3",
                      borderRadius: "8px",
                      fontSize: "14px",
                    }}
                  />
                </div>
              </BlockStack>
            </div>

            <div style={{ maxHeight: "calc(100vh - 250px)", overflowY: "auto" }}>
              <ResourceList
                resourceName={{ singular: "Produkt", plural: "Produkte" }}
                items={paginatedProducts}
                renderItem={(item: any) => {
                  const { id, title, featuredImage, status } = item;
                  const isSelected = selectedProductId === id;

                  return (
                    <ResourceItem
                      id={id}
                      onClick={() => setSelectedProductId(id)}
                      media={
                        featuredImage ? (
                          <Thumbnail source={featuredImage.url} alt={featuredImage.altText || title} size="small" />
                        ) : undefined
                      }
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>{title}</Text>
                        <Badge tone={status === "ACTIVE" ? "success" : undefined}>{status}</Badge>
                      </BlockStack>
                    </ResourceItem>
                  );
                }}
              />
            </div>

            {totalPages > 1 && (
              <div style={{ padding: "1rem", borderTop: "1px solid #e1e3e5" }}>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {startIndex + 1}-{Math.min(startIndex + productsPerPage, filteredProducts.length)} von {filteredProducts.length}
                  </Text>
                  <InlineStack gap="200">
                    <Button icon={ChevronLeftIcon} onClick={() => setCurrentPage(currentPage - 1)} disabled={currentPage === 1} accessibilityLabel="Vorherige Seite" />
                    <Text as="span" variant="bodySm">{currentPage} / {totalPages}</Text>
                    <Button icon={ChevronRightIcon} onClick={() => setCurrentPage(currentPage + 1)} disabled={currentPage === totalPages} accessibilityLabel="Nächste Seite" />
                  </InlineStack>
                </InlineStack>
              </div>
            )}
          </Card>
        </div>

        {/* Right: Product Detail */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Fehler" tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          {fetcher.data?.success && !(fetcher.data as any).generatedContent && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Erfolg!" tone="success" onDismiss={() => {}}>
                <p>Änderungen erfolgreich gespeichert!</p>
              </Banner>
            </div>
          )}

          <Card padding="600">
            {selectedProduct ? (
              <BlockStack gap="500">
                {/* Language Selector */}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {shopLocales.map((locale: any) => (
                    <Button
                      key={locale.locale}
                      variant={currentLanguage === locale.locale ? "primary" : undefined}
                      onClick={() => setCurrentLanguage(locale.locale)}
                      size="slim"
                    >
                      {locale.name} {locale.primary && "(Hauptsprache)"}
                    </Button>
                  ))}
                </div>

                {/* Header with Save Button */}
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={selectedProduct.status === "ACTIVE" ? "success" : undefined}>{selectedProduct.status}</Badge>
                    <Text as="p" variant="bodySm" tone="subdued">ID: {selectedProduct.id.split("/").pop()}</Text>
                  </InlineStack>
                  <InlineStack gap="200">
                    {currentLanguage === primaryLocale && (
                      <Button
                        onClick={handleTranslateAll}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("action") === "translateAll"}
                      >
                        In alle Sprachen übersetzen
                      </Button>
                    )}
                    <Button
                      variant={hasChanges ? "primary" : undefined}
                      onClick={handleSaveProduct}
                      disabled={!hasChanges}
                      loading={fetcher.state !== "idle" && fetcher.formData?.get("action") === "updateProduct"}
                    >
                      Änderungen speichern
                    </Button>
                  </InlineStack>
                </InlineStack>

                {selectedProduct.featuredImage && (
                  <img src={selectedProduct.featuredImage.url} alt={selectedProduct.title} style={{ width: "100%", maxWidth: "300px", borderRadius: "8px" }} />
                )}

                {/* Editable Title */}
                <div>
                  <div style={{ background: getFieldBackgroundColor("title"), borderRadius: "8px", padding: "1px" }}>
                    <TextField
                      label={`Produkttitel (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                      value={editableTitle}
                      onChange={setEditableTitle}
                      autoComplete="off"
                      helpText={`${editableTitle.length} Zeichen`}
                    />
                  </div>
                  {aiSuggestions.title && (
                    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
                        <Text as="p" variant="bodyMd">{aiSuggestions.title}</Text>
                        <InlineStack gap="200">
                          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion("title")}>
                            Übernehmen
                          </Button>
                          <Button size="slim" onClick={() => handleAcceptAndTranslate("title")}>
                            Übernehmen & Übersetzen
                          </Button>
                          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions.title; return newSuggestions; })}>
                            Ablehnen
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  )}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("title")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        ✨ Mit KI generieren / verbessern
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("title")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title" && fetcher.formData?.get("action") === "translateField"}
                      >
                        🌐 Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* Editable Description */}
                <div>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Produktbeschreibung ({shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})
                    </Text>
                    <Button size="slim" onClick={toggleDescriptionMode}>{descriptionMode === "html" ? "Vorschau" : "HTML"}</Button>
                  </InlineStack>

                  {descriptionMode === "rendered" && (
                    <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.25rem", flexWrap: "wrap", padding: "0.5rem", background: "#f6f6f7", border: "1px solid #c9cccf", borderRadius: "8px 8px 0 0" }}>
                      <ButtonGroup variant="segmented">
                        <Button size="slim" onClick={() => handleFormatText("bold")}>B</Button>
                        <Button size="slim" onClick={() => handleFormatText("italic")}>I</Button>
                        <Button size="slim" onClick={() => handleFormatText("underline")}>U</Button>
                      </ButtonGroup>
                      <ButtonGroup variant="segmented">
                        <Button size="slim" onClick={() => handleFormatText("h1")}>H1</Button>
                        <Button size="slim" onClick={() => handleFormatText("h2")}>H2</Button>
                        <Button size="slim" onClick={() => handleFormatText("h3")}>H3</Button>
                      </ButtonGroup>
                      <ButtonGroup variant="segmented">
                        <Button size="slim" onClick={() => handleFormatText("ul")}>Liste</Button>
                        <Button size="slim" onClick={() => handleFormatText("ol")}>Num.</Button>
                      </ButtonGroup>
                      <ButtonGroup variant="segmented">
                        <Button size="slim" onClick={() => handleFormatText("p")}>Absatz</Button>
                        <Button size="slim" onClick={() => handleFormatText("br")}>Umbruch</Button>
                      </ButtonGroup>
                    </div>
                  )}

                  <div style={{ background: getFieldBackgroundColor("body_html"), borderRadius: "8px", padding: "1px" }}>
                    {descriptionMode === "html" ? (
                      <textarea
                        value={editableDescription}
                        onChange={(e) => setEditableDescription(e.target.value)}
                        style={{
                          width: "100%",
                          minHeight: "200px",
                          padding: "12px",
                          border: "1px solid #c9cccf",
                          borderRadius: "8px",
                          fontFamily: "monospace",
                          fontSize: "14px",
                          marginTop: "0.5rem",
                          background: getFieldBackgroundColor("body_html"),
                        }}
                      />
                    ) : (
                      <div
                        ref={descriptionEditorRef}
                        contentEditable
                        onInput={(e) => setEditableDescription(e.currentTarget.innerHTML)}
                        dangerouslySetInnerHTML={{ __html: editableDescription }}
                        style={{
                          width: "100%",
                          minHeight: "200px",
                          padding: "12px",
                          border: "1px solid #c9cccf",
                          borderTop: "none",
                          borderRadius: "0 0 8px 8px",
                          background: getFieldBackgroundColor("body_html"),
                          lineHeight: "1.6",
                        }}
                        className="description-editor"
                      />
                    )}
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">{editableDescription.replace(/<[^>]*>/g, "").length} Zeichen</Text>
                  {aiSuggestions.description && (
                    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
                        <div dangerouslySetInnerHTML={{ __html: aiSuggestions.description }} />
                        <InlineStack gap="200">
                          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion("description")}>
                            Übernehmen
                          </Button>
                          <Button size="slim" onClick={() => handleAcceptAndTranslate("description")}>
                            Übernehmen & Übersetzen
                          </Button>
                          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions.description; return newSuggestions; })}>
                            Ablehnen
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  )}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("description")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "description" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        ✨ Mit KI generieren / verbessern
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("description")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "description" && fetcher.formData?.get("action") === "translateField"}
                      >
                        🌐 Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* URL Slug */}
                <div>
                  <div style={{ background: getFieldBackgroundColor("handle"), borderRadius: "8px", padding: "1px" }}>
                    <TextField
                      label={`URL-Slug (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                      value={editableHandle}
                      onChange={setEditableHandle}
                      autoComplete="off"
                    />
                  </div>
                  {aiSuggestions.handle && (
                    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
                        <Text as="p" variant="bodyMd">{aiSuggestions.handle}</Text>
                        <InlineStack gap="200">
                          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion("handle")}>
                            Übernehmen
                          </Button>
                          <Button size="slim" onClick={() => handleAcceptAndTranslate("handle")}>
                            Übernehmen & Übersetzen
                          </Button>
                          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions.handle; return newSuggestions; })}>
                            Ablehnen
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  )}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("handle")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        ✨ Mit KI generieren
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("handle")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle" && fetcher.formData?.get("action") === "translateField"}
                      >
                        🌐 Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* SEO Title */}
                <div>
                  <div style={{ background: getFieldBackgroundColor("seo_title"), borderRadius: "8px", padding: "1px" }}>
                    <TextField
                      label={`SEO-Titel (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                      value={editableSeoTitle}
                      onChange={setEditableSeoTitle}
                      autoComplete="off"
                      helpText={`${editableSeoTitle.length} Zeichen (empfohlen: 50-60)`}
                    />
                  </div>
                  {aiSuggestions.seoTitle && (
                    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
                        <Text as="p" variant="bodyMd">{aiSuggestions.seoTitle}</Text>
                        <InlineStack gap="200">
                          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion("seoTitle")}>
                            Übernehmen
                          </Button>
                          <Button size="slim" onClick={() => handleAcceptAndTranslate("seoTitle")}>
                            Übernehmen & Übersetzen
                          </Button>
                          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions.seoTitle; return newSuggestions; })}>
                            Ablehnen
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  )}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("seoTitle")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "seoTitle" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        ✨ Mit KI generieren
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("seoTitle")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "seoTitle" && fetcher.formData?.get("action") === "translateField"}
                      >
                        🌐 Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* Meta Description */}
                <div>
                  <div style={{ background: getFieldBackgroundColor("seo_description"), borderRadius: "8px", padding: "1px" }}>
                    <TextField
                      label={`Meta-Beschreibung (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                      value={editableMetaDescription}
                      onChange={setEditableMetaDescription}
                      multiline={3}
                      autoComplete="off"
                      helpText={`${editableMetaDescription.length} Zeichen (empfohlen: 150-160)`}
                    />
                  </div>
                  {aiSuggestions.metaDescription && (
                    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
                        <Text as="p" variant="bodyMd">{aiSuggestions.metaDescription}</Text>
                        <InlineStack gap="200">
                          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion("metaDescription")}>
                            Übernehmen
                          </Button>
                          <Button size="slim" onClick={() => handleAcceptAndTranslate("metaDescription")}>
                            Übernehmen & Übersetzen
                          </Button>
                          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions.metaDescription; return newSuggestions; })}>
                            Ablehnen
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  )}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("metaDescription")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "metaDescription" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        ✨ Mit KI generieren
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("metaDescription")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "metaDescription" && fetcher.formData?.get("action") === "translateField"}
                      >
                        🌐 Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">Wähle ein Produkt aus der Liste</Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

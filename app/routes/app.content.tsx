import { useState, useEffect, useRef } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  Badge,
  Button,
  TextField,
  Banner,
  ButtonGroup,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";

type ContentType = "blogs" | "collections" | "pages";

const CONTENT_TYPES = [
  { id: "blogs" as ContentType, label: "Blogs", icon: "📝" },
  { id: "collections" as ContentType, label: "Kollektionen", icon: "📂" },
  { id: "pages" as ContentType, label: "Seiten", icon: "📄" },
];

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

    // Fetch blogs with articles
    const blogsResponse = await admin.graphql(
      `#graphql
        query getBlogs($first: Int!) {
          blogs(first: $first) {
            edges {
              node {
                id
                title
                handle
                articles(first: 50) {
                  edges {
                    node {
                      id
                      title
                      handle
                      content
                      publishedAt
                    }
                  }
                }
              }
            }
          }
        }`,
      { variables: { first: 50 } }
    );

    const blogsData = await blogsResponse.json();
    console.log('=== BLOGS API RESPONSE ===');
    console.log('Raw blogs data:', JSON.stringify(blogsData, null, 2));
    console.log('Number of blogs:', blogsData.data?.blogs?.edges?.length || 0);

    const blogs = blogsData.data.blogs.edges.map((edge: any) => ({
      ...edge.node,
      articles: edge.node.articles.edges.map((a: any) => ({ ...a.node, translations: [] }))
    }));
    console.log('Processed blogs:', blogs.length);

    // Fetch collections
    const collectionsResponse = await admin.graphql(
      `#graphql
        query getCollections($first: Int!) {
          collections(first: $first) {
            edges {
              node {
                id
                title
                handle
                descriptionHtml
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

    const collectionsData = await collectionsResponse.json();
    console.log('=== COLLECTIONS API RESPONSE ===');
    console.log('Raw collections data:', JSON.stringify(collectionsData, null, 2));
    console.log('Number of collections:', collectionsData.data?.collections?.edges?.length || 0);

    const collections = collectionsData.data.collections.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));
    console.log('Processed collections:', collections.length);

    // Fetch pages
    const pagesResponse = await admin.graphql(
      `#graphql
        query getPages($first: Int!) {
          pages(first: $first) {
            edges {
              node {
                id
                title
                handle
                bodySummary
                body
              }
            }
          }
        }`,
      { variables: { first: 50 } }
    );

    const pagesData = await pagesResponse.json();
    console.log('=== PAGES API RESPONSE ===');
    console.log('Raw pages data:', JSON.stringify(pagesData, null, 2));
    console.log('Number of pages:', pagesData.data?.pages?.edges?.length || 0);

    const pages = pagesData.data.pages.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));
    console.log('Processed pages:', pages.length);

    return json({
      blogs,
      collections,
      pages,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    return json({
      blogs: [],
      collections: [],
      pages: [],
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
  const itemId = formData.get("itemId") as string;
  const contentType = formData.get("contentType") as string;

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
          query getTranslations($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translations(locale: $locale) {
                key
                value
                locale
              }
            }
          }`,
        { variables: { resourceId: itemId, locale } }
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
        let prompt = `Erstelle einen optimierten Titel.`;
        if (aiInstructions?.titleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.titleFormat}`;
        }
        if (aiInstructions?.titleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.titleInstructions}`;
        }
        prompt += `\n\nKontext:\n${contextDescription || currentValue}\n\nGib nur den Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "description" || fieldType === "body") {
        let prompt = `Erstelle eine optimierte Beschreibung für: ${contextTitle}`;
        if (aiInstructions?.descriptionFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.descriptionFormat}`;
        }
        if (aiInstructions?.descriptionInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.descriptionInstructions}`;
        }
        prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur die Beschreibung zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
      } else if (fieldType === "handle") {
        let prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
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
        let prompt = `Erstelle einen optimierten SEO-Titel für:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
        if (aiInstructions?.seoTitleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.seoTitleFormat}`;
        }
        if (aiInstructions?.seoTitleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.seoTitleInstructions}`;
        } else {
          prompt += `\n\nDer SEO-Titel sollte:\n- Max. 60 Zeichen lang sein\n- Keywords enthalten\n- Zum Klicken anregen`;
        }
        prompt += `\n\nGib nur den SEO-Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "metaDescription") {
        let prompt = `Erstelle eine optimierte Meta-Description für:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
        if (aiInstructions?.metaDescFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.metaDescFormat}`;
        }
        if (aiInstructions?.metaDescInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.metaDescInstructions}`;
        } else {
          prompt += `\n\nDie Meta-Description sollte:\n- 150-160 Zeichen lang sein\n- Keywords enthalten\n- Zum Klicken anregen`;
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
      const changedFields: any = {};
      changedFields[fieldType] = sourceText;

      const translations = await translationService.translateProduct(changedFields);
      const translatedValue = translations[targetLocale]?.[fieldType] || "";

      return json({ success: true, translatedValue, fieldType, targetLocale });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "updateContent") {
    const locale = formData.get("locale") as string;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;
    const primaryLocale = formData.get("primaryLocale") as string;

    try {
      if (locale !== primaryLocale) {
        // Handle translations for non-primary locales
        const translationsInput = [];

        if (contentType === "pages") {
          if (title) translationsInput.push({ key: "title", value: title, locale });
          if (description) translationsInput.push({ key: "body", value: description, locale });
        } else if (contentType === "collections") {
          if (title) translationsInput.push({ key: "title", value: title, locale });
          if (description) translationsInput.push({ key: "description", value: description, locale });
          if (handle) translationsInput.push({ key: "handle", value: handle, locale });
          if (seoTitle) translationsInput.push({ key: "seo_title", value: seoTitle, locale });
          if (metaDescription) translationsInput.push({ key: "seo_description", value: metaDescription, locale });
        } else if (contentType === "blogs") {
          if (title) translationsInput.push({ key: "title", value: title, locale });
          if (description) translationsInput.push({ key: "body_html", value: description, locale });
          if (handle) translationsInput.push({ key: "handle", value: handle, locale });
          if (seoTitle) translationsInput.push({ key: "seo_title", value: seoTitle, locale });
          if (metaDescription) translationsInput.push({ key: "seo_description", value: metaDescription, locale });
        }

        for (const translation of translationsInput) {
          await admin.graphql(
            `#graphql
              mutation translateContent($resourceId: ID!, $translations: [TranslationInput!]!) {
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
                resourceId: itemId,
                translations: [translation]
              },
            }
          );
        }

        return json({ success: true });
      } else {
        // Update primary locale
        if (contentType === "pages") {
          const response = await admin.graphql(
            `#graphql
              mutation updatePage($id: ID!, $page: PageInput!) {
                pageUpdate(id: $id, page: $page) {
                  page {
                    id
                    title
                    handle
                    body
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
            {
              variables: {
                id: itemId,
                page: {
                  title,
                  handle,
                  body: description,
                },
              },
            }
          );

          const data = await response.json();
          if (data.data.pageUpdate.userErrors.length > 0) {
            return json({
              success: false,
              error: data.data.pageUpdate.userErrors[0].message
            }, { status: 500 });
          }

          return json({ success: true, item: data.data.pageUpdate.page });
        } else if (contentType === "collections") {
          const response = await admin.graphql(
            `#graphql
              mutation updateCollection($input: CollectionInput!) {
                collectionUpdate(input: $input) {
                  collection {
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
                  id: itemId,
                  title,
                  handle,
                  descriptionHtml: description,
                  seo: {
                    title: seoTitle,
                    description: metaDescription,
                  },
                },
              },
            }
          );

          const data = await response.json();
          if (data.data.collectionUpdate.userErrors.length > 0) {
            return json({
              success: false,
              error: data.data.collectionUpdate.userErrors[0].message
            }, { status: 500 });
          }

          return json({ success: true, item: data.data.collectionUpdate.collection });
        } else if (contentType === "blogs") {
          const response = await admin.graphql(
            `#graphql
              mutation updateArticle($id: ID!, $article: ArticleUpdateInput!) {
                articleUpdate(id: $id, article: $article) {
                  article {
                    id
                    title
                    handle
                    content
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
            {
              variables: {
                id: itemId,
                article: {
                  title,
                  handle,
                  body: description,
                  seo: seoTitle || metaDescription ? {
                    title: seoTitle || undefined,
                    description: metaDescription || undefined,
                  } : undefined,
                },
              },
            }
          );

          const data = await response.json();
          if (data.data.articleUpdate.userErrors.length > 0) {
            return json({
              success: false,
              error: data.data.articleUpdate.userErrors[0].message
            }, { status: 500 });
          }

          return json({ success: true, item: data.data.articleUpdate.article });
        }
      }
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function ContentPage() {
  const { blogs, collections, pages, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selectedType, setSelectedType] = useState<ContentType>("blogs");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Editable fields
  const [editableTitle, setEditableTitle] = useState("");
  const [editableDescription, setEditableDescription] = useState("");
  const [editableHandle, setEditableHandle] = useState("");
  const [editableSeoTitle, setEditableSeoTitle] = useState("");
  const [editableMetaDescription, setEditableMetaDescription] = useState("");
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const descriptionEditorRef = useRef<HTMLDivElement>(null);

  // Get current items based on selected type
  const getCurrentItems = () => {
    if (selectedType === "blogs") {
      return blogs.flatMap((blog: any) =>
        blog.articles.map((article: any) => ({ ...article, blogTitle: blog.title, type: "blogs" }))
      );
    } else if (selectedType === "collections") {
      return collections.map((c: any) => ({ ...c, type: "collections" }));
    } else if (selectedType === "pages") {
      return pages.map((p: any) => ({ ...p, type: "pages" }));
    }
    return [];
  };

  const currentItems = getCurrentItems();
  const selectedItem = currentItems.find((item: any) => item.id === selectedItemId);

  // Helper function to get translated value
  const getTranslatedValue = (key: string, locale: string, fallback: string) => {
    if (!selectedItem || locale === primaryLocale) {
      return fallback;
    }

    const translation = selectedItem.translations?.find(
      (t: any) => t.key === key && t.locale === locale
    );

    return translation?.value || "";
  };

  // Load item data when item or language changes
  useEffect(() => {
    if (selectedItem) {
      if (currentLanguage === primaryLocale) {
        setEditableTitle(selectedItem.title);

        if (selectedType === "blogs") {
          setEditableDescription((selectedItem as any).content || selectedItem.body || "");
          setEditableHandle(selectedItem.handle);
          setEditableSeoTitle("");
          setEditableMetaDescription("");
        } else if (selectedType === "collections") {
          setEditableDescription(selectedItem.descriptionHtml || "");
          setEditableHandle(selectedItem.handle);
          setEditableSeoTitle(selectedItem.seo?.title || "");
          setEditableMetaDescription(selectedItem.seo?.description || "");
        } else if (selectedType === "pages") {
          setEditableDescription(selectedItem.body || "");
          setEditableHandle(selectedItem.handle || "");
          setEditableSeoTitle("");
          setEditableMetaDescription("");
        }
      } else {
        // Check if translations for this locale are already loaded
        const hasTranslations = selectedItem.translations?.some(
          (t: any) => t.locale === currentLanguage
        );

        if (!hasTranslations) {
          fetcher.submit(
            {
              action: "loadTranslations",
              itemId: selectedItem.id,
              locale: currentLanguage,
              contentType: selectedType,
            },
            { method: "POST" }
          );
        }

        const titleKey = "title";
        const descKey = selectedType === "pages" ? "body" : selectedType === "blogs" ? "body_html" : "description";

        setEditableTitle(getTranslatedValue(titleKey, currentLanguage, ""));
        setEditableDescription(getTranslatedValue(descKey, currentLanguage, ""));
        setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
        setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
        setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
      }
      setHasChanges(false);
    }
  }, [selectedItemId, currentLanguage]);

  // Handle loaded translations
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const loadedLocale = (fetcher.data as any).locale;
      const loadedTranslations = (fetcher.data as any).translations;

      if (selectedItem && loadedLocale) {
        selectedItem.translations = [
          ...selectedItem.translations.filter((t: any) => t.locale !== loadedLocale),
          ...loadedTranslations
        ];

        if (loadedLocale === currentLanguage) {
          const titleKey = "title";
          const descKey = selectedType === "pages" ? "body" : selectedType === "blogs" ? "body_html" : "description";

          setEditableTitle(getTranslatedValue(titleKey, currentLanguage, ""));
          setEditableDescription(getTranslatedValue(descKey, currentLanguage, ""));
          setEditableHandle(getTranslatedValue("handle", currentLanguage, ""));
          setEditableSeoTitle(getTranslatedValue("seo_title", currentLanguage, ""));
          setEditableMetaDescription(getTranslatedValue("seo_description", currentLanguage, ""));
        }
      }
    }
  }, [fetcher.data]);

  // Track changes
  useEffect(() => {
    if (selectedItem) {
      const getOriginalValue = (key: string, fallback: string) => {
        if (currentLanguage === primaryLocale) {
          return fallback;
        }
        return getTranslatedValue(key, currentLanguage, "");
      };

      const titleKey = "title";
      const descKey = selectedType === "pages" ? "body" : selectedType === "blogs" ? "body_html" : "description";
      const descFallback = selectedType === "pages" ? (selectedItem.body || "") : selectedType === "blogs" ? ((selectedItem as any).content || selectedItem.body || "") : (selectedItem.descriptionHtml || "");

      const titleChanged = editableTitle !== getOriginalValue(titleKey, selectedItem.title);
      const descChanged = editableDescription !== getOriginalValue(descKey, descFallback || "");
      const handleChanged = editableHandle !== getOriginalValue("handle", selectedItem.handle || "");
      const seoTitleChanged = editableSeoTitle !== getOriginalValue("seo_title", selectedItem.seo?.title || "");
      const metaDescChanged = editableMetaDescription !== getOriginalValue("seo_description", selectedItem.seo?.description || "");

      setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
    }
  }, [editableTitle, editableDescription, editableHandle, editableSeoTitle, editableMetaDescription, selectedItem, currentLanguage]);

  const handleSaveContent = () => {
    if (!selectedItemId || !hasChanges) return;

    fetcher.submit(
      {
        action: "updateContent",
        itemId: selectedItemId,
        contentType: selectedType,
        locale: currentLanguage,
        primaryLocale,
        title: editableTitle,
        description: editableDescription,
        handle: editableHandle,
        seoTitle: editableSeoTitle,
        metaDescription: editableMetaDescription,
      },
      { method: "POST" }
    );
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedItemId) return;

    const currentValue = {
      title: editableTitle,
      description: editableDescription,
      body: editableDescription,
      handle: editableHandle,
      seoTitle: editableSeoTitle,
      metaDescription: editableMetaDescription,
    }[fieldType] || "";

    fetcher.submit(
      {
        action: "generateAIText",
        itemId: selectedItemId,
        contentType: selectedType,
        fieldType,
        currentValue,
        contextTitle: editableTitle,
        contextDescription: editableDescription,
      },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedItemId || !selectedItem) return;

    const sourceMap: Record<string, string> = {
      title: selectedItem.title || "",
      description: selectedType === "pages" ? (selectedItem.body || "") :
                   selectedType === "blogs" ? ((selectedItem as any).content || selectedItem.body || "") :
                   (selectedItem.descriptionHtml || ""),
      body: selectedItem.body || (selectedItem as any).content || "",
      handle: selectedItem.handle || "",
      seoTitle: selectedItem.seo?.title || "",
      metaDescription: selectedItem.seo?.description || "",
    };

    const sourceText = sourceMap[fieldType] || "";

    if (!sourceText) {
      alert("Kein Text in der Hauptsprache vorhanden zum Übersetzen");
      return;
    }

    fetcher.submit(
      {
        action: "translateField",
        itemId: selectedItemId,
        contentType: selectedType,
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
      case "body":
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

      switch (fieldType) {
        case "title":
          setEditableTitle(translatedValue);
          break;
        case "description":
        case "body":
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

  const isFieldTranslated = (key: string) => {
    if (currentLanguage === primaryLocale) return true;
    if (!selectedItem) return false;

    const translation = selectedItem.translations?.find(
      (t: any) => t.key === key && t.locale === currentLanguage
    );

    return !!translation && !!translation.value;
  };

  const getFieldBackgroundColor = (key: string) => {
    if (currentLanguage === primaryLocale) return "white";
    return isFieldTranslated(key) ? "white" : "#fff4e5";
  };

  const renderAISuggestion = (fieldType: string, suggestionText: string) => (
    <div style={{ marginTop: "0.5rem", padding: "1rem", background: "#f0f9ff", border: "1px solid #0891b2", borderRadius: "8px" }}>
      <BlockStack gap="300">
        <Text as="p" variant="bodyMd" fontWeight="semibold">KI-Vorschlag:</Text>
        {fieldType === "description" || fieldType === "body" ? (
          <div dangerouslySetInnerHTML={{ __html: suggestionText }} />
        ) : (
          <Text as="p" variant="bodyMd">{suggestionText}</Text>
        )}
        <InlineStack gap="200">
          <Button size="slim" variant="primary" onClick={() => handleAcceptSuggestion(fieldType)}>
            Übernehmen
          </Button>
          <Button size="slim" onClick={() => setAiSuggestions(prev => { const newSuggestions = { ...prev }; delete newSuggestions[fieldType]; return newSuggestions; })}>
            Ablehnen
          </Button>
        </InlineStack>
      </BlockStack>
    </div>
  );

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

      {/* Horizontal Sub-Navigation for Content Types */}
      <div style={{ borderBottom: "1px solid #e1e3e5", background: "white", padding: "1rem" }}>
        <InlineStack gap="300">
          {CONTENT_TYPES.map((type) => (
            <button
              key={type.id}
              onClick={() => {
                setSelectedType(type.id);
                setSelectedItemId(null);
              }}
              style={{
                padding: "0.75rem 1.5rem",
                border: selectedType === type.id ? "2px solid #008060" : "1px solid #c9cccf",
                borderRadius: "8px",
                background: selectedType === type.id ? "#f1f8f5" : "white",
                cursor: "pointer",
                transition: "all 0.2s",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <span style={{ fontSize: "1.2rem" }}>{type.icon}</span>
              <Text
                as="span"
                variant="bodyMd"
                fontWeight={selectedType === type.id ? "semibold" : "regular"}
              >
                {type.label}
              </Text>
            </button>
          ))}
        </InlineStack>
      </div>

      {/* Main Content Area with Left Sidebar */}
      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Items List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {CONTENT_TYPES.find((t) => t.id === selectedType)?.label} ({currentItems.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {currentItems.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Eintrag", plural: "Einträge" }}
                  items={currentItems}
                  renderItem={(item: any) => {
                    const { id, title } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => setSelectedItemId(id)}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {title}
                          </Text>
                          {selectedType === "blogs" && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Blog: {item.blogTitle}
                            </Text>
                          )}
                        </BlockStack>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Keine Einträge verfügbar
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Content Area */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Fehler" tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          {fetcher.data?.success && !(fetcher.data as any).generatedContent && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Erfolg!" tone="success">
                <p>Änderungen erfolgreich gespeichert!</p>
              </Banner>
            </div>
          )}

          <Card padding="600">
            {selectedItem ? (
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
                  <Text as="p" variant="bodySm" tone="subdued">ID: {selectedItem.id.split("/").pop()}</Text>
                  <Button
                    variant={hasChanges ? "primary" : undefined}
                    onClick={handleSaveContent}
                    disabled={!hasChanges}
                    loading={fetcher.state !== "idle" && fetcher.formData?.get("action") === "updateContent"}
                  >
                    Änderungen speichern
                  </Button>
                </InlineStack>

                {/* Editable Title */}
                <div>
                  <div style={{ background: getFieldBackgroundColor("title"), borderRadius: "8px", padding: "1px" }}>
                    <TextField
                      label={`Titel (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                      value={editableTitle}
                      onChange={setEditableTitle}
                      autoComplete="off"
                      helpText={`${editableTitle.length} Zeichen`}
                    />
                  </div>
                  {aiSuggestions.title && renderAISuggestion("title", aiSuggestions.title)}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI("title")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title" && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        Mit KI generieren / verbessern
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField("title")}
                        loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title" && fetcher.formData?.get("action") === "translateField"}
                      >
                        Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* Editable Description/Body */}
                <div>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {selectedType === "pages" ? "Inhalt" : "Beschreibung"} ({shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})
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

                  <div style={{ background: getFieldBackgroundColor(selectedType === "pages" ? "body" : selectedType === "blogs" ? "body_html" : "description"), borderRadius: "8px", padding: "1px" }}>
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
                          lineHeight: "1.6",
                        }}
                        className="description-editor"
                      />
                    )}
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">{editableDescription.replace(/<[^>]*>/g, "").length} Zeichen</Text>
                  {aiSuggestions.description && renderAISuggestion("description", aiSuggestions.description)}
                  {aiSuggestions.body && renderAISuggestion("body", aiSuggestions.body)}
                  <div style={{ marginTop: "0.5rem" }}>
                    {currentLanguage === primaryLocale ? (
                      <Button
                        size="slim"
                        onClick={() => handleGenerateAI(selectedType === "pages" ? "body" : "description")}
                        loading={fetcher.state !== "idle" && (fetcher.formData?.get("fieldType") === "description" || fetcher.formData?.get("fieldType") === "body") && fetcher.formData?.get("action") === "generateAIText"}
                      >
                        Mit KI generieren / verbessern
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => handleTranslateField(selectedType === "pages" ? "body" : "description")}
                        loading={fetcher.state !== "idle" && (fetcher.formData?.get("fieldType") === "description" || fetcher.formData?.get("fieldType") === "body") && fetcher.formData?.get("action") === "translateField"}
                      >
                        Aus Hauptsprache übersetzen
                      </Button>
                    )}
                  </div>
                </div>

                {/* URL Slug (not for pages) */}
                {selectedType !== "pages" && (
                  <div>
                    <div style={{ background: getFieldBackgroundColor("handle"), borderRadius: "8px", padding: "1px" }}>
                      <TextField
                        label={`URL-Slug (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                        value={editableHandle}
                        onChange={setEditableHandle}
                        autoComplete="off"
                      />
                    </div>
                    {aiSuggestions.handle && renderAISuggestion("handle", aiSuggestions.handle)}
                    <div style={{ marginTop: "0.5rem" }}>
                      {currentLanguage === primaryLocale ? (
                        <Button
                          size="slim"
                          onClick={() => handleGenerateAI("handle")}
                          loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle" && fetcher.formData?.get("action") === "generateAIText"}
                        >
                          Mit KI generieren
                        </Button>
                      ) : (
                        <Button
                          size="slim"
                          onClick={() => handleTranslateField("handle")}
                          loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle" && fetcher.formData?.get("action") === "translateField"}
                        >
                          Aus Hauptsprache übersetzen
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* SEO Fields (not for pages) */}
                {selectedType !== "pages" && (
                  <>
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
                      {aiSuggestions.seoTitle && renderAISuggestion("seoTitle", aiSuggestions.seoTitle)}
                      <div style={{ marginTop: "0.5rem" }}>
                        {currentLanguage === primaryLocale ? (
                          <Button
                            size="slim"
                            onClick={() => handleGenerateAI("seoTitle")}
                            loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "seoTitle" && fetcher.formData?.get("action") === "generateAIText"}
                          >
                            Mit KI generieren
                          </Button>
                        ) : (
                          <Button
                            size="slim"
                            onClick={() => handleTranslateField("seoTitle")}
                            loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "seoTitle" && fetcher.formData?.get("action") === "translateField"}
                          >
                            Aus Hauptsprache übersetzen
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
                      {aiSuggestions.metaDescription && renderAISuggestion("metaDescription", aiSuggestions.metaDescription)}
                      <div style={{ marginTop: "0.5rem" }}>
                        {currentLanguage === primaryLocale ? (
                          <Button
                            size="slim"
                            onClick={() => handleGenerateAI("metaDescription")}
                            loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "metaDescription" && fetcher.formData?.get("action") === "generateAIText"}
                          >
                            Mit KI generieren
                          </Button>
                        ) : (
                          <Button
                            size="slim"
                            onClick={() => handleTranslateField("metaDescription")}
                            loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "metaDescription" && fetcher.formData?.get("action") === "translateField"}
                          >
                            Aus Hauptsprache übersetzen
                          </Button>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">Wähle einen Eintrag aus der Liste</Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

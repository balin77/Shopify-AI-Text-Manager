import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { SeoSidebar } from "../components/SeoSidebar";
import { AIEditableField } from "../components/AIEditableField";
import { AIEditableHTMLField } from "../components/AIEditableHTMLField";
import { LocaleNavigationButtons } from "../components/LocaleNavigationButtons";
import { SaveDiscardButtons } from "../components/SaveDiscardButtons";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import {
  contentEditorStyles,
  useNavigationGuard,
  useChangeTracking,
  getTranslatedValue,
  isFieldTranslated as checkFieldTranslated,
} from "../utils/contentEditor.utils";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");

    // Load shopLocales
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
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    // Load articles from database
    const [articles, allTranslations] = await Promise.all([
      db.article.findMany({
        where: { shop: session.shop },
        orderBy: { blogTitle: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'Article' }
      }),
    ]);

    // Group translations by resourceId
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform articles
    const transformedArticles = articles.map(a => ({
      id: a.id,
      blogId: a.blogId,
      blogTitle: a.blogTitle,
      title: a.title,
      handle: a.handle,
      body: a.body,
      seo: {
        title: a.seoTitle,
        description: a.seoDescription,
      },
      translations: translationsByResource[a.id] || [],
    }));

    return json({
      articles: transformedArticles,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[BLOG-LOADER] Error:", error);
    return json({
      articles: [],
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

  // Load AI settings
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
  const shopifyContentService = new ShopifyContentService(admin);

  if (action === "loadTranslations") {
    const locale = formData.get("locale") as string;

    try {
      const translations = await shopifyContentService.loadTranslations(itemId, locale);
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
        let prompt = `Erstelle einen optimierten Artikel-Titel.`;
        if (aiInstructions?.blogTitleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.blogTitleFormat}`;
        }
        if (aiInstructions?.blogTitleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.blogTitleInstructions}`;
        }
        prompt += `\n\nKontext:\n${contextDescription || currentValue}\n\nGib nur den Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "body") {
        let prompt = `Erstelle einen optimierten Artikel-Text für: ${contextTitle}`;
        if (aiInstructions?.blogDescriptionFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.blogDescriptionFormat}`;
        }
        if (aiInstructions?.blogDescriptionInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.blogDescriptionInstructions}`;
        }
        prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur den Artikel-Text zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
      } else if (fieldType === "handle") {
        let prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für:\nTitel: ${contextTitle}\nInhalt: ${contextDescription}`;
        if (aiInstructions?.blogHandleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.blogHandleFormat}`;
        }
        if (aiInstructions?.blogHandleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.blogHandleInstructions}`;
        } else {
          prompt += `\n\nDer Slug sollte:\n- Nur Kleinbuchstaben und Bindestriche enthalten\n- Keine Sonderzeichen oder Umlaute haben\n- Kurz und prägnant sein (2-5 Wörter)\n- SEO-optimiert sein`;
        }
        prompt += `\n\nGib nur den Slug zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
        generatedContent = generatedContent.toLowerCase().trim();
      } else if (fieldType === "seoTitle") {
        let prompt = `Erstelle einen optimierten SEO-Titel für:\nTitel: ${contextTitle}\nInhalt: ${contextDescription}`;
        if (aiInstructions?.blogSeoTitleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.blogSeoTitleFormat}`;
        }
        if (aiInstructions?.blogSeoTitleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.blogSeoTitleInstructions}`;
        } else {
          prompt += `\n\nDer SEO-Titel sollte:\n- Max. 60 Zeichen lang sein\n- Keywords enthalten\n- Zum Klicken anregen`;
        }
        prompt += `\n\nGib nur den SEO-Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "metaDescription") {
        let prompt = `Erstelle eine optimierte Meta-Description für:\nTitel: ${contextTitle}\nInhalt: ${contextDescription}`;
        if (aiInstructions?.blogMetaDescFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.blogMetaDescFormat}`;
        }
        if (aiInstructions?.blogMetaDescInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.blogMetaDescInstructions}`;
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

  if (action === "translateAll") {
    const title = formData.get("title") as string;
    const body = formData.get("body") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;

    try {
      const changedFields: any = {};
      if (title) changedFields.title = title;
      if (body) changedFields.body = body;
      if (handle) changedFields.handle = handle;
      if (seoTitle) changedFields.seoTitle = seoTitle;
      if (metaDescription) changedFields.metaDescription = metaDescription;

      if (Object.keys(changedFields).length === 0) {
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: 'Article',
        fields: changedFields,
        translationService,
        db,
      });

      return json({ success: true, translations: allTranslations });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "updateContent") {
    const locale = formData.get("locale") as string;
    const title = formData.get("title") as string;
    const body = formData.get("body") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;
    const primaryLocale = formData.get("primaryLocale") as string;

    try {
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: 'Article',
        locale,
        primaryLocale,
        updates: { title, body, handle, seoTitle, metaDescription },
        db,
        shop: session.shop,
      });

      return json(result);
    } catch (error: any) {
      console.error("[BLOG-UPDATE] Error:", error);
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function BlogPage() {
  const { articles, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [bodyMode, setBodyMode] = useState<"html" | "rendered">("rendered");

  // Editable fields
  const [editableTitle, setEditableTitle] = useState("");
  const [editableBody, setEditableBody] = useState("");
  const [editableHandle, setEditableHandle] = useState("");
  const [editableSeoTitle, setEditableSeoTitle] = useState("");
  const [editableMetaDescription, setEditableMetaDescription] = useState("");

  const selectedItem = articles.find((item: any) => item.id === selectedItemId);

  const {
    pendingNavigation,
    highlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  } = useNavigationGuard();

  const hasChanges = useChangeTracking(
    selectedItem,
    currentLanguage,
    primaryLocale,
    {
      title: editableTitle,
      description: editableBody,
      handle: editableHandle,
      seoTitle: editableSeoTitle,
      metaDescription: editableMetaDescription,
    },
    'blogs'
  );

  // Load item data when item or language changes
  useEffect(() => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableTitle(selectedItem.title);
      setEditableBody(selectedItem.body || "");
      setEditableHandle(selectedItem.handle);
      setEditableSeoTitle(selectedItem.seo?.title || "");
      setEditableMetaDescription(selectedItem.seo?.description || "");
    } else {
      setEditableTitle(getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale));
      setEditableBody(getTranslatedValue(selectedItem, "body", currentLanguage, "", primaryLocale));
      setEditableHandle(getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale));
      setEditableSeoTitle(getTranslatedValue(selectedItem, "meta_title", currentLanguage, "", primaryLocale));
      setEditableMetaDescription(getTranslatedValue(selectedItem, "meta_description", currentLanguage, "", primaryLocale));
    }
  }, [selectedItemId, currentLanguage]);

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
      const { fieldType, translatedValue } = fetcher.data as any;
      const setters: Record<string, (value: string) => void> = {
        title: setEditableTitle,
        body: setEditableBody,
        handle: setEditableHandle,
        seoTitle: setEditableSeoTitle,
        metaDescription: setEditableMetaDescription,
      };
      setters[fieldType]?.(translatedValue);
    }
  }, [fetcher.data]);

  // Show global InfoBox for success/error messages
  useEffect(() => {
    if (fetcher.data?.success && !(fetcher.data as any).generatedContent && !(fetcher.data as any).translatedValue) {
      showInfoBox(t.content.changesSaved, "success", t.content.success);
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.content.error);
    }
  }, [fetcher.data, showInfoBox, t]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content.error);
    }
  }, [error, showInfoBox, t]);

  const handleSaveContent = () => {
    if (!selectedItemId || !hasChanges) return;

    fetcher.submit(
      {
        action: "updateContent",
        itemId: selectedItemId,
        locale: currentLanguage,
        primaryLocale,
        title: editableTitle,
        body: editableBody,
        handle: editableHandle,
        seoTitle: editableSeoTitle,
        metaDescription: editableMetaDescription,
      },
      { method: "POST" }
    );

    clearPendingNavigation();
  };

  const handleDiscardChanges = () => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableTitle(selectedItem.title);
      setEditableBody(selectedItem.body || "");
      setEditableHandle(selectedItem.handle);
      setEditableSeoTitle(selectedItem.seo?.title || "");
      setEditableMetaDescription(selectedItem.seo?.description || "");
    } else {
      setEditableTitle(getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale));
      setEditableBody(getTranslatedValue(selectedItem, "body", currentLanguage, "", primaryLocale));
      setEditableHandle(getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale));
      setEditableSeoTitle(getTranslatedValue(selectedItem, "meta_title", currentLanguage, "", primaryLocale));
      setEditableMetaDescription(getTranslatedValue(selectedItem, "meta_description", currentLanguage, "", primaryLocale));
    }

    clearPendingNavigation();
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedItemId) return;
    const currentValue = { title: editableTitle, body: editableBody, handle: editableHandle, seoTitle: editableSeoTitle, metaDescription: editableMetaDescription }[fieldType] || "";
    fetcher.submit(
      { action: "generateAIText", itemId: selectedItemId, fieldType, currentValue, contextTitle: editableTitle, contextDescription: editableBody },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedItemId || !selectedItem) return;
    const sourceMap: Record<string, string> = {
      title: selectedItem.title,
      body: selectedItem.body || "",
      handle: selectedItem.handle,
      seoTitle: selectedItem.seo?.title || "",
      metaDescription: selectedItem.seo?.description || "",
    };
    const sourceText = sourceMap[fieldType] || "";
    if (!sourceText) {
      alert(t.content.noSourceText);
      return;
    }
    fetcher.submit(
      { action: "translateField", itemId: selectedItemId, fieldType, sourceText, targetLocale: currentLanguage },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedItemId || !selectedItem) return;
    fetcher.submit(
      {
        action: "translateAll",
        itemId: selectedItemId,
        title: selectedItem.title,
        body: selectedItem.body || "",
        handle: selectedItem.handle,
        seoTitle: selectedItem.seo?.title || "",
        metaDescription: selectedItem.seo?.description || "",
      },
      { method: "POST" }
    );
  };

  const handleAcceptSuggestion = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;
    const setters: Record<string, (value: string) => void> = {
      title: setEditableTitle,
      body: setEditableBody,
      handle: setEditableHandle,
      seoTitle: setEditableSeoTitle,
      metaDescription: setEditableMetaDescription,
    };
    setters[fieldType]?.(suggestion);
    setAiSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldType];
      return newSuggestions;
    });
  };

  const isFieldTranslatedCheck = (key: string) => {
    return checkFieldTranslated(selectedItem, key, currentLanguage, primaryLocale);
  };

  return (
    <Page fullWidth>
      <style>{contentEditorStyles}</style>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Articles List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content.articles || "Articles"} ({articles.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {articles.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Article", plural: "Articles" }}
                  items={articles}
                  renderItem={(item: any) => {
                    const { id, title, blogTitle } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => {
                          handleNavigationAttempt(() => setSelectedItemId(id), hasChanges);
                        }}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {title}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {blogTitle}
                          </Text>
                        </BlockStack>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content.noEntries}
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Article Editor */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          <Card padding="600">
            {selectedItem ? (
              <BlockStack gap="500">
                {/* Language Selector */}
                <LocaleNavigationButtons
                  shopLocales={shopLocales}
                  currentLanguage={currentLanguage}
                  primaryLocaleSuffix={t.content.primaryLanguageSuffix}
                  selectedItem={selectedItem}
                  primaryLocale={primaryLocale}
                  contentType="blogs"
                  hasChanges={hasChanges}
                  onLanguageChange={(locale) => handleNavigationAttempt(() => setCurrentLanguage(locale), hasChanges)}
                />

                {/* Save Button */}
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodySm" tone="subdued">{t.content.idPrefix} {selectedItem.id.split("/").pop()}</Text>
                  <SaveDiscardButtons
                    hasChanges={hasChanges}
                    onSave={handleSaveContent}
                    onDiscard={handleDiscardChanges}
                    highlightSaveButton={highlightSaveButton}
                    saveText={t.content.saveChanges}
                    discardText={t.content.discardChanges || "Verwerfen"}
                    action="updateContent"
                    fetcherState={fetcher.state}
                    fetcherFormData={fetcher.formData}
                  />
                </InlineStack>

                {/* Title */}
                <AIEditableField
                  label={`${t.content.title} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                  value={editableTitle}
                  onChange={setEditableTitle}
                  fieldType="title"
                  suggestion={aiSuggestions.title}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("title")}
                  helpText={`${editableTitle.length} ${t.content.characters}`}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title"}
                  sourceTextAvailable={!!selectedItem?.title}
                  onGenerateAI={() => handleGenerateAI("title")}
                  onTranslate={() => handleTranslateField("title")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("title")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["title"]; return newSuggestions; })}
                />

                {/* Body */}
                <AIEditableHTMLField
                  label={t.content.body || "Body"}
                  value={editableBody}
                  onChange={setEditableBody}
                  mode={bodyMode}
                  onToggleMode={() => setBodyMode(bodyMode === "html" ? "rendered" : "html")}
                  fieldType="body"
                  suggestion={aiSuggestions.body}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("body")}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "body"}
                  sourceTextAvailable={!!selectedItem?.body}
                  onGenerateAI={() => handleGenerateAI("body")}
                  onTranslate={() => handleTranslateField("body")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("body")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["body"]; return newSuggestions; })}
                />

                {/* Handle */}
                <AIEditableField
                  label={`${t.content.urlSlug} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                  value={editableHandle}
                  onChange={setEditableHandle}
                  fieldType="handle"
                  suggestion={aiSuggestions.handle}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("handle")}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle"}
                  sourceTextAvailable={!!selectedItem?.handle}
                  onGenerateAI={() => handleGenerateAI("handle")}
                  onTranslate={() => handleTranslateField("handle")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("handle")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["handle"]; return newSuggestions; })}
                />

                {/* SEO Title */}
                <AIEditableField
                  label={`${t.content.seoTitle} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                  value={editableSeoTitle}
                  onChange={setEditableSeoTitle}
                  fieldType="seoTitle"
                  suggestion={aiSuggestions.seoTitle}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("meta_title")}
                  helpText={`${editableSeoTitle.length} ${t.content.characters} (${t.content.recommended}: 50-60)`}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "seoTitle"}
                  sourceTextAvailable={!!selectedItem?.seo?.title}
                  onGenerateAI={() => handleGenerateAI("seoTitle")}
                  onTranslate={() => handleTranslateField("seoTitle")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("seoTitle")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["seoTitle"]; return newSuggestions; })}
                />

                {/* Meta Description */}
                <AIEditableField
                  label={`${t.content.metaDescription} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                  value={editableMetaDescription}
                  onChange={setEditableMetaDescription}
                  fieldType="metaDescription"
                  suggestion={aiSuggestions.metaDescription}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("meta_description")}
                  helpText={`${editableMetaDescription.length} ${t.content.characters} (${t.content.recommended}: 150-160)`}
                  multiline={3}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "metaDescription"}
                  sourceTextAvailable={!!selectedItem?.seo?.description}
                  onGenerateAI={() => handleGenerateAI("metaDescription")}
                  onTranslate={() => handleTranslateField("metaDescription")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("metaDescription")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["metaDescription"]; return newSuggestions; })}
                />
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">{t.content.selectFromList}</Text>
              </div>
            )}
          </Card>
        </div>

        {/* Right: SEO Sidebar */}
        {selectedItem && currentLanguage === primaryLocale && (
          <div style={{ width: "320px", flexShrink: 0, overflow: "auto" }}>
            <SeoSidebar
              title={editableTitle}
              description={editableBody}
              handle={editableHandle}
              seoTitle={editableSeoTitle}
              metaDescription={editableMetaDescription}
            />
          </div>
        )}
      </div>
    </Page>
  );
}

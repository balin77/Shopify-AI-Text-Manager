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
  hasPrimaryContentMissing as checkPrimaryContentMissing,
  hasLocaleMissingTranslations as checkLocaleMissingTranslations,
  hasMissingTranslations as checkMissingTranslations,
  hasFieldMissingTranslations as checkFieldMissingTranslations,
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

    // Load pages from database
    const [pages, allTranslations] = await Promise.all([
      db.page.findMany({
        where: { shop: session.shop },
        orderBy: { title: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'Page' }
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

    // Transform pages
    const transformedPages = pages.map(p => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      body: p.body,
      translations: translationsByResource[p.id] || [],
    }));

    return json({
      pages: transformedPages,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[PAGES-LOADER] Error:", error);
    return json({
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
        let prompt = `Erstelle einen optimierten Titel.`;
        if (aiInstructions?.pageTitleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.pageTitleFormat}`;
        }
        if (aiInstructions?.pageTitleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.pageTitleInstructions}`;
        }
        prompt += `\n\nKontext:\n${contextDescription || currentValue}\n\nGib nur den Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "description") {
        let prompt = `Erstelle eine optimierte Beschreibung für: ${contextTitle}`;
        if (aiInstructions?.pageDescriptionFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.pageDescriptionFormat}`;
        }
        if (aiInstructions?.pageDescriptionInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.pageDescriptionInstructions}`;
        }
        prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur die Beschreibung zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
      } else if (fieldType === "handle") {
        let prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für:\nTitel: ${contextTitle}\nBeschreibung: ${contextDescription}`;
        if (aiInstructions?.pageHandleFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.pageHandleFormat}`;
        }
        if (aiInstructions?.pageHandleInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.pageHandleInstructions}`;
        } else {
          prompt += `\n\nDer Slug sollte:\n- Nur Kleinbuchstaben und Bindestriche enthalten\n- Keine Sonderzeichen oder Umlaute haben\n- Kurz und prägnant sein (2-5 Wörter)\n- SEO-optimiert sein`;
        }
        prompt += `\n\nGib nur den Slug zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
        generatedContent = generatedContent.toLowerCase().trim();
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
    const description = formData.get("description") as string;
    const handle = formData.get("handle") as string;

    try {
      const changedFields: any = {};
      if (title) changedFields.title = title;
      if (description) changedFields.description = description;
      if (handle) changedFields.handle = handle;

      if (Object.keys(changedFields).length === 0) {
        return json({ success: false, error: "No fields to translate" }, { status: 400 });
      }

      const allTranslations = await shopifyContentService.translateAllContent({
        resourceId: itemId,
        resourceType: 'Page',
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
    const description = formData.get("description") as string;
    const handle = formData.get("handle") as string;
    const primaryLocale = formData.get("primaryLocale") as string;

    try {
      const result = await shopifyContentService.updateContent({
        resourceId: itemId,
        resourceType: 'Page',
        locale,
        primaryLocale,
        updates: { title, description, handle },
        db,
        shop: session.shop,
      });

      return json(result);
    } catch (error: any) {
      console.error("[PAGES-UPDATE] Error:", error);
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function PagesPage() {
  const { pages, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");

  // Editable fields
  const [editableTitle, setEditableTitle] = useState("");
  const [editableDescription, setEditableDescription] = useState("");
  const [editableHandle, setEditableHandle] = useState("");
  const [editableSeoTitle, setEditableSeoTitle] = useState("");
  const [editableMetaDescription, setEditableMetaDescription] = useState("");

  const selectedItem = pages.find((item: any) => item.id === selectedItemId);

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
      description: editableDescription,
      handle: editableHandle,
      seoTitle: editableSeoTitle,
      metaDescription: editableMetaDescription,
    },
    'pages'
  );

  // Load item data when item or language changes
  useEffect(() => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableTitle(selectedItem.title);
      setEditableDescription(selectedItem.body || "");
      setEditableHandle(selectedItem.handle);
      setEditableSeoTitle("");
      setEditableMetaDescription("");
    } else {
      setEditableTitle(getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale));
      setEditableDescription(getTranslatedValue(selectedItem, "body_html", currentLanguage, "", primaryLocale));
      setEditableHandle(getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale));
      setEditableSeoTitle("");
      setEditableMetaDescription("");
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
        description: setEditableDescription,
        handle: setEditableHandle,
      };
      setters[fieldType]?.(translatedValue);
    }
  }, [fetcher.data]);

  // Show global InfoBox for success/error messages
  useEffect(() => {
    if (fetcher.data?.success && !(fetcher.data as any).generatedContent && !(fetcher.data as any).translatedValue) {
      showInfoBox(t.content?.changesSaved || "Changes saved successfully!", "success", t.content?.success || "Success");
    } else if (fetcher.data && !fetcher.data.success && 'error' in fetcher.data) {
      showInfoBox(fetcher.data.error as string, "critical", t.content?.error || "Error");
    }
  }, [fetcher.data, showInfoBox, t]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
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
        description: editableDescription,
        handle: editableHandle,
      },
      { method: "POST" }
    );

    clearPendingNavigation();
  };

  const handleDiscardChanges = () => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableTitle(selectedItem.title);
      setEditableDescription(selectedItem.body || "");
      setEditableHandle(selectedItem.handle);
      setEditableSeoTitle("");
      setEditableMetaDescription("");
    } else {
      setEditableTitle(getTranslatedValue(selectedItem, "title", currentLanguage, "", primaryLocale));
      setEditableDescription(getTranslatedValue(selectedItem, "body_html", currentLanguage, "", primaryLocale));
      setEditableHandle(getTranslatedValue(selectedItem, "handle", currentLanguage, "", primaryLocale));
      setEditableSeoTitle("");
      setEditableMetaDescription("");
    }

    clearPendingNavigation();
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedItemId) return;
    const currentValue = { title: editableTitle, description: editableDescription, handle: editableHandle }[fieldType] || "";
    fetcher.submit(
      { action: "generateAIText", itemId: selectedItemId, fieldType, currentValue, contextTitle: editableTitle, contextDescription: editableDescription },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedItemId || !selectedItem) return;
    const sourceMap: Record<string, string> = {
      title: selectedItem.title,
      description: selectedItem.body || "",
      handle: selectedItem.handle,
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
        description: selectedItem.body || "",
        handle: selectedItem.handle,
      },
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

  const hasMissingTranslations = () => {
    return checkMissingTranslations(selectedItem, shopLocales, 'pages');
  };

  const hasFieldMissingTranslations = (fieldKey: string) => {
    return checkFieldMissingTranslations(selectedItem, fieldKey, shopLocales, primaryLocale, 'pages');
  };

  return (
    <Page fullWidth>
      <style>{contentEditorStyles}</style>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Pages List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content.pages} ({pages.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {pages.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Page", plural: "Pages" }}
                  items={pages}
                  renderItem={(item: any) => {
                    const { id, title } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => {
                          handleNavigationAttempt(() => setSelectedItemId(id), hasChanges);
                        }}
                      >
                        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                          {title}
                        </Text>
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

        {/* Middle: Page Editor */}
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
                  contentType="pages"
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
                  fieldKey="title"
                  suggestion={aiSuggestions.title}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("title")}
                  helpText={`${editableTitle.length} ${t.content.characters}`}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title"}
                  sourceTextAvailable={!!selectedItem?.title}
                  hasFieldMissingTranslations={hasFieldMissingTranslations("title")}
                  onGenerateAI={() => handleGenerateAI("title")}
                  onTranslate={() => handleTranslateField("title")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("title")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["title"]; return newSuggestions; })}
                />

                {/* Body */}
                <AIEditableHTMLField
                  label={t.content.body || "Body"}
                  value={editableDescription}
                  onChange={setEditableDescription}
                  mode={descriptionMode}
                  onToggleMode={() => setDescriptionMode(descriptionMode === "html" ? "rendered" : "html")}
                  fieldType="description"
                  fieldKey="description"
                  suggestion={aiSuggestions.description}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("body_html")}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "description"}
                  sourceTextAvailable={!!selectedItem?.body}
                  hasFieldMissingTranslations={hasFieldMissingTranslations("description")}
                  onGenerateAI={() => handleGenerateAI("description")}
                  onTranslate={() => handleTranslateField("description")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("description")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["description"]; return newSuggestions; })}
                />

                {/* Handle */}
                <AIEditableField
                  label={`${t.content.urlSlug} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
                  value={editableHandle}
                  onChange={setEditableHandle}
                  fieldType="handle"
                  fieldKey="handle"
                  suggestion={aiSuggestions.handle}
                  isPrimaryLocale={currentLanguage === primaryLocale}
                  isTranslated={isFieldTranslatedCheck("handle")}
                  isLoading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "handle"}
                  sourceTextAvailable={!!selectedItem?.handle}
                  hasFieldMissingTranslations={hasFieldMissingTranslations("handle")}
                  onGenerateAI={() => handleGenerateAI("handle")}
                  onTranslate={() => handleTranslateField("handle")}
                  onTranslateAll={handleTranslateAll}
                  onAcceptSuggestion={() => handleAcceptSuggestion("handle")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["handle"]; return newSuggestions; })}
                />
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">{t.content.selectFromList}</Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

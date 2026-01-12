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
import { AIEditableHTMLField } from "../components/AIEditableHTMLField";
import { AIService } from "../../src/services/ai.service";
import { TranslationService } from "../../src/services/translation.service";
import { useI18n } from "../contexts/I18nContext";
import { TRANSLATE_CONTENT, UPDATE_SHOP_POLICY } from "../graphql/content.mutations";
import { GET_TRANSLATIONS } from "../graphql/content.queries";
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

    // Load policies from database (synced by background sync)
    const [policies, allTranslations] = await Promise.all([
      db.shopPolicy.findMany({
        where: { shop: session.shop },
        orderBy: { type: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'ShopPolicy' }
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

    // Transform policies with translations
    const transformedPolicies = policies.map(p => ({
      id: p.id,
      title: p.title,
      body: p.body,
      type: p.type,
      url: p.url,
      translations: translationsByResource[p.id] || [],
    }));

    return json({
      policies: transformedPolicies,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[POLICIES-LOADER] Error:", error);
    return json({
      policies: [],
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

  if (action === "loadTranslations") {
    const locale = formData.get("locale") as string;

    try {
      const translationsResponse = await admin.graphql(GET_TRANSLATIONS, {
        variables: { resourceId: itemId, locale }
      });

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

    try {
      let generatedContent = "";

      if (fieldType === "body") {
        let prompt = `Erstelle einen optimierten Richtlinientext für: ${contextTitle}`;
        if (aiInstructions?.descriptionFormat) {
          prompt += `\n\nFormatbeispiel:\n${aiInstructions.descriptionFormat}`;
        }
        if (aiInstructions?.descriptionInstructions) {
          prompt += `\n\nAnweisungen:\n${aiInstructions.descriptionInstructions}`;
        }
        prompt += `\n\nAktueller Inhalt:\n${currentValue}\n\nGib nur den Richtlinientext zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
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
    const body = formData.get("body") as string;
    const policyType = formData.get("policyType") as string;
    const primaryLocale = formData.get("primaryLocale") as string;

    try {
      if (locale !== primaryLocale) {
        // Handle translations
        const translationsInput = [];
        if (body) translationsInput.push({ key: "body", value: body, locale });

        // Save to Shopify
        for (const translation of translationsInput) {
          await admin.graphql(TRANSLATE_CONTENT, {
            variables: {
              resourceId: itemId,
              translations: [translation]
            }
          });
        }

        // Update database
        await db.contentTranslation.deleteMany({
          where: { resourceId: itemId, resourceType: 'ShopPolicy', locale },
        });

        if (translationsInput.length > 0) {
          await db.contentTranslation.createMany({
            data: translationsInput.map(t => ({
              resourceId: itemId,
              resourceType: 'ShopPolicy',
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: null,
            })),
          });
        }

        return json({ success: true });
      } else {
        // Update primary locale using shopPolicyUpdate mutation
        const response = await admin.graphql(UPDATE_SHOP_POLICY, {
          variables: {
            shopPolicy: {
              type: policyType,
              body: body,
            },
          }
        });

        const data = await response.json();
        if (data.data.shopPolicyUpdate.userErrors.length > 0) {
          return json({
            success: false,
            error: data.data.shopPolicyUpdate.userErrors[0].message
          }, { status: 500 });
        }

        // Update database
        const updatedPolicy = data.data.shopPolicyUpdate.shopPolicy;
        await db.shopPolicy.upsert({
          where: {
            shop_id: {
              shop: session.shop,
              id: updatedPolicy.id,
            },
          },
          create: {
            id: updatedPolicy.id,
            shop: session.shop,
            title: updatedPolicy.title,
            body: updatedPolicy.body,
            type: updatedPolicy.type,
            url: updatedPolicy.url,
            lastSyncedAt: new Date(),
          },
          update: {
            title: updatedPolicy.title,
            body: updatedPolicy.body,
            type: updatedPolicy.type,
            url: updatedPolicy.url,
            lastSyncedAt: new Date(),
          },
        });

        return json({ success: true, item: updatedPolicy });
      }
    } catch (error: any) {
      console.error("[POLICIES-UPDATE] Error:", error);
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function PoliciesPage() {
  const { policies, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, any[]>>({});
  const [bodyMode, setBodyMode] = useState<"html" | "rendered">("rendered");

  // Editable fields (only body is editable, title is read-only)
  const [editableBody, setEditableBody] = useState("");

  const selectedItem = policies.find((item: any) => item.id === selectedItemId);

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
    loadedTranslations,
    {
      title: "", // Not editable for policies
      description: editableBody,
      handle: "", // Not used for policies
      seoTitle: "", // Not used for policies
      metaDescription: "", // Not used for policies
    },
    'policies'
  );

  // Load item data when item or language changes
  useEffect(() => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableBody(selectedItem.body || "");
    } else {
      const itemKey = `${selectedItem.id}_${currentLanguage}`;
      const hasTranslations = loadedTranslations[itemKey] || selectedItem.translations?.some(
        (t: any) => t.locale === currentLanguage
      );

      if (!hasTranslations) {
        fetcher.submit(
          {
            action: "loadTranslations",
            itemId: selectedItem.id,
            locale: currentLanguage,
          },
          { method: "POST" }
        );
      } else {
        setEditableBody(getTranslatedValue(selectedItem, "body", currentLanguage, "", primaryLocale, loadedTranslations));
      }
    }
  }, [selectedItemId, currentLanguage, loadedTranslations]);

  // Handle loaded translations
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const loadedLocale = (fetcher.data as any).locale;
      const translations = (fetcher.data as any).translations;

      if (selectedItem && loadedLocale && translations) {
        const itemKey = `${selectedItem.id}_${loadedLocale}`;
        setLoadedTranslations(prev => ({
          ...prev,
          [itemKey]: translations
        }));

        if (loadedLocale === currentLanguage) {
          setEditableBody(translations.find((t: any) => t.key === "body")?.value || "");
        }
      }
    }
  }, [fetcher.data]);

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
      if (fieldType === "body") {
        setEditableBody(translatedValue);
      }
    }
  }, [fetcher.data]);

  const handleSaveContent = () => {
    if (!selectedItemId || !hasChanges || !selectedItem) return;

    fetcher.submit(
      {
        action: "updateContent",
        itemId: selectedItemId,
        locale: currentLanguage,
        primaryLocale,
        body: editableBody,
        policyType: selectedItem.type,
      },
      { method: "POST" }
    );

    clearPendingNavigation();
  };

  const handleDiscardChanges = () => {
    if (!selectedItem) return;

    if (currentLanguage === primaryLocale) {
      setEditableBody(selectedItem.body || "");
    } else {
      setEditableBody(getTranslatedValue(selectedItem, "body", currentLanguage, "", primaryLocale, loadedTranslations));
    }

    clearPendingNavigation();
  };

  const handleGenerateAI = (fieldType: string) => {
    if (!selectedItemId || !selectedItem) return;
    const currentValue = editableBody;
    fetcher.submit(
      { action: "generateAIText", itemId: selectedItemId, fieldType, currentValue, contextTitle: selectedItem.title },
      { method: "POST" }
    );
  };

  const handleTranslateField = (fieldType: string) => {
    if (!selectedItemId || !selectedItem) return;
    const sourceText = selectedItem.body || "";
    if (!sourceText) {
      alert(t.content.noSourceText);
      return;
    }
    fetcher.submit(
      { action: "translateField", itemId: selectedItemId, fieldType, sourceText, targetLocale: currentLanguage },
      { method: "POST" }
    );
  };

  const handleAcceptSuggestion = (fieldType: string) => {
    const suggestion = aiSuggestions[fieldType];
    if (!suggestion) return;
    if (fieldType === "body") {
      setEditableBody(suggestion);
    }
    setAiSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldType];
      return newSuggestions;
    });
  };

  const isFieldTranslatedCheck = (key: string) => {
    return checkFieldTranslated(selectedItem, key, currentLanguage, primaryLocale, loadedTranslations);
  };

  // Map policy types to human-readable names
  const getPolicyTypeName = (type: string) => {
    const typeMap: Record<string, string> = {
      'CONTACT_INFORMATION': t.content.policyTypes?.contactInformation || 'Kontaktinformationen',
      'LEGAL_NOTICE': t.content.policyTypes?.legalNotice || 'Impressum',
      'PRIVACY_POLICY': t.content.policyTypes?.privacyPolicy || 'Datenschutzerklärung',
      'REFUND_POLICY': t.content.policyTypes?.refundPolicy || 'Rückerstattungsrichtlinie',
      'SHIPPING_POLICY': t.content.policyTypes?.shippingPolicy || 'Versandrichtlinie',
      'TERMS_OF_SERVICE': t.content.policyTypes?.termsOfService || 'Nutzungsbedingungen',
      'TERMS_OF_SALE': t.content.policyTypes?.termsOfSale || 'Verkaufsbedingungen',
      'SUBSCRIPTION_POLICY': t.content.policyTypes?.subscriptionPolicy || 'Abonnementrichtlinie',
    };
    return typeMap[type] || type;
  };

  return (
    <Page fullWidth>
      <style>{contentEditorStyles}</style>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Policies List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content.policies || "Richtlinien"} ({policies.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {policies.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Policy", plural: "Policies" }}
                  items={policies}
                  renderItem={(item: any) => {
                    const { id, title, type } = item;
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
                            {title || getPolicyTypeName(type)}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {getPolicyTypeName(type)}
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

        {/* Middle: Policy Editor */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content.error} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          {fetcher.data?.success && !(fetcher.data as any).generatedContent && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content.success} tone="success">
                <p>{t.content.changesSaved}</p>
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
                      onClick={() => {
                        handleNavigationAttempt(() => setCurrentLanguage(locale.locale), hasChanges);
                      }}
                      size="slim"
                    >
                      {locale.name} {locale.primary && `(${t.content.primaryLanguageSuffix})`}
                    </Button>
                  ))}
                </div>

                {/* Save Button */}
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">{t.content.idPrefix} {selectedItem.id.split("/").pop()}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.content.policyType || "Typ"}: {getPolicyTypeName(selectedItem.type)}
                    </Text>
                  </BlockStack>
                  <div ref={saveButtonRef}>
                    <InlineStack gap="200">
                      {hasChanges && (
                        <Button
                          onClick={handleDiscardChanges}
                          disabled={fetcher.state !== "idle"}
                        >
                          {t.content.discardChanges || "Verwerfen"}
                        </Button>
                      )}
                      <div
                        style={{
                          animation: highlightSaveButton ? "pulse 1.5s ease-in-out infinite" : "none",
                          borderRadius: "8px",
                        }}
                      >
                        <Button
                          variant={hasChanges ? "primary" : undefined}
                          onClick={handleSaveContent}
                          disabled={!hasChanges}
                          loading={fetcher.state !== "idle" && fetcher.formData?.get("action") === "updateContent"}
                        >
                          {t.content.saveChanges}
                        </Button>
                      </div>
                    </InlineStack>
                  </div>
                </InlineStack>

                {/* Read-only Title */}
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="medium">
                    {t.content.title} (Read-only)
                  </Text>
                  <Card>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {selectedItem.title || getPolicyTypeName(selectedItem.type)}
                    </Text>
                  </Card>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content.policyTitleReadOnly || "Der Titel wird automatisch von Shopify basierend auf dem Richtlinientyp gesetzt."}
                  </Text>
                </BlockStack>

                {/* Body */}
                <AIEditableHTMLField
                  label={`${t.content.body || "Inhalt"} (${shopLocales.find((l: any) => l.locale === currentLanguage)?.name || currentLanguage})`}
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
                  onAcceptSuggestion={() => handleAcceptSuggestion("body")}
                  onRejectSuggestion={() => setAiSuggestions(prev => { const newSuggestions = {...prev}; delete newSuggestions["body"]; return newSuggestions; })}
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

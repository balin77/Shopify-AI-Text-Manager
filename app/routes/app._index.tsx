import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { Page, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { SeoSidebar } from "../components/SeoSidebar";
import { ProductList } from "../components/products/ProductList";
import { ProductEditor } from "../components/products/ProductEditor";
import { TranslationDebugPanel } from "../components/debug/TranslationDebugPanel";
import { useI18n } from "../contexts/I18nContext";
import { useProductFields } from "../hooks/useProductFields";
import { useAISuggestions } from "../hooks/useAISuggestions";
import { handleProductActions } from "../actions/product.actions";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  console.log("[LOADER] Loading products from DATABASE for shop:", session.shop);

  try {
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

    // 2. Fetch products from DATABASE (much faster!)
    const { db } = await import("../db.server");

    const dbProducts = await db.product.findMany({
      where: {
        shop: session.shop,
      },
      include: {
        translations: true,
        images: true,
        options: true,
        metafields: true,
      },
      orderBy: {
        title: "asc",
      },
      take: 50,
    });

    console.log("[LOADER] Loaded", dbProducts.length, "products from database");

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
      images: p.images.map((img) => ({
        url: img.url,
        altText: img.altText,
      })),
      seo: {
        title: p.seoTitle,
        description: p.seoDescription,
      },
      options: p.options.map((opt) => ({
        id: opt.id,
        name: opt.name,
        position: opt.position,
        values: JSON.parse(opt.values),
      })),
      metafields: p.metafields.map((mf) => ({
        id: mf.id,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
        type: mf.type,
      })),
      // IMPORTANT: All translations are already loaded!
      translations: p.translations.map((t) => ({
        key: t.key,
        value: t.value,
        locale: t.locale,
      })),
    }));

    console.log("[LOADER] Total translations loaded:", products.reduce((sum, p) => sum + p.translations.length, 0));

    return json({
      products,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
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
      },
      { status: 500 }
    );
  }
};

export const action = async (args: ActionFunctionArgs) => {
  return handleProductActions(args);
};

export default function Index() {
  const { products, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { t } = useI18n();

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [optionTranslations, setOptionTranslations] = useState<Record<string, { name: string; values: string[] }>>({});

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
  });

  const { aiSuggestions, removeSuggestion } = useAISuggestions(fetcher.data);

  // Auto-refresh: Reload data when actions complete successfully
  // This ensures that webhook updates in the background are reflected in the UI
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // Don't reload for AI suggestions (they're just displayed, not saved yet)
      if ('generatedContent' in fetcher.data || 'translatedValue' in fetcher.data) {
        return; // Skip reload for suggestions
      }

      console.log('[AUTO-REFRESH] Reloading product data from database');
      // Small delay to ensure database transaction is complete
      setTimeout(() => {
        revalidator.revalidate();
      }, 300);
    }
  }, [fetcher.state, fetcher.data]);

  // Handle language change (no more loading needed - all translations pre-loaded!)
  const handleLanguageChange = (newLanguage: string) => {
    console.log('[LANGUAGE-CHANGE] Switching to:', newLanguage);
    setCurrentLanguage(newLanguage);
    // That's it! All translations are already in the product object from the loader
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
      const translations = (fetcher.data as any).translations;
      if (selectedProduct) {
        for (const [locale, fields] of Object.entries(translations as any)) {
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
    const currentValue = { title: editableTitle, description: editableDescription, handle: editableHandle, seoTitle: editableSeoTitle, metaDescription: editableMetaDescription }[fieldType] || "";
    fetcher.submit(
      { action: "generateAIText", productId: selectedProductId, fieldType, currentValue, contextTitle: editableTitle, contextDescription: editableDescription },
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

  const handleTranslateAll = () => {
    if (!selectedProductId || !selectedProduct) return;
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

  return (
    <Page fullWidth>
      <style>{`
        .description-editor h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; }
        .description-editor h2 { font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
        .description-editor h3 { font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
        .description-editor p { margin: 1em 0; }
        .description-editor ul, .description-editor ol { margin: 1em 0; padding-left: 40px; }
      `}</style>
      <MainNavigation />
      <div style={{ height: "calc(100vh - 60px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left: Product List */}
        <div style={{ width: "350px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
          <ProductList
            products={products}
            selectedProductId={selectedProductId}
            onProductSelect={setSelectedProductId}
            searchPlaceholder={t.products.search}
            countLabel={t.products.count}
          />
        </div>

        {/* Middle: Product Editor */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Fehler" tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <ProductEditor
            product={selectedProduct}
            shopLocales={shopLocales}
            primaryLocale={primaryLocale}
            currentLanguage={currentLanguage}
            onLanguageChange={handleLanguageChange}
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
            onTranslateField={handleTranslateField}
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
          />

          {/* Translation Debug Panel */}
          {selectedProduct && (
            <div style={{ marginTop: "1rem" }}>
              <TranslationDebugPanel
                product={selectedProduct}
                shopLocales={shopLocales}
              />
            </div>
          )}
        </div>

        {/* Right: SEO Sidebar */}
        {selectedProduct && currentLanguage === primaryLocale && (
          <div style={{ width: "320px", flexShrink: 0, overflow: "auto" }}>
            <SeoSidebar
              title={editableTitle}
              description={editableDescription}
              handle={editableHandle}
              seoTitle={editableSeoTitle}
              metaDescription={editableMetaDescription}
              imagesWithAlt={selectedProduct.images?.filter((img: any) => img.altText).length || 0}
              totalImages={selectedProduct.images?.length || 0}
            />
          </div>
        )}
      </div>
    </Page>
  );
}

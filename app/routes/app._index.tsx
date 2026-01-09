import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { SeoSidebar } from "../components/SeoSidebar";
import { ProductList } from "../components/products/ProductList";
import { ProductEditor } from "../components/products/ProductEditor";
import { useI18n } from "../contexts/I18nContext";
import { useProductFields } from "../hooks/useProductFields";
import { useAISuggestions } from "../hooks/useAISuggestions";
import { handleProductActions } from "../actions/product.actions";

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
                images(first: 250) {
                  edges {
                    node {
                      altText
                      url
                    }
                  }
                }
                seo {
                  title
                  description
                }
                options {
                  id
                  name
                  position
                  values
                }
                metafields(first: 100) {
                  edges {
                    node {
                      id
                      namespace
                      key
                      value
                      type
                    }
                  }
                }
              }
            }
          }
        }`,
      { variables: { first: 50 } }
    );

    const data = await response.json();
    let products = data.data.products.edges.map((edge: any) => {
      const product = edge.node;
      product.images = product.images?.edges?.map((imgEdge: any) => imgEdge.node) || [];
      product.metafields = product.metafields?.edges?.map((mfEdge: any) => mfEdge.node) || [];
      return product;
    });

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

export const action = async (args: ActionFunctionArgs) => {
  return handleProductActions(args);
};

export default function Index() {
  const { products, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, any[]>>({});
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
    loadedTranslations,
  });

  const { aiSuggestions, removeSuggestion } = useAISuggestions(fetcher.data);

  // Load translations when language changes
  useEffect(() => {
    if (selectedProduct && currentLanguage !== primaryLocale) {
      const itemKey = `${selectedProduct.id}_${currentLanguage}`;
      const hasTranslations = loadedTranslations[itemKey] || selectedProduct.translations?.some(
        (t: any) => t.locale === currentLanguage
      );

      if (!hasTranslations) {
        fetcher.submit(
          { action: "loadTranslations", productId: selectedProduct.id, locale: currentLanguage },
          { method: "POST" }
        );
      }
    }
  }, [selectedProductId, currentLanguage, loadedTranslations]);

  // Handle loaded translations
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const { locale, translations } = fetcher.data as any;
      if (selectedProduct && locale && translations) {
        // Store translations in state by product ID and locale
        const itemKey = `${selectedProduct.id}_${locale}`;
        setLoadedTranslations(prev => ({
          ...prev,
          [itemKey]: translations
        }));
      }
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
        const updatedTranslations = { ...loadedTranslations };

        for (const [locale, fields] of Object.entries(translations as any)) {
          const newTranslations = [];
          if (fields.title) newTranslations.push({ key: "title", value: fields.title, locale });
          if (fields.description) newTranslations.push({ key: "body_html", value: fields.description, locale });
          if (fields.handle) newTranslations.push({ key: "handle", value: fields.handle, locale });
          if (fields.seoTitle) newTranslations.push({ key: "seo_title", value: fields.seoTitle, locale });
          if (fields.metaDescription) newTranslations.push({ key: "seo_description", value: fields.metaDescription, locale });

          // Store in loadedTranslations state
          const itemKey = `${selectedProduct.id}_${locale}`;
          updatedTranslations[itemKey] = newTranslations;

          // If we're currently viewing this locale, update the editable fields
          if (currentLanguage === locale) {
            if (fields.title) setEditableTitle(fields.title);
            if (fields.description) setEditableDescription(fields.description);
            if (fields.handle) setEditableHandle(fields.handle);
            if (fields.seoTitle) setEditableSeoTitle(fields.seoTitle);
            if (fields.metaDescription) setEditableMetaDescription(fields.metaDescription);
          }
        }

        // Update state once with all translations
        setLoadedTranslations(updatedTranslations);
      }
    }
  }, [fetcher.data, currentLanguage]);

  // Update translations in state after saving
  useEffect(() => {
    if (fetcher.data?.success &&
        !('translations' in fetcher.data) &&
        !('generatedContent' in fetcher.data) &&
        !('translatedValue' in fetcher.data) &&
        !('translatedName' in fetcher.data) &&
        selectedProduct &&
        currentLanguage !== primaryLocale) {
      // This was a successful updateProduct action for a translation
      const itemKey = `${selectedProduct.id}_${currentLanguage}`;

      // Build updated translations array
      const existingTranslations = loadedTranslations[itemKey] || [];
      const updatedTranslations = [...existingTranslations];

      // Helper to update or add a translation
      const updateTranslation = (key: string, value: string) => {
        const index = updatedTranslations.findIndex(t => t.key === key && t.locale === currentLanguage);
        if (index >= 0) {
          updatedTranslations[index] = { key, value, locale: currentLanguage };
        } else {
          updatedTranslations.push({ key, value, locale: currentLanguage });
        }
      };

      // Update translations with current editable values
      if (editableTitle) updateTranslation("title", editableTitle);
      if (editableDescription) updateTranslation("body_html", editableDescription);
      if (editableHandle) updateTranslation("handle", editableHandle);
      if (editableSeoTitle) updateTranslation("seo_title", editableSeoTitle);
      if (editableMetaDescription) updateTranslation("seo_description", editableMetaDescription);

      // Update state
      setLoadedTranslations(prev => ({
        ...prev,
        [itemKey]: updatedTranslations
      }));
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
            onLanguageChange={setCurrentLanguage}
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

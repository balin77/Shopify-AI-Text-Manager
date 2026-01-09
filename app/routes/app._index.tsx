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

  // Load translations when language changes
  useEffect(() => {
    if (selectedProduct && currentLanguage !== primaryLocale) {
      const hasTranslations = selectedProduct.translations?.some(
        (t: any) => t.locale === currentLanguage
      );

      if (!hasTranslations) {
        fetcher.submit(
          { action: "loadTranslations", productId: selectedProduct.id, locale: currentLanguage },
          { method: "POST" }
        );
      }
    }
  }, [selectedProductId, currentLanguage]);

  // Handle loaded translations
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const { locale, translations } = fetcher.data as any;
      if (selectedProduct && locale) {
        selectedProduct.translations = [
          ...selectedProduct.translations.filter((t: any) => t.locale !== locale),
          ...translations
        ];
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
        for (const [locale, fields] of Object.entries(translations as any)) {
          const newTranslations = [];
          if (fields.title) newTranslations.push({ key: "title", value: fields.title, locale });
          if (fields.description) newTranslations.push({ key: "body_html", value: fields.description, locale });
          if (fields.handle) newTranslations.push({ key: "handle", value: fields.handle, locale });
          if (fields.seoTitle) newTranslations.push({ key: "seo_title", value: fields.seoTitle, locale });
          if (fields.metaDescription) newTranslations.push({ key: "seo_description", value: fields.metaDescription, locale });

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

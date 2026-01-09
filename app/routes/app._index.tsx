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
  Modal,
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

    // Fetch products with all translations
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
                translations {
                  key
                  value
                  locale
                }
              }
            }
          }
        }`,
      { variables: { first: 50 } }
    );

    const data = await response.json();
    const products = data.data.products.edges.map((edge: any) => edge.node);

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

  // Load AI settings from database
  const { db } = await import("../db.server");
  const aiSettings = await db.aISettings.findUnique({
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

  if (action === "generateAIText") {
    const fieldType = formData.get("fieldType") as string;
    const currentValue = formData.get("currentValue") as string;
    const contextTitle = formData.get("contextTitle") as string;
    const contextDescription = formData.get("contextDescription") as string;

    try {
      let generatedContent = "";

      if (fieldType === "title") {
        generatedContent = await aiService.generateProductTitle(contextDescription || currentValue);
      } else if (fieldType === "description") {
        generatedContent = await aiService.generateProductDescription(contextTitle, currentValue);
      } else if (fieldType === "handle") {
        const prompt = `Erstelle einen SEO-freundlichen URL-Slug (handle) für dieses Produkt:
Titel: ${contextTitle}
Beschreibung: ${contextDescription}

Der Slug sollte:
- Nur Kleinbuchstaben und Bindestriche enthalten
- Keine Sonderzeichen oder Umlaute haben
- Kurz und prägnant sein (2-5 Wörter)
- SEO-optimiert sein

Gib nur den Slug zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
        generatedContent = generatedContent.toLowerCase().trim();
      } else if (fieldType === "seoTitle") {
        const prompt = `Erstelle einen optimierten SEO-Titel für dieses Produkt:
Titel: ${contextTitle}
Beschreibung: ${contextDescription}

Der SEO-Titel sollte:
- Max. 60 Zeichen lang sein
- Keywords enthalten
- Zum Klicken anregen
- Den Produktnutzen kommunizieren

Gib nur den SEO-Titel zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductTitle(prompt);
      } else if (fieldType === "metaDescription") {
        const prompt = `Erstelle eine optimierte Meta-Description für dieses Produkt:
Titel: ${contextTitle}
Beschreibung: ${contextDescription}

Die Meta-Description sollte:
- 150-160 Zeichen lang sein
- Keywords enthalten
- Zum Klicken anregen
- Den Produktnutzen klar kommunizieren
- Einen Call-to-Action enthalten

Gib nur die Meta-Description zurück, ohne Erklärungen.`;
        generatedContent = await aiService.generateProductDescription(contextTitle, prompt);
      }

      return json({ success: true, generatedContent, fieldType });
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

      const translations = await translationService.translateProduct(changedFields);

      return json({ success: true, translations });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "updateProduct") {
    const title = formData.get("title") as string;
    const descriptionHtml = formData.get("descriptionHtml") as string;
    const handle = formData.get("handle") as string;
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;

    try {
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

  // Load product data
  useEffect(() => {
    if (selectedProduct) {
      setEditableTitle(selectedProduct.title);
      setEditableDescription(selectedProduct.descriptionHtml || "");
      setEditableHandle(selectedProduct.handle);
      setEditableSeoTitle(selectedProduct.seo?.title || "");
      setEditableMetaDescription(selectedProduct.seo?.description || "");
      setHasChanges(false);
    }
  }, [selectedProduct]);

  // Track changes
  useEffect(() => {
    if (selectedProduct) {
      const titleChanged = editableTitle !== selectedProduct.title;
      const descChanged = editableDescription !== (selectedProduct.descriptionHtml || "");
      const handleChanged = editableHandle !== selectedProduct.handle;
      const seoTitleChanged = editableSeoTitle !== (selectedProduct.seo?.title || "");
      const metaDescChanged = editableMetaDescription !== (selectedProduct.seo?.description || "");
      setHasChanges(titleChanged || descChanged || handleChanged || seoTitleChanged || metaDescChanged);
    }
  }, [editableTitle, editableDescription, editableHandle, editableSeoTitle, editableMetaDescription, selectedProduct]);

  const handleSaveProduct = () => {
    if (!selectedProductId || !hasChanges) return;

    fetcher.submit(
      {
        action: "updateProduct",
        productId: selectedProductId,
        title: editableTitle,
        descriptionHtml: editableDescription,
        handle: editableHandle,
        seoTitle: editableSeoTitle,
        metaDescription: editableMetaDescription,
      },
      { method: "POST" }
    );
  };

  const handleGenerateAI = (fieldType: "title" | "description") => {
    if (!selectedProductId) return;

    const currentValue = fieldType === "title" ? editableTitle : editableDescription;

    fetcher.submit(
      {
        action: "generateAIText",
        productId: selectedProductId,
        fieldType,
        currentValue,
      },
      { method: "POST" }
    );
  };

  const handleTranslateAll = () => {
    if (!selectedProductId) return;

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
      setAiGeneratedContent((fetcher.data as any).generatedContent);
      setAiFieldType((fetcher.data as any).fieldType);
      setAiModalActive(true);
    }
  }, [fetcher.data]);

  const handleAcceptAI = () => {
    if (aiFieldType === "title") {
      setEditableTitle(aiGeneratedContent);
    } else if (aiFieldType === "description") {
      setEditableDescription(aiGeneratedContent);
    }
    setAiModalActive(false);
  };

  return (
    <Page title={`ContentPilot AI - ${shop}`}>
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
                  {Object.entries(LANGUAGES).map(([code, name]) => (
                    <Button
                      key={code}
                      variant={currentLanguage === code ? "primary" : undefined}
                      onClick={() => setCurrentLanguage(code)}
                      size="slim"
                    >
                      {name}
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
                    {currentLanguage === "de" && (
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
                  <TextField
                    label={`Produkttitel (${LANGUAGES[currentLanguage as keyof typeof LANGUAGES]})`}
                    value={editableTitle}
                    onChange={setEditableTitle}
                    autoComplete="off"
                    helpText={`${editableTitle.length} Zeichen`}
                  />
                  <div style={{ marginTop: "0.5rem" }}>
                    <Button size="slim" onClick={() => handleGenerateAI("title")} loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "title"}>
                      ✨ Mit KI generieren / verbessern
                    </Button>
                  </div>
                </div>

                {/* Editable Description */}
                <div>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">Produktbeschreibung ({LANGUAGES[currentLanguage as keyof typeof LANGUAGES]})</Text>
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
                        background: "white",
                        lineHeight: "1.6",
                      }}
                    />
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">{editableDescription.replace(/<[^>]*>/g, "").length} Zeichen</Text>
                  <div style={{ marginTop: "0.5rem" }}>
                    <Button size="slim" onClick={() => handleGenerateAI("description")} loading={fetcher.state !== "idle" && fetcher.formData?.get("fieldType") === "description"}>
                      ✨ Mit KI generieren / verbessern
                    </Button>
                  </div>
                </div>

                {/* URL Slug */}
                <TextField
                  label={`URL-Slug (${LANGUAGES[currentLanguage as keyof typeof LANGUAGES]})`}
                  value={editableHandle}
                  onChange={setEditableHandle}
                  autoComplete="off"
                />

                {/* SEO Title */}
                <TextField
                  label={`SEO-Titel (${LANGUAGES[currentLanguage as keyof typeof LANGUAGES]})`}
                  value={editableSeoTitle}
                  onChange={setEditableSeoTitle}
                  autoComplete="off"
                  helpText={`${editableSeoTitle.length} Zeichen (empfohlen: 50-60)`}
                />

                {/* Meta Description */}
                <TextField
                  label={`Meta-Beschreibung (${LANGUAGES[currentLanguage as keyof typeof LANGUAGES]})`}
                  value={editableMetaDescription}
                  onChange={setEditableMetaDescription}
                  multiline={3}
                  autoComplete="off"
                  helpText={`${editableMetaDescription.length} Zeichen (empfohlen: 150-160)`}
                />
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">Wähle ein Produkt aus der Liste</Text>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* AI Suggestion Modal */}
      <Modal
        open={aiModalActive}
        onClose={() => setAiModalActive(false)}
        title="KI-generierter Vorschlag"
        primaryAction={{
          content: "Übernehmen",
          onAction: handleAcceptAI,
        }}
        secondaryActions={[{ content: "Ablehnen", onAction: () => setAiModalActive(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd"><strong>Generierter {aiFieldType === "title" ? "Titel" : "Beschreibung"}:</strong></Text>
            <div style={{ padding: "12px", background: "#f6f6f7", borderRadius: "8px", whiteSpace: "pre-wrap" }}>
              {aiGeneratedContent}
            </div>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

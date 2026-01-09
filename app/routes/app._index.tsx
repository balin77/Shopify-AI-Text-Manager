import { useState, useRef, useEffect } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Get all products with GraphQL
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
      {
        variables: {
          first: 50,
        },
      }
    );

    const data = await response.json();
    const products = data.data.products.edges.map((edge: any) => edge.node);

    return json({
      products,
      shop: session.shop,
      error: null,
    });
  } catch (error: any) {
    return json({ products: [], shop: session.shop, error: error.message }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const action = formData.get("action");
  const productId = formData.get("productId") as string;

  const aiService = new AIService(process.env.AI_PROVIDER as any || "huggingface");

  if (action === "generateSEO") {
    try {
      // Get product details
      const response = await admin.graphql(
        `#graphql
          query getProduct($id: ID!) {
            product(id: $id) {
              id
              title
              description
            }
          }`,
        {
          variables: { id: productId },
        }
      );

      const data = await response.json();
      const product = data.data.product;

      const suggestion = await aiService.generateSEO(
        product.title,
        product.description || ""
      );

      return json({ success: true, suggestion });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "applySEO") {
    const seoTitle = formData.get("seoTitle") as string;
    const metaDescription = formData.get("metaDescription") as string;

    try {
      const response = await admin.graphql(
        `#graphql
          mutation updateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
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

      return json({ success: true });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "updateProduct") {
    const title = formData.get("title") as string;
    const descriptionHtml = formData.get("descriptionHtml") as string;

    try {
      const response = await admin.graphql(
        `#graphql
          mutation updateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                title
                descriptionHtml
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
              descriptionHtml,
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
  const { products, shop, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // State
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [modalActive, setModalActive] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const productsPerPage = 10;

  // Rich text editor state
  const [editableTitle, setEditableTitle] = useState("");
  const [editableDescription, setEditableDescription] = useState("");
  const [descriptionMode, setDescriptionMode] = useState<"html" | "rendered">("rendered");
  const descriptionEditorRef = useRef<HTMLDivElement>(null);

  // Filter products by search
  const filteredProducts = products.filter((p: any) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Pagination
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  const startIndex = (currentPage - 1) * productsPerPage;
  const paginatedProducts = filteredProducts.slice(startIndex, startIndex + productsPerPage);

  // Get selected product
  const selectedProduct = products.find((p: any) => p.id === selectedProductId);

  // Load product data into editable fields
  useEffect(() => {
    if (selectedProduct) {
      setEditableTitle(selectedProduct.title);
      setEditableDescription(selectedProduct.descriptionHtml || "");
      setHasChanges(false);
    }
  }, [selectedProduct]);

  // Track changes
  useEffect(() => {
    if (selectedProduct) {
      const titleChanged = editableTitle !== selectedProduct.title;
      const descChanged = editableDescription !== (selectedProduct.descriptionHtml || "");
      setHasChanges(titleChanged || descChanged);
    }
  }, [editableTitle, editableDescription, selectedProduct]);

  const handleGenerateSEO = (productId: string) => {
    setSelectedProductId(productId);
    fetcher.submit(
      { action: "generateSEO", productId },
      { method: "POST" }
    );
  };

  const handleApplySEO = () => {
    if (!selectedProductId) return;

    fetcher.submit(
      {
        action: "applySEO",
        productId: selectedProductId,
        seoTitle,
        metaDescription,
      },
      { method: "POST" }
    );

    setModalActive(false);
  };

  const handleSaveProduct = () => {
    if (!selectedProductId || !hasChanges) return;

    fetcher.submit(
      {
        action: "updateProduct",
        productId: selectedProductId,
        title: editableTitle,
        descriptionHtml: editableDescription,
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

    // Update state with new HTML
    setEditableDescription(descriptionEditorRef.current.innerHTML);
  };

  const toggleDescriptionMode = () => {
    if (descriptionMode === "rendered") {
      // Switch to HTML mode
      setDescriptionMode("html");
    } else {
      // Switch to rendered mode
      setDescriptionMode("rendered");
    }
  };

  // When SEO suggestion is generated, open modal
  if (fetcher.data?.success && (fetcher.data as any).suggestion && !modalActive) {
    const suggestion = (fetcher.data as any).suggestion;
    setSeoTitle(suggestion.seoTitle);
    setMetaDescription(suggestion.metaDescription);
    setModalActive(true);
  }

  return (
    <Page title={`ContentPilot AI - ${shop}`}>
      <div style={{ height: "100vh", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left: Product List - Fixed Width */}
        <div style={{ width: "350px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Produkte ({filteredProducts.length})
                </Text>
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
                          <Thumbnail
                            source={featuredImage.url}
                            alt={featuredImage.altText || title}
                            size="small"
                          />
                        ) : undefined
                      }
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                          {title}
                        </Text>
                        <Badge tone={status === "ACTIVE" ? "success" : undefined}>
                          {status}
                        </Badge>
                      </BlockStack>
                    </ResourceItem>
                  );
                }}
              />
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ padding: "1rem", borderTop: "1px solid #e1e3e5" }}>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {startIndex + 1}-{Math.min(startIndex + productsPerPage, filteredProducts.length)} von {filteredProducts.length}
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      icon={ChevronLeftIcon}
                      onClick={() => setCurrentPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      accessibilityLabel="Vorherige Seite"
                    />
                    <Text as="span" variant="bodySm">
                      {currentPage} / {totalPages}
                    </Text>
                    <Button
                      icon={ChevronRightIcon}
                      onClick={() => setCurrentPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      accessibilityLabel="Nächste Seite"
                    />
                  </InlineStack>
                </InlineStack>
              </div>
            )}
          </Card>
        </div>

        {/* Right: Product Detail - Full Width */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Fehler" tone="critical">
                <p>{error}</p>
              </Banner>
            </div>
          )}

          {fetcher.data?.success && !(fetcher.data as any).suggestion && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title="Erfolg!" tone="success" onDismiss={() => {}}>
                <p>Änderungen erfolgreich gespeichert!</p>
              </Banner>
            </div>
          )}

          <Card padding="600">
            {selectedProduct ? (
              <BlockStack gap="500">
                {/* Header with Save Button */}
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={selectedProduct.status === "ACTIVE" ? "success" : undefined}>
                      {selectedProduct.status}
                    </Badge>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Handle: {selectedProduct.handle}
                    </Text>
                  </InlineStack>
                  <Button
                    variant={hasChanges ? "primary" : undefined}
                    onClick={handleSaveProduct}
                    disabled={!hasChanges}
                    loading={fetcher.state !== "idle" && fetcher.formData?.get("action") === "updateProduct"}
                  >
                    Änderungen speichern
                  </Button>
                </InlineStack>

                {/* Featured Image */}
                {selectedProduct.featuredImage && (
                  <img
                    src={selectedProduct.featuredImage.url}
                    alt={selectedProduct.title}
                    style={{ width: "100%", maxWidth: "300px", borderRadius: "8px" }}
                  />
                )}

                {/* Editable Title */}
                <TextField
                  label="Produkttitel"
                  value={editableTitle}
                  onChange={setEditableTitle}
                  autoComplete="off"
                  helpText={`${editableTitle.length} Zeichen`}
                />

                {/* Editable Description with Formatting Toolbar */}
                <div>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Produktbeschreibung
                    </Text>
                    <Button
                      size="slim"
                      onClick={toggleDescriptionMode}
                    >
                      {descriptionMode === "html" ? "Vorschau" : "HTML"}
                    </Button>
                  </InlineStack>

                  {descriptionMode === "rendered" && (
                    <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.25rem", flexWrap: "wrap", padding: "0.5rem", background: "#f6f6f7", border: "1px solid #c9cccf", borderRadius: "8px 8px 0 0" }}>
                      <ButtonGroup variant="segmented">
                        <Button size="slim" onClick={() => handleFormatText("bold")}><strong>B</strong></Button>
                        <Button size="slim" onClick={() => handleFormatText("italic")}><em>I</em></Button>
                        <Button size="slim" onClick={() => handleFormatText("underline")}><u>U</u></Button>
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
                  <Text as="p" variant="bodySm" tone="subdued">
                    {editableDescription.replace(/<[^>]*>/g, "").length} Zeichen
                  </Text>
                </div>

                {/* SEO Section */}
                <div style={{ marginTop: "2rem", paddingTop: "2rem", borderTop: "2px solid #e1e3e5" }}>
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingMd">
                      SEO Optimierung
                    </Text>
                    <BlockStack gap="200">
                      <div>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          SEO Titel:
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {selectedProduct.seo?.title || "Nicht gesetzt"}
                        </Text>
                      </div>
                      <div>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Meta-Beschreibung:
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {selectedProduct.seo?.description || "Nicht gesetzt"}
                        </Text>
                      </div>
                    </BlockStack>
                    <Button
                      variant="primary"
                      onClick={() => handleGenerateSEO(selectedProduct.id)}
                      loading={fetcher.state !== "idle" && selectedProductId === selectedProduct.id}
                    >
                      SEO mit KI optimieren
                    </Button>
                  </BlockStack>
                </div>
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">
                  Wähle ein Produkt aus der Liste
                </Text>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={modalActive}
        onClose={() => setModalActive(false)}
        title="KI-generierte SEO-Vorschläge"
        primaryAction={{
          content: "Übernehmen",
          onAction: handleApplySEO,
          loading: fetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Abbrechen",
            onAction: () => setModalActive(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="SEO-Titel"
              value={seoTitle}
              onChange={setSeoTitle}
              autoComplete="off"
              helpText={`${seoTitle.length} Zeichen (optimal: 50-60)`}
            />
            <TextField
              label="Meta-Beschreibung"
              value={metaDescription}
              onChange={setMetaDescription}
              multiline={4}
              autoComplete="off"
              helpText={`${metaDescription.length} Zeichen (optimal: 150-160)`}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

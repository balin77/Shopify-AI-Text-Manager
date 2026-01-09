import { useState } from "react";
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
} from "@shopify/polaris";
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

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function Index() {
  const { products, shop, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [modalActive, setModalActive] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");

  // Get selected product
  const selectedProduct = products.find((p: any) => p.id === selectedProductId);

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

  // When SEO suggestion is generated, open modal
  if (fetcher.data?.success && (fetcher.data as any).suggestion && !modalActive) {
    const suggestion = (fetcher.data as any).suggestion;
    setSeoTitle(suggestion.seoTitle);
    setMetaDescription(suggestion.metaDescription);
    setModalActive(true);
  }

  return (
    <Page title={`SEO Optimizer - ${shop}`}>
      <Layout>
        {error && (
          <Layout.Section>
            <Banner title="Fehler" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}

        {fetcher.data?.success && !(fetcher.data as any).suggestion && (
          <Layout.Section>
            <Banner title="Erfolg!" tone="success" onDismiss={() => {}}>
              <p>SEO-Daten erfolgreich gespeichert!</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "350px 1fr", gap: "1rem" }}>
            {/* Left: Product List */}
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Produkte ({products.length})
                </Text>
                <div style={{ maxHeight: "calc(100vh - 300px)", overflowY: "auto" }}>
                  <ResourceList
                    resourceName={{ singular: "Produkt", plural: "Produkte" }}
                    items={products}
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
              </BlockStack>
            </Card>

            {/* Right: Product Detail */}
            <Card padding="600">
              {selectedProduct ? (
                <BlockStack gap="500">
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingLg">
                      {selectedProduct.title}
                    </Text>
                    <InlineStack gap="200" align="start">
                      <Badge tone={selectedProduct.status === "ACTIVE" ? "success" : undefined}>
                        {selectedProduct.status}
                      </Badge>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Handle: {selectedProduct.handle}
                      </Text>
                    </InlineStack>
                  </BlockStack>

                  {selectedProduct.featuredImage && (
                    <img
                      src={selectedProduct.featuredImage.url}
                      alt={selectedProduct.title}
                      style={{ width: "100%", maxWidth: "300px", borderRadius: "8px" }}
                    />
                  )}

                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Aktuelle SEO-Daten
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
                  </BlockStack>

                  <Button
                    variant="primary"
                    onClick={() => handleGenerateSEO(selectedProduct.id)}
                    loading={fetcher.state !== "idle" && selectedProductId === selectedProduct.id}
                    fullWidth
                  >
                    🤖 SEO mit KI optimieren
                  </Button>
                </BlockStack>
              ) : (
                <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                  <Text as="p" variant="headingLg" tone="subdued">
                    📦
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    Wähle ein Produkt aus der Liste
                  </Text>
                </div>
              )}
            </Card>
          </div>
        </Layout.Section>
      </Layout>

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

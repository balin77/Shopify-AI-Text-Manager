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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { AIService } from "../../src/services/ai.service";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Use Shopify Admin GraphQL API directly
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
                featuredImage {
                  url
                  altText
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
      error: null,
    });
  } catch (error: any) {
    return json({ products: [], error: error.message }, { status: 500 });
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
      // Get product details via GraphQL
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
      // Update product SEO via GraphQL
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

export default function Products() {
  const { products, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [modalActive, setModalActive] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");

  const handleGenerateSEO = (productId: string) => {
    setSelectedProduct(productId);
    fetcher.submit(
      { action: "generateSEO", productId },
      { method: "POST" }
    );
  };

  const handleApplySEO = () => {
    if (!selectedProduct) return;

    fetcher.submit(
      {
        action: "applySEO",
        productId: selectedProduct,
        seoTitle,
        metaDescription,
      },
      { method: "POST" }
    );

    setModalActive(false);
    setSelectedProduct(null);
  };

  // Wenn SEO-Suggestion generiert wurde, Modal öffnen
  if (fetcher.data?.success && (fetcher.data as any).suggestion && !modalActive) {
    const suggestion = (fetcher.data as any).suggestion;
    setSeoTitle(suggestion.seoTitle);
    setMetaDescription(suggestion.metaDescription);
    setModalActive(true);
  }

  return (
    <Page
      title="Produkte"
      backAction={{ url: "/app" }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner title="Fehler" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            <ResourceList
              resourceName={{ singular: "Produkt", plural: "Produkte" }}
              items={products}
              renderItem={(item) => {
                const { id, title, handle, status, featuredImage } = item;

                return (
                  <ResourceItem
                    id={id}
                    onClick={() => {}}
                    media={
                      featuredImage ? (
                        <img
                          src={featuredImage.url}
                          alt={featuredImage.altText || title}
                          style={{ width: 50, height: 50, objectFit: "cover" }}
                        />
                      ) : undefined
                    }
                  >
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="h3" variant="bodyMd" fontWeight="bold">
                          {title}
                        </Text>
                        <Badge tone={status === "ACTIVE" ? "success" : undefined}>
                          {status}
                        </Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Handle: {handle}
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          onClick={() => handleGenerateSEO(id)}
                          loading={fetcher.state !== "idle" && selectedProduct === id}
                        >
                          SEO optimieren
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </ResourceItem>
                );
              }}
            />
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalActive}
        onClose={() => setModalActive(false)}
        title="SEO-Vorschlag"
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
            />
            <TextField
              label="Meta-Beschreibung"
              value={metaDescription}
              onChange={setMetaDescription}
              multiline={4}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

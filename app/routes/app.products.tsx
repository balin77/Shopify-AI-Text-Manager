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
import { ProductService } from "../../src/services/product.service";
import { AIService } from "../../src/services/ai.service";
import { ShopifyConnector } from "../../src/shopify-connector";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Verwende deine bestehenden Services
  const connector = new ShopifyConnector();
  const productService = new ProductService(connector);

  try {
    const products = await productService.getAllProducts(50);

    return json({
      products: products.map((p: any) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        status: p.status,
        featuredImage: p.featuredImage,
      })),
      error: null,
    });
  } catch (error: any) {
    return json({ products: [], error: error.message }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const action = formData.get("action");
  const productId = formData.get("productId") as string;

  const connector = new ShopifyConnector();
  const productService = new ProductService(connector);
  const aiService = new AIService(process.env.AI_PROVIDER as any || "huggingface");

  if (action === "generateSEO") {
    try {
      const product = await productService.getProductDetails(productId);
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
      await productService.updateProduct(productId, {
        seoTitle,
        metaDescription,
      });

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

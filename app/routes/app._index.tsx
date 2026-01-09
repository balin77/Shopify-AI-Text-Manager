import { useEffect } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return json({
    shop: session.shop,
    apiKey: process.env.SHOPIFY_API_KEY,
  });
};

export default function Index() {
  const { shop, apiKey } = useLoaderData<typeof loader>();

  return (
    <Page title="Shopify SEO Optimizer">
      <Layout>
        <Layout.Section>
          <Banner title="Willkommen!" tone="success">
            <p>
              Deine Shopify SEO Optimizer App ist erfolgreich installiert für Shop: <strong>{shop}</strong>
            </p>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Features
              </Text>
              <BlockStack gap="200">
                <Text as="p">
                  🤖 KI-gestützte SEO-Optimierung mit mehreren AI-Providern
                </Text>
                <Text as="p">
                  🌍 Automatische Übersetzungen in 5 Sprachen
                </Text>
                <Text as="p">
                  📊 SEO-Score-Berechnung mit Verbesserungsvorschlägen
                </Text>
              </BlockStack>

              <Link to="/app/products" style={{ textDecoration: 'none' }}>
                <Button
                  variant="primary"
                >
                  Produkte verwalten
                </Button>
              </Link>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Nächste Schritte
              </Text>
              <Text as="p">
                1. Gehe zu "Produkte verwalten" um deine Produkte zu optimieren
              </Text>
              <Text as="p">
                2. Wähle ein Produkt aus und lass die KI SEO-Texte generieren
              </Text>
              <Text as="p">
                3. Übersetze deine Inhalte automatisch in mehrere Sprachen
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

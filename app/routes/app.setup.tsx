import { json, redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
  Box,
  Badge,
  Divider,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// Block handle inside the storefront theme extension. The extension itself
// is identified in Shopify deep links by the app's api_key (client_id), not
// by the local toml UID or handle.
const BLOCK_HANDLE = "variant-gallery";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Production lock — the Variant Gallery feature set is hidden behind the
  // production lock while under Shopify review (see planUtils.isProductionLocked).
  // Keep this route gated like every other Variant Gallery element so it never
  // surfaces on production/master.
  const { isProductionLocked } = await import("../utils/planUtils");
  if (isProductionLocked()) {
    // Preserve Shopify session params (shop, host, …) across the redirect.
    // Dropping them leaves the URL param-less; the next full-page navigation
    // (useAppNavigation reads window.location.search) then reloads without
    // shop/host, auth fails in app.tsx, and the user lands on a blank page.
    const search = new URL(request.url).search;
    return redirect(`/app/products${search}`);
  }

  return json({
    shop: session.shop,
    shopifyApiKey: (process.env.SHOPIFY_API_KEY || "").trim(),
  });
};

function StepRow({ number, title, description }: { number: number; title: string; description: string }) {
  return (
    <InlineStack gap="400" align="start" blockAlign="start">
      <Box
        width="32px"
        minHeight="32px"
        background="bg-fill-brand"
        borderRadius="full"
        padding="150"
      >
        <InlineStack align="center" blockAlign="center">
          <Text as="span" variant="bodyMd" fontWeight="bold" tone="text-inverse">
            {number}
          </Text>
        </InlineStack>
      </Box>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="semibold">
          {title}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {description}
        </Text>
      </BlockStack>
    </InlineStack>
  );
}

export default function SetupPage() {
  const { shop, shopifyApiKey } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const themeEditorUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${shopifyApiKey}/${BLOCK_HANDLE}`;

  return (
    <Page
      title="Setup: Variant Gallery"
      subtitle="Activate the Variant Gallery block in your theme to display variant-specific images"
      backAction={{ content: "Products", onAction: () => navigate("/app/products") }}
    >
      <BlockStack gap="500">
        <Banner title="Theme extension activation required" tone="info">
          <p>
            The Variant Gallery is a theme app extension. To use it on your storefront,
            you need to add it to your theme once in the Theme Editor. This takes less than a minute.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="500">
            <BlockStack gap="200">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  How to activate Variant Gallery
                </Text>
                <Badge tone="info">One-time setup</Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Follow these steps to add the Variant Gallery block to your product pages.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <StepRow
                number={1}
                title="Open the Theme Editor"
                description="Click the button below to go directly to the Theme Editor with the Variant Gallery extension pre-selected."
              />
              <StepRow
                number={2}
                title='Click "Add block" on a product page template'
                description='In the Theme Editor, navigate to a product page template, then click "Add block" in the left sidebar under your product section.'
              />
              <StepRow
                number={3}
                title='Select "Variant Gallery" from the app blocks list'
                description='Find "Variant Gallery" under the "Apps" section in the block picker and click it to add it.'
              />
              <StepRow
                number={4}
                title="Position the block and save"
                description='Drag the Variant Gallery block to the desired position on your product page, then click "Save" in the top right corner.'
              />
            </BlockStack>

            <Divider />

            <InlineStack gap="300" align="start">
              <Button
                variant="primary"
                url={themeEditorUrl}
                target="_blank"
                size="large"
              >
                Open Theme Editor
              </Button>
              <Button
                variant="secondary"
                onClick={() => navigate("/app/products")}
              >
                Skip for now
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              What does Variant Gallery do?
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              The Variant Gallery extension displays variant-specific images on your product pages.
              When a customer selects a product variant, only the images assigned to that variant
              are shown — giving shoppers a cleaner, more focused browsing experience.
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              You manage which images belong to which variants directly inside ContentPilot,
              on the Products page.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

/**
 * UI to clear sessions and force re-authentication
 */

import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Card, Text, BlockStack, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return json({
    shop: session.shop,
  });
};

export default function ClearSessionPage() {
  const { shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [cleared, setCleared] = useState(false);

  const handleClearSessions = () => {
    const formData = new FormData();
    formData.append("shop", shop);

    fetcher.submit(formData, {
      method: "post",
      action: "/api/clear-session"
    });

    setCleared(true);
  };

  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
  const result = fetcher.data as any;

  return (
    <Page title="Clear Sessions">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Force Re-Authentication</Text>
            <Text as="p">
              Use this if you've updated API scopes and the app still uses old permissions.
              This will delete all sessions for shop <strong>{shop}</strong> and force a new authentication.
            </Text>

            <Banner tone="warning">
              <BlockStack gap="200">
                <Text as="p" fontWeight="semibold">Warning:</Text>
                <Text as="p">After clearing sessions, you'll need to:</Text>
                <ol style={{ marginLeft: '20px' }}>
                  <li>Close the app completely</li>
                  <li>Go to Shopify Admin → Apps</li>
                  <li>Click on ContentPilot AI to re-open</li>
                  <li>The app will create a new session with updated scopes</li>
                </ol>
              </BlockStack>
            </Banner>

            <Button
              primary
              onClick={handleClearSessions}
              loading={isLoading}
              disabled={cleared && result?.success}
            >
              {cleared && result?.success ? "Sessions Cleared ✓" : "Clear Sessions"}
            </Button>

            {result && (
              <Banner tone={result.success ? "success" : "critical"}>
                <Text as="p">
                  {result.success
                    ? `✓ ${result.message || 'Sessions cleared successfully'}`
                    : `✗ ${result.error || 'Failed to clear sessions'}`
                  }
                </Text>
              </Banner>
            )}

            {cleared && result?.success && (
              <Banner tone="info">
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">Next Steps:</Text>
                  <ol style={{ marginLeft: '20px' }}>
                    <li>Close this app tab completely</li>
                    <li>Go to Shopify Admin → Apps</li>
                    <li>Click ContentPilot AI</li>
                    <li>The app will re-authenticate with new scopes</li>
                    <li>Check /app/debug-scopes to verify scopes</li>
                  </ol>
                </BlockStack>
              </Banner>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

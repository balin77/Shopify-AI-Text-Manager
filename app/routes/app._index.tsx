/**
 * App Index - Initial Setup or Redirect
 *
 * This route:
 * 1. Shows a setup page with progress bar if no products exist yet
 * 2. Redirects to the products page if setup is already complete
 */

import { useEffect, useState } from "react";
import { useNavigate, useLoaderData } from "@remix-run/react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Page, Card, BlockStack, Text, Banner, Spinner, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useSyncProgress, SyncProgress } from "../components/SyncProgressBar";
import { ProgressBar, Box } from "@shopify/polaris";

const phaseLabels: Record<string, string> = {
  products: "Products",
  collections: "Collections",
  articles: "Articles",
  pages: "Pages",
  policies: "Policies",
  themes: "Themes",
  metaobjects: "Metaobjects",
};

const phaseOrder = ["products", "collections", "articles", "pages", "policies", "themes", "metaobjects"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Gate onboarding on the explicit "initial full sync completed" marker —
  // NOT on db.product.count. A Remix prefetch of the products loader upserts
  // products into the DB before the initial sync runs, so a count-based gate
  // would mark setup done and skip the bulk translation fetch forever.
  // null marker (or no install-state row yet) → run onboarding (self-correcting).
  const installState = await db.shopInstallState.findUnique({
    where: { shop },
    select: { initialSyncCompletedAt: true },
  });

  return json({
    needsSetup: !installState?.initialSyncCompletedAt,
    shop,
  });
};

function SyncProgressDisplay({ progress }: { progress: SyncProgress }) {
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            Setting up your store
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {progress.current}%
          </Text>
        </InlineStack>
        <ProgressBar progress={progress.current} size="small" />
        <InlineStack gap="300" wrap={true}>
          {phaseOrder.map((phase) => {
            const isCompleted = progress.completedPhases.includes(phase);
            const isCurrent = progress.phase === phase;
            return (
              <Text
                key={phase}
                as="span"
                variant="bodySm"
                tone={isCompleted ? "success" : isCurrent ? "base" : "subdued"}
                fontWeight={isCurrent ? "semibold" : "regular"}
              >
                {isCompleted ? "✓ " : isCurrent ? "● " : "○ "}
                {phaseLabels[phase]}
              </Text>
            );
          })}
        </InlineStack>
        {progress.detailTotal && progress.detailTotal > 1 && (
          <Box paddingBlockStart="200">
            <BlockStack gap="100">
              <InlineStack align="space-between">
                <Text as="p" variant="bodySm" tone="subdued">
                  {progress.detailMessage || `${progress.detailCurrent}/${progress.detailTotal}`}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {progress.detailCurrent}/{progress.detailTotal}
                </Text>
              </InlineStack>
              <ProgressBar
                progress={Math.round(((progress.detailCurrent || 0) / progress.detailTotal) * 100)}
                size="small"
                tone="highlight"
              />
            </BlockStack>
          </Box>
        )}
        <Text as="p" variant="bodySm" tone="subdued">
          {progress.message}
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function AppIndex() {
  const navigate = useNavigate();
  const { needsSetup } = useLoaderData<typeof loader>();
  const { syncProgress, syncComplete, syncStats, startSync } = useSyncProgress();
  const [setupStarted, setSetupStarted] = useState(false);

  // If setup is not needed, redirect immediately
  // Preserve Shopify search params (shop, host, etc.) in the URL for navigation.
  useEffect(() => {
    if (!needsSetup) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      navigate(`/app/products${search}`, { replace: true });
    }
  }, [needsSetup, navigate]);

  // Auto-start sync on first install. Webhook subscriptions are declared in
  // shopify.app.toml and registered by Shopify automatically on every (re)install,
  // so no separate /api/setup-webhooks call is needed here.
  useEffect(() => {
    if (needsSetup && !setupStarted) {
      setSetupStarted(true);
      startSync(false);
    }
  }, [needsSetup, setupStarted, startSync]);

  // Redirect to setup guide after sync completes (first-time onboarding)
  useEffect(() => {
    if (syncComplete && syncStats) {
      // Small delay so user can see the completion message
      const timeout = setTimeout(() => {
        const search = typeof window !== 'undefined' ? window.location.search : '';
        navigate(`/app/setup${search}`, { replace: true });
      }, 1500);
      return () => clearTimeout(timeout);
    }
  }, [syncComplete, syncStats, navigate]);

  // If not needing setup, show nothing while redirecting
  if (!needsSetup) {
    return null;
  }

  return (
    <Page>
      <BlockStack gap="500">
        <Banner title="Welcome to AI Content Manager" tone="info">
          <p>
            We're setting up your store by syncing your products, collections, articles, and more.
            This only happens once and enables AI-powered content management.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Initial Setup
            </Text>

            {!syncProgress && !syncComplete && (
              <InlineStack gap="200" align="center">
                <Spinner size="small" />
                <Text as="p">Preparing to sync your content...</Text>
              </InlineStack>
            )}

            {syncProgress && (
              <SyncProgressDisplay progress={syncProgress} />
            )}

            {syncComplete && syncStats && (
              <Banner tone="success">
                <p>
                  Setup complete! Synced {syncStats.products} products, {syncStats.collections} collections,
                  {syncStats.articles} articles, and {syncStats.pages} pages.
                </p>
                <p>Redirecting to your products...</p>
              </Banner>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

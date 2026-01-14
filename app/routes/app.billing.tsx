/**
 * Billing Page
 *
 * Allows merchants to view and manage their subscription plans
 */

import { useEffect, useState } from 'react';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData, useNavigate } from '@remix-run/react';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Badge,
  Divider,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { getCurrentSubscription, getPlanFromSubscription } from '~/services/billing.server';
import { BILLING_PLANS, getAvailablePlans, type BillingPlan } from '~/config/billing';
import { PLAN_CONFIG, PLAN_DISPLAY_NAMES } from '~/config/plans';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const subscription = await getCurrentSubscription(admin);
  const currentPlan = getPlanFromSubscription(subscription);

  return json({
    currentPlan,
    subscription,
    shop: session.shop,
  });
};

export default function BillingPage() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Type guard to check if we have an error
  if ('error' in loaderData) {
    return (
      <Page title="Abonnement & Preise">
        <Banner tone="critical">
          <p>{loaderData.error}</p>
        </Banner>
      </Page>
    );
  }

  const { currentPlan, subscription } = loaderData;
  const availablePlans = getAvailablePlans();

  const handleSelectPlan = async (plan: BillingPlan) => {
    if (plan === 'free') {
      // Cancel current subscription
      if (window.confirm('Möchten Sie wirklich zum kostenlosen Plan wechseln? Ihr aktuelles Abo wird gekündigt.')) {
        setLoading('free');
        setError(null);

        try {
          const response = await fetch('/api/billing/cancel-subscription', {
            method: 'POST',
          });

          if (!response.ok) {
            throw new Error('Failed to cancel subscription');
          }

          // Reload page to show updated plan
          window.location.reload();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Ein Fehler ist aufgetreten');
          setLoading(null);
        }
      }
      return;
    }

    // Create subscription for paid plan
    setLoading(plan);
    setError(null);

    try {
      const response = await fetch('/api/billing/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create subscription');
      }

      // Redirect to Shopify confirmation URL
      if (data.confirmationUrl) {
        window.location.href = data.confirmationUrl;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ein Fehler ist aufgetreten');
      setLoading(null);
    }
  };

  return (
    <Page
      title="Abonnement & Preise"
      backAction={{ content: 'Einstellungen', onAction: () => navigate('/app/settings') }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" title="Fehler" onDismiss={() => setError(null)}>
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}

        {subscription && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Aktuelles Abonnement
                </Text>
                <InlineStack gap="200" align="start">
                  <Text as="p" variant="bodyMd">
                    Plan:
                  </Text>
                  <Badge tone={currentPlan === 'free' ? 'info' : 'success'}>
                    {currentPlan.toUpperCase()}
                  </Badge>
                </InlineStack>
                {subscription.test && (
                  <Banner tone="info">
                    <p>Dies ist ein Test-Abonnement. Sie werden nicht belastet.</p>
                  </Banner>
                )}
                {subscription.trialDays && subscription.trialDays > 0 && (
                  <Banner tone="info">
                    <p>Sie befinden sich in der {subscription.trialDays}-tägigen Testphase.</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            <Text as="h2" variant="headingLg">
              Verfügbare Pläne
            </Text>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
              {availablePlans.map(({ id, config }) => {
                const planDetails = PLAN_CONFIG[id];
                const isCurrentPlan = id === currentPlan;
                const price = config ? `€${config.price.toFixed(2)}/Monat` : 'Kostenlos';

                return (
                  <Card key={id}>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="start">
                        <Text as="h3" variant="headingMd">
                          {PLAN_DISPLAY_NAMES[id]}
                        </Text>
                        {isCurrentPlan && <Badge tone="success">Aktiv</Badge>}
                      </InlineStack>

                      <Text as="p" variant="headingLg" fontWeight="bold">
                        {price}
                      </Text>

                      <Divider />

                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd">
                          <strong>Produkte:</strong>{' '}
                          {planDetails.maxProducts === Infinity
                            ? 'Unbegrenzt'
                            : planDetails.maxProducts}
                        </Text>
                        <Text as="p" variant="bodyMd">
                          <strong>Bilder:</strong>{' '}
                          {planDetails.productImages === 'all' ? 'Alle Bilder' : 'Nur Featured Image'}
                        </Text>
                        <Text as="p" variant="bodyMd">
                          <strong>Content Types:</strong> {planDetails.contentTypes.length}
                        </Text>
                        <BlockStack gap="100">
                          {planDetails.contentTypes.slice(0, 4).map((type) => (
                            <Text key={type} as="p" variant="bodySm" tone="success">
                              ✓ {type}
                            </Text>
                          ))}
                          {planDetails.contentTypes.length > 4 && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              +{planDetails.contentTypes.length - 4} mehr
                            </Text>
                          )}
                        </BlockStack>
                      </BlockStack>

                      <Button
                        variant={isCurrentPlan ? 'secondary' : 'primary'}
                        disabled={isCurrentPlan || loading !== null}
                        loading={loading === id}
                        onClick={() => handleSelectPlan(id)}
                        fullWidth
                      >
                        {isCurrentPlan ? 'Aktueller Plan' : id === 'free' ? 'Downgrade' : 'Auswählen'}
                      </Button>
                    </BlockStack>
                  </Card>
                );
              })}
            </div>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                Hinweise
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                • Alle Preise verstehen sich pro 30 Tage
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                • Sie können jederzeit upgraden oder downgraden
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                • Beim Downgrade werden Daten entsprechend der Plan-Limits angepasst
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                • Neue Abonnements enthalten eine 7-tägige kostenlose Testphase
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

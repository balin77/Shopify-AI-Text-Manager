/**
 * Billing Callback Route
 *
 * Handles the return after merchant confirms or declines a subscription.
 * Verifies the actual subscription status, then renders a small confirmation
 * screen that navigates back to the settings plan tab via Remix in-iframe
 * routing. We don't server-redirect because that drops App Bridge params
 * (`host`, `embedded`) and produces a blank page inside the embedded iframe.
 */

import { useEffect } from 'react';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json, redirect } from '@remix-run/node';
import { useLoaderData, useNavigate } from '@remix-run/react';
import { Page, Card, BlockStack, Text, Spinner, Button } from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { checkAndSyncSubscription } from '~/services/billing.server';
import { logger } from '~/utils/logger.server';
import { useI18n } from '~/contexts/I18nContext';

type BillingStatus = 'success' | 'declined' | 'error';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!admin || !session) {
    return redirect('/app');
  }

  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'unknown';

  let status: BillingStatus = 'success';
  try {
    const activePlan = await checkAndSyncSubscription(admin, session.shop);

    if (activePlan === 'free' || activePlan !== plan) {
      logger.info('[Billing] Subscription not activated after callback', {
        expected: plan,
        active: activePlan,
        shop: session.shop,
      });
      status = 'declined';
    }
  } catch (error) {
    logger.error('Error in billing callback', { error: error instanceof Error ? error.message : String(error) });
    status = 'error';
  }

  return json({ status, plan });
};

export default function BillingCallback() {
  const { status, plan } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const target = status === 'error'
    ? '/app/settings?billing=error'
    : `/app/settings?billing=${status}&plan=${encodeURIComponent(plan)}`;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => navigate(target, { replace: true }), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [navigate, target]);

  const title = status === 'success'
    ? t.settings.billingSuccessTitle
    : status === 'declined'
      ? t.settings.billingDeclinedTitle
      : t.settings.billingErrorTitle;

  const message = status === 'success'
    ? t.settings.billingRedirectingSuccess
    : status === 'declined'
      ? t.settings.billingRedirectingDeclined
      : t.settings.billingRedirectingError;

  return (
    <Page>
      <Card>
        <BlockStack gap="400" align="center">
          <Text as="h1" variant="headingLg">{title}</Text>
          <Text as="p" tone="subdued">{message}</Text>
          <Spinner accessibilityLabel="Loading" size="small" />
          <Button onClick={() => navigate(target, { replace: true })}>
            {t.settings.billingGoToPlanSettings}
          </Button>
        </BlockStack>
      </Card>
    </Page>
  );
}

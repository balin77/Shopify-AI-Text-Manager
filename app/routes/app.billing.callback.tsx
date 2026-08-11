/**
 * Billing Callback Route
 *
 * Handles the return after merchant confirms or declines a subscription.
 * Verifies the actual subscription status, then renders a small confirmation
 * screen that navigates back to the settings plan tab via Remix in-iframe
 * routing. We don't server-redirect because that drops App Bridge params
 * (`host`, `embedded`) and produces a blank page inside the embedded iframe.
 */

import { useEffect, useMemo } from 'react';
import type { LoaderFunctionArgs } from "react-router";
import { data as json, redirect } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
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

  // Preserve the Shopify embedded params (host, embedded, shop, id_token, …)
  // that Shopify appended to this callback URL. Hardcoding the target would
  // strip them from window.location; the next full-page navigation
  // (useAppNavigation) would then reload the embedded app without `host`,
  // leaving App Bridge unable to initialize -> blank page.
  const target = useMemo(() => {
    const params = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
    params.set('billing', status);
    if (status === 'error') {
      params.delete('plan');
    } else {
      params.set('plan', plan);
    }
    return `/app/settings?${params.toString()}`;
  }, [status, plan]);

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

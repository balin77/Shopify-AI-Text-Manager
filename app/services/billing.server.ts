/**
 * Shopify Billing Service
 *
 * Handles all billing-related operations including creating subscriptions,
 * checking subscription status, and managing billing webhooks.
 */

import { BillingInterval, BillingReplacementBehavior, shopifyApp } from '@shopify/shopify-app-remix/server';
import type { Session } from '@shopify/shopify-api';
import { BILLING_PLANS, type BillingPlan, isPaidPlan } from '~/config/billing';
import { db as prisma } from '~/db.server';
import { logger } from '~/utils/logger.server';

interface ShopifyAdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }>;
}

interface AppSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd?: string;
  trialDays?: number;
  lineItems?: Array<{ id: string; plan: { pricingDetails: { __typename: string; price?: { amount: string; currencyCode: string }; interval?: string } } }>;
}

interface UserError {
  field?: string;
  message: string;
}

/**
 * Checks if the shop is a development/partner test store.
 * Development stores should use test billing (no real charges).
 */
async function isDevStore(admin: ShopifyAdminClient): Promise<boolean> {
  try {
    const response = await admin.graphql(
      `#graphql
        query {
          shop {
            plan {
              partnerDevelopment
            }
          }
        }
      `
    );
    const result = await response.json();
    return result.data?.shop?.plan?.partnerDevelopment === true;
  } catch (error) {
    logger.warn('[Billing] Could not determine shop plan type, defaulting to non-test', { error });
    return false;
  }
}

/**
 * Creates a billing subscription for the given plan.
 * Automatically uses test mode for development stores and dev environments.
 */
export async function createSubscription(
  admin: ShopifyAdminClient,
  session: Session,
  plan: Exclude<BillingPlan, 'free'>,
  returnUrl: string
) {
  const planConfig = BILLING_PLANS[plan];

  // Use test billing for dev environments OR development/partner test stores
  const isDevEnv = process.env.NODE_ENV === 'development' || process.env.APP_ENV === 'development';
  const isTestStore = await isDevStore(admin);
  const useTestBilling = isDevEnv || isTestStore;

  if (useTestBilling) {
    logger.info('[Billing] Using test billing mode', { isDevEnv, isTestStore, shop: session.shop });
  }

  const response = await admin.graphql(
    `#graphql
      mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          lineItems: $lineItems
        ) {
          appSubscription {
            id
            name
            test
            status
            currentPeriodEnd
            trialDays
          }
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        name: planConfig.name,
        returnUrl,
        test: useTestBilling,
        trialDays: planConfig.trialDays || 0,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: planConfig.price, currencyCode: planConfig.currency },
                interval: planConfig.interval,
              },
            },
          },
        ],
      },
    }
  );

  const result = await response.json();

  if (result.data?.appSubscriptionCreate?.userErrors?.length > 0) {
    throw new Error(
      `Failed to create subscription: ${(result.data.appSubscriptionCreate.userErrors as UserError[]).map((e) => e.message).join(', ')}`
    );
  }

  return {
    subscriptionId: result.data?.appSubscriptionCreate?.appSubscription?.id,
    confirmationUrl: result.data?.appSubscriptionCreate?.confirmationUrl,
    subscription: result.data?.appSubscriptionCreate?.appSubscription,
  };
}

/**
 * Cancels an active subscription
 */
export async function cancelSubscription(admin: ShopifyAdminClient, subscriptionId: string) {
  const response = await admin.graphql(
    `#graphql
      mutation AppSubscriptionCancel($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: subscriptionId,
      },
    }
  );

  const result = await response.json();

  if (result.data?.appSubscriptionCancel?.userErrors?.length > 0) {
    throw new Error(
      `Failed to cancel subscription: ${(result.data.appSubscriptionCancel.userErrors as UserError[]).map((e) => e.message).join(', ')}`
    );
  }

  return result.data?.appSubscriptionCancel?.appSubscription;
}

/**
 * Gets the current active subscription for a shop
 */
export async function getCurrentSubscription(admin: ShopifyAdminClient): Promise<AppSubscription | null> {
  const response = await admin.graphql(
    `#graphql
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            currentPeriodEnd
            trialDays
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `
  );

  const result = await response.json() as { data?: { currentAppInstallation?: { activeSubscriptions?: AppSubscription[] } } };
  const subscriptions = result.data?.currentAppInstallation?.activeSubscriptions || [];

  // Return the first active subscription
  return subscriptions.length > 0 ? subscriptions[0] : null;
}

/**
 * Gets the plan from the subscription name or defaults to free
 */
export function getPlanFromSubscription(subscription: AppSubscription | null): BillingPlan {
  if (!subscription) return 'free';

  const name = subscription.name.toLowerCase();

  if (name.includes('max')) return 'max';
  if (name.includes('pro')) return 'pro';
  if (name.includes('basic')) return 'basic';

  return 'free';
}

/**
 * Syncs the subscription plan to the database
 */
export async function syncSubscriptionToDatabase(shop: string, plan: BillingPlan) {
  const aiSettings = await prisma.aISettings.findUnique({
    where: { shop },
  });

  if (aiSettings) {
    await prisma.aISettings.update({
      where: { shop },
      data: { subscriptionPlan: plan },
    });
  }
}

/**
 * Checks subscription status and updates database accordingly
 */
export async function checkAndSyncSubscription(admin: ShopifyAdminClient, shop: string): Promise<BillingPlan> {
  try {
    const subscription = await getCurrentSubscription(admin);

    if (!subscription || subscription.status !== 'ACTIVE') {
      // No active subscription, downgrade to free
      await syncSubscriptionToDatabase(shop, 'free');
      return 'free';
    }

    const plan = getPlanFromSubscription(subscription);
    await syncSubscriptionToDatabase(shop, plan);
    return plan;
  } catch (error) {
    logger.error('Error checking subscription', { error });
    // On error, default to free to be safe
    await syncSubscriptionToDatabase(shop, 'free');
    return 'free';
  }
}


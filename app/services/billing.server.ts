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

/**
 * Creates a billing subscription for the given plan
 */
export async function createSubscription(
  admin: any,
  session: Session,
  plan: Exclude<BillingPlan, 'free'>,
  returnUrl: string
) {
  const planConfig = BILLING_PLANS[plan];

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
        // Use test billing if NODE_ENV is development OR APP_ENV is development
        // This allows running NODE_ENV=production with APP_ENV=development for testing
        test: process.env.NODE_ENV === 'development' || process.env.APP_ENV === 'development',
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
      `Failed to create subscription: ${result.data.appSubscriptionCreate.userErrors.map((e: any) => e.message).join(', ')}`
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
export async function cancelSubscription(admin: any, subscriptionId: string) {
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
      `Failed to cancel subscription: ${result.data.appSubscriptionCancel.userErrors.map((e: any) => e.message).join(', ')}`
    );
  }

  return result.data?.appSubscriptionCancel?.appSubscription;
}

/**
 * Gets the current active subscription for a shop
 */
export async function getCurrentSubscription(admin: any) {
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

  const result = await response.json();
  const subscriptions = result.data?.currentAppInstallation?.activeSubscriptions || [];

  // Return the first active subscription
  return subscriptions.length > 0 ? subscriptions[0] : null;
}

/**
 * Checks if the shop has an active paid subscription
 */
export async function hasActiveSubscription(admin: any): Promise<boolean> {
  const subscription = await getCurrentSubscription(admin);
  return subscription?.status === 'ACTIVE';
}

/**
 * Gets the plan from the subscription name or defaults to free
 */
export function getPlanFromSubscription(subscription: any): BillingPlan {
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
export async function checkAndSyncSubscription(admin: any, shop: string): Promise<BillingPlan> {
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
    console.error('Error checking subscription:', error);
    // On error, default to free to be safe
    await syncSubscriptionToDatabase(shop, 'free');
    return 'free';
  }
}

/**
 * Requires an active subscription for paid plans
 * Redirects to billing page if no active subscription
 */
export async function requireSubscription(
  admin: any,
  session: Session,
  requiredPlan?: Exclude<BillingPlan, 'free'>
) {
  const subscription = await getCurrentSubscription(admin);

  if (!subscription || subscription.status !== 'ACTIVE') {
    return {
      hasSubscription: false,
      currentPlan: 'free' as BillingPlan,
      subscription: null,
    };
  }

  const currentPlan = getPlanFromSubscription(subscription);

  // If a specific plan is required, check if current plan meets the requirement
  if (requiredPlan) {
    const planHierarchy: BillingPlan[] = ['free', 'basic', 'pro', 'max'];
    const currentIndex = planHierarchy.indexOf(currentPlan);
    const requiredIndex = planHierarchy.indexOf(requiredPlan);

    if (currentIndex < requiredIndex) {
      return {
        hasSubscription: false,
        currentPlan,
        subscription,
        upgradeRequired: true,
      };
    }
  }

  return {
    hasSubscription: true,
    currentPlan,
    subscription,
  };
}

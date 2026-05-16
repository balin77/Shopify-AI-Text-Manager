/**
 * Shopify Billing Service
 *
 * Handles all billing-related operations including creating subscriptions,
 * checking subscription status, and managing billing webhooks.
 */

import type { Session } from '@shopify/shopify-api';
import { BILLING_PLANS, type BillingPlan, isPaidPlan } from '~/config/billing';
import { db as prisma } from '~/db.server';
import { logger } from '~/utils/logger.server';
import { cleanupCacheForPlan } from '~/utils/planCacheCleanup';
import { resolveDevPlanMode, getDevForcedPlan } from '~/services/dev-plan-override.server';

interface ShopifyAdminClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<any> }>;
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
 * Determines whether a shop may still receive a free trial.
 *
 * A trial is granted at most ONCE per shop, independent of
 * cancel/re-subscribe/plan-switch/reinstall. Two conditions must hold:
 *  - no existing ACTIVE subscription (paid→paid switches never get a trial), and
 *  - the persistent per-shop marker `trialConsumedAt` is still null.
 *
 * The marker lives on AISettings and is therefore wiped by shop/redact — a
 * fully redacted shop that genuinely reinstalls becomes eligible again. This is
 * deliberate; the abuse path (cancel/re-subscribe WITHOUT uninstall+redact)
 * stays closed because the AISettings row survives it.
 */
export async function isTrialEligible(shop: string, hasExistingSubscription: boolean): Promise<boolean> {
  if (hasExistingSubscription) return false;
  const settings = await prisma.aISettings.findUnique({
    where: { shop },
    select: { trialConsumedAt: true },
  });
  return !settings?.trialConsumedAt;
}

/**
 * Idempotently records that this shop has consumed its one-time trial.
 *
 * Only ever transitions null → now() (the `trialConsumedAt: null` filter makes
 * a second call a no-op). It is NEVER reset — not on cancel, not on downgrade —
 * so a shop cannot regain trial eligibility by cancelling and re-subscribing.
 * The AISettings row is guaranteed to exist here because the caller runs
 * syncSubscriptionToDatabase (upsert) immediately beforehand.
 */
async function markTrialConsumed(shop: string): Promise<void> {
  await prisma.aISettings.updateMany({
    where: { shop, trialConsumedAt: null },
    data: { trialConsumedAt: new Date() },
  });
}

/**
 * Creates a billing subscription for the given plan.
 * Automatically uses test mode for development stores and dev environments.
 * Pass hasExistingSubscription=true for paid→paid switches so Shopify
 * atomically replaces the old plan (APPLY_IMMEDIATELY, prorated).
 */
export async function createSubscription(
  admin: ShopifyAdminClient,
  session: Session,
  plan: Exclude<BillingPlan, 'free'>,
  returnUrl: string,
  hasExistingSubscription = false
) {
  const planConfig = BILLING_PLANS[plan];

  // Use test billing for dev environments OR development/partner test stores
  // OR an explicitly allow-listed developer-owned shop on the public app
  // ('test-billing' mode — real Shopify flow, only the `test` flag flips).
  const isDevEnv = process.env.NODE_ENV === 'development' || process.env.APP_ENV === 'development';
  const isTestStore = await isDevStore(admin);
  const isTestBillingShop = resolveDevPlanMode(session.shop) === 'test-billing';
  const useTestBilling = isDevEnv || isTestStore || isTestBillingShop;

  if (useTestBilling) {
    logger.info('[Billing] Using test billing mode', { isDevEnv, isTestStore, isTestBillingShop, shop: session.shop });
  }

  // Trial only for a shop's FIRST-EVER subscription. isTrialEligible() combines
  // the live "no active subscription" check with the persistent per-shop
  // trialConsumedAt marker, so the sequence free → basic[trial] → cancel → pro
  // can NOT farm a second trial (the marker survives cancel/re-subscribe). On a
  // paid→paid switch (hasExistingSubscription, APPLY_IMMEDIATELY) it is likewise
  // 0. Matches the advertised UI/i18n statement "New subscriptions include a
  // 7-day free trial". `trialDays` is a top-level argument of
  // appSubscriptionCreate (Admin API 2025-10), not a lineItems/plan field.
  const eligible = await isTrialEligible(session.shop, hasExistingSubscription);
  const trialDays = eligible ? (planConfig.trialDays ?? 0) : 0;

  const response = await admin.graphql(
    `#graphql
      mutation AppSubscriptionCreate(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $trialDays: Int
        $lineItems: [AppSubscriptionLineItemInput!]!
        $replacementBehavior: AppSubscriptionReplacementBehavior
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
          replacementBehavior: $replacementBehavior
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
        trialDays,
        // Replace existing subscription immediately (prorated) for paid→paid switches.
        // Merchant still confirms via confirmationUrl; if they cancel, nothing changes.
        // No fresh trial is granted on this path (trialDays === 0 above) by design.
        replacementBehavior: hasExistingSubscription ? 'APPLY_IMMEDIATELY' : null,
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
 * Resolves the plan from a Shopify subscription deterministically.
 *
 * H4 fix: the previous `name.includes('pro'|'basic'|...)` substring heuristic
 * silently mis-mapped on any rename or marketing name (e.g. "Promo Plan").
 * Mapping is now exact and anchored to BILLING_PLANS, the same source
 * createSubscription uses to set the name and price:
 *   1. exact (case-insensitive) match of the subscription name to a plan name
 *   2. fallback: recurring price amount of the first line item
 * Anything that matches neither yields 'free' (logged) — we never guess.
 */
export function getPlanFromSubscription(subscription: AppSubscription | null): BillingPlan {
  if (!subscription) return 'free';

  const paidPlans = Object.entries(BILLING_PLANS) as Array<
    [Exclude<BillingPlan, 'free'>, (typeof BILLING_PLANS)[Exclude<BillingPlan, 'free'>]]
  >;

  // 1. Exact name match (createSubscription always sets name = planConfig.name).
  const subName = subscription.name.trim().toLowerCase();
  const byName = paidPlans.find(([, cfg]) => cfg.name.trim().toLowerCase() === subName);
  if (byName) return byName[0];

  // 2. Price fallback — robust against a renamed subscription.
  const recurring = subscription.lineItems?.find(
    (li) => li.plan?.pricingDetails?.price?.amount != null,
  );
  const amount = recurring?.plan.pricingDetails.price?.amount;
  if (amount != null) {
    const numeric = Number(amount);
    const byPrice = paidPlans.find(([, cfg]) => cfg.price === numeric);
    if (byPrice) return byPrice[0];
  }

  logger.warn('[Billing] Could not map subscription to a known plan — defaulting to free', {
    subscriptionName: subscription.name,
    priceAmount: amount ?? null,
  });
  return 'free';
}

/**
 * Syncs the subscription plan to the database.
 * Uses upsert so reinstalled shops without an existing AISettings row are handled
 * correctly instead of silently skipping the write.
 */
export async function syncSubscriptionToDatabase(shop: string, plan: BillingPlan) {
  await prisma.aISettings.upsert({
    where: { shop },
    update: { subscriptionPlan: plan },
    create: { shop, subscriptionPlan: plan },
  });
}

/**
 * Reconciles the local Prisma content cache with the limits of the
 * Shopify-verified plan. Only runs when the plan actually changed, and never
 * from the error/catch path (a transient Shopify API error must not trigger a
 * destructive cache purge). Failures here are non-fatal — the plan sync itself
 * has already succeeded.
 */
async function reconcileCacheForVerifiedPlan(shop: string, previousPlan: BillingPlan, newPlan: BillingPlan) {
  if (newPlan === previousPlan) return;

  try {
    const stats = await cleanupCacheForPlan(shop, newPlan);
    logger.info('[Billing] Cache reconciled after verified plan change', { shop, from: previousPlan, to: newPlan, stats });
  } catch (cleanupError) {
    logger.warn('[Billing] Cache cleanup failed after plan change (plan sync still successful)', {
      shop,
      from: previousPlan,
      to: newPlan,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

/**
 * Checks subscription status and updates database accordingly.
 *
 * The plan is derived exclusively from the Shopify-verified active
 * subscription (never from any client input). When the verified plan differs
 * from the previously stored one, the local content cache is reconciled to the
 * new plan's limits (covers real downgrades via subscription cancel).
 */
export async function checkAndSyncSubscription(admin: ShopifyAdminClient, shop: string): Promise<BillingPlan> {
  const existing = await prisma.aISettings.findUnique({ where: { shop } });
  const previousPlan = (existing?.subscriptionPlan as BillingPlan | undefined) ?? 'free';

  // Custom-app build only (override mode): the plan is decoupled from Shopify
  // because the custom-app distribution has no Billing API. getDevForcedPlan()
  // is itself hard-gated (dev client_id + APP_ENV !== 'production'), so this
  // branch is provably dead in the public App-Store build. Cache is reconciled
  // exactly like a real plan change so downgrade edge cases are testable.
  const forced = await getDevForcedPlan(shop);
  if (forced) {
    await syncSubscriptionToDatabase(shop, forced);
    await reconcileCacheForVerifiedPlan(shop, previousPlan, forced);
    return forced;
  }

  try {
    const subscription = await getCurrentSubscription(admin);

    if (!subscription || subscription.status !== 'ACTIVE') {
      // No active subscription, downgrade to free
      await syncSubscriptionToDatabase(shop, 'free');
      await reconcileCacheForVerifiedPlan(shop, previousPlan, 'free');
      return 'free';
    }

    const plan = getPlanFromSubscription(subscription);
    await syncSubscriptionToDatabase(shop, plan);

    // Trial-consumption is recorded HERE — at the Shopify-verified point, not
    // optimistically at the mutation call. We trust the returned subscription
    // (ACTIVE + trialDays > 0 means Shopify actually granted the trial), never
    // the requested plan. markTrialConsumed is idempotent and never resets, so
    // repeated syncs (incl. after the trial ends) keep the marker set.
    if ((subscription.trialDays ?? 0) > 0) {
      await markTrialConsumed(shop);
    }

    await reconcileCacheForVerifiedPlan(shop, previousPlan, plan);
    return plan;
  } catch (error) {
    logger.error('Error checking subscription', { error });
    // On error, default to free to be safe. Deliberately NO cache cleanup here:
    // a transient Shopify API failure must not purge cached content.
    await syncSubscriptionToDatabase(shop, 'free');
    return 'free';
  }
}


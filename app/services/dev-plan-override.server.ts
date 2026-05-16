/**
 * Dev / test billing affordances — server only.
 *
 * Two mutually exclusive modes, decided per request from the running app's
 * identity (never from client input):
 *
 *  - 'override'      The CUSTOM/DEV app build. Shopify's custom-app
 *                    distribution has NO Billing API at all (see
 *                    https://shopify.dev/docs/apps/launch/distribution —
 *                    "Custom distribution … Can't use the Billing API"), so
 *                    there is no Shopify revenue path to bypass. The plan is
 *                    decoupled from Shopify and read from
 *                    AISettings.devForcedPlan, settable from the in-app plan UI
 *                    and persistent across restarts (long-term edge-case
 *                    testing on a real store).
 *
 *  - 'test-billing'  The PUBLIC production app, but only for an explicitly
 *                    allow-listed, developer-OWNED shop. The real Shopify
 *                    billing flow runs completely unchanged (subscription
 *                    object, webhooks, trial, proration, plan resolution) —
 *                    only appSubscriptionCreate's `test` flag flips to true so
 *                    no money is charged. Shopify stays the source of truth;
 *                    this is NOT a B1/B2-style off-platform bypass.
 *
 *  - null            Every real merchant on the public app. Normal behaviour.
 *
 * COMPLIANCE — why 'override' is provably unreachable in the public App-Store
 * build: it is gated on the running app's `SHOPIFY_API_KEY` matching the known
 * DEV app client_id (an allowlist of ONE id — any unknown/public id ⇒ off),
 * PLUS `APP_ENV !== 'production'` as a second, independent lock. Shopify
 * enforces the client_id during OAuth, so the public binary structurally
 * cannot present the dev id regardless of how Railway env vars are set. This
 * closes the B2-class weakness (APP_ENV is not Dockerfile/toml-enforced in
 * production) documented in docs/SHOPIFY_COMPLIANCE_AUDIT.md.
 */

import type { BillingPlan } from '~/config/billing';
import { db as prisma } from '~/db.server';
import { logger } from '~/utils/logger.server';

export type DevPlanMode = 'override' | 'test-billing' | null;

/**
 * client_id of the dev/custom app (shopify.app.dev.toml). NOT a secret — it is
 * the public-facing API key embedded in every OAuth URL. Used as a positive
 * allowlist: only this exact id may enter 'override' mode.
 */
const DEV_APP_CLIENT_ID = '433cf493223c0c6b95bdb91b0de5961a';

const VALID_PLANS: readonly BillingPlan[] = ['free', 'basic', 'pro', 'max'];

function isValidPlan(value: unknown): value is BillingPlan {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value);
}

function testBillingAllowlist(): string[] {
  return (process.env.DEV_PLAN_OVERRIDE_SHOPS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True only when the running binary is the dev/custom app. Primary lock is the
 * Shopify-enforced client_id; APP_ENV is an additional, independent guard.
 */
function isDevAppBuild(): boolean {
  return (
    process.env.SHOPIFY_API_KEY === DEV_APP_CLIENT_ID &&
    process.env.APP_ENV !== 'production'
  );
}

/**
 * Decides which (if any) dev billing affordance applies for this shop.
 * Pure / synchronous — safe to call on every request.
 */
export function resolveDevPlanMode(shop: string): DevPlanMode {
  if (isDevAppBuild()) {
    return 'override';
  }

  const shopLc = shop.trim().toLowerCase();
  if (shopLc && testBillingAllowlist().includes(shopLc)) {
    return 'test-billing';
  }

  return null;
}

/**
 * Returns the forced plan for the custom-app build, or null. Only ever
 * consulted when resolveDevPlanMode() === 'override'; reads
 * AISettings.devForcedPlan and validates it against the known plan set.
 */
export async function getDevForcedPlan(shop: string): Promise<BillingPlan | null> {
  if (resolveDevPlanMode(shop) !== 'override') return null;

  const settings = await prisma.aISettings.findUnique({
    where: { shop },
    select: { devForcedPlan: true },
  });

  const plan = settings?.devForcedPlan;
  if (!isValidPlan(plan)) return null;

  logger.warn(
    '[DevPlanOverride] ACTIVE — plan forced from DB, Shopify billing bypassed (custom-app build only)',
    { shop, plan },
  );
  return plan;
}

/**
 * Persists the forced plan for the custom-app build. Refuses (throws) outside
 * 'override' mode so it can never run in the public production build even if
 * called by mistake.
 */
export async function setDevForcedPlan(shop: string, plan: BillingPlan): Promise<void> {
  if (resolveDevPlanMode(shop) !== 'override') {
    throw new Error('[DevPlanOverride] setDevForcedPlan refused — not in override mode');
  }
  if (!isValidPlan(plan)) {
    throw new Error(`[DevPlanOverride] setDevForcedPlan refused — invalid plan "${String(plan)}"`);
  }

  await prisma.aISettings.upsert({
    where: { shop },
    update: { devForcedPlan: plan },
    create: { shop, devForcedPlan: plan },
  });

  logger.warn('[DevPlanOverride] devForcedPlan persisted (custom-app build only)', { shop, plan });
}

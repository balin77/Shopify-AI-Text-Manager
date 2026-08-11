import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isProductionLocked } from "../utils/planUtils";

/**
 * Fire-and-forget endpoint: marks the first-run theme-extension setup hint as
 * shown for this shop so app.tsx's loader stops surfacing it.
 *
 * The action mirrors the loader's gate (app.tsx) server-side on purpose: only
 * a Pro/Max shop with the feature unlocked may ever consume this one-shot
 * marker. Without that invariant a stray POST (route reuse, double-submit, a
 * not-yet-Pro shop) would permanently burn the hint, so a later upgrade would
 * never see it.
 *
 * A Pro/Max shop's AISettings row is guaranteed to exist before the hint can
 * fire (the billing sync upserts it before the plan is ever readable, see
 * syncSubscriptionToDatabase in billing.server.ts), so a guarded updateMany is
 * correct and idempotent (the `extensionSetupHintShownAt: null` filter
 * preserves the first timestamp). We deliberately do NOT upsert: a create
 * branch could only run on a missing row, and would mask the plan with the
 * schema default "free" and force appLanguage "de" — a footgun with no real
 * caller here.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (isProductionLocked()) {
    return json({ ok: false }, { status: 403 });
  }

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  const plan = settings?.subscriptionPlan;
  if (plan !== "pro" && plan !== "max") {
    return json({ ok: false }, { status: 403 });
  }

  await db.aISettings.updateMany({
    where: { shop: session.shop, extensionSetupHintShownAt: null },
    data: { extensionSetupHintShownAt: new Date() },
  });

  return json({ ok: true });
};

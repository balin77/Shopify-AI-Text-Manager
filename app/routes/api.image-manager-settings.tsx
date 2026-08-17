import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { canAccessVariantImageManagerInEnv, isProductionLocked, type Plan } from "../utils/planUtils";

/**
 * Plan gate: Image Manager settings only apply when the merchant's plan
 * actually exposes the Variant Image Manager (Pro+). The Settings UI hides
 * the tab on Free/Basic, but a direct POST here would still flip the toggle.
 */
async function isAllowed(shop: string): Promise<boolean> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  return canAccessVariantImageManagerInEnv(plan, !isProductionLocked());
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.imageManagerSettings.findUnique({
    where: { shopId: session.shop },
  });
  return json({
    settings: settings ?? { firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!(await isAllowed(session.shop))) {
    return json({ success: false, error: "Image Manager requires the Pro plan" }, { status: 403 });
  }
  try {
    const { enabled, autoAltText, firstImageBig, showAltTags, thumbSize } = await request.json();

    const settings = await db.imageManagerSettings.upsert({
      where: { shopId: session.shop },
      create: { shopId: session.shop, enabled: enabled ?? true, firstImageBig: firstImageBig ?? false, showAltTags: showAltTags ?? false, autoAltText: autoAltText ?? false, thumbSize: thumbSize ?? 80 },
      update: {
        ...(enabled !== undefined && { enabled }),
        ...(autoAltText !== undefined && { autoAltText }),
        ...(firstImageBig !== undefined && { firstImageBig }),
        ...(showAltTags !== undefined && { showAltTags }),
        ...(thumbSize !== undefined && { thumbSize }),
      },
    });

    return json({ success: true, settings });
  } catch (error: unknown) {
    // The UI consumes `success === false` to render an inline error banner.
    // Previously this route had no catch, so any DB hiccup would throw,
    // return a 500 HTML page into the fetcher, and the UI silently kept
    // the unsaved state as if nothing happened.
    return json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save image manager settings" },
      { status: 500 }
    );
  }
};

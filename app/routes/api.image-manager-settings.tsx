import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

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

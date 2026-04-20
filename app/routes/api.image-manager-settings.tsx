import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.imageManagerSettings.findUnique({
    where: { shopId: session.shop },
  });
  return json({
    settings: settings ?? { firstImageBig: false, showAltTags: false, autoAltText: false },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { firstImageBig, showAltTags, autoAltText } = await request.json();

  const settings = await db.imageManagerSettings.upsert({
    where: { shopId: session.shop },
    create: { shopId: session.shop, firstImageBig, showAltTags, autoAltText },
    update: { firstImageBig, showAltTags, autoAltText },
  });

  return json({ settings });
};

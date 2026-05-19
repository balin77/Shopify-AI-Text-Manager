import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { consumeImageOperations } from "../utils/imageOperations.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (process.env.APP_ENV === "production") throw new Response("Not Found", { status: 404 });
  const { admin, session } = await authenticate.admin(request);
  const { filename, mimeType, fileSize } = await request.json();

  // Each staged upload = one billable image operation (real compute/bandwidth;
  // AI is merchant-funded BYO). Reserve quota before asking Shopify for a target.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const quota = await consumeImageOperations(session.shop, plan, 1);
  if (!quota.allowed) {
    return json(
      { error: "Monthly image-operation limit reached", code: "IMAGE_QUOTA_EXCEEDED", limit: quota.limit },
      { status: 422 }
    );
  }

  const response = await admin.graphql(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      input: [{
        filename,
        mimeType,
        fileSize: String(fileSize),
        resource: "IMAGE",
        httpMethod: "PUT",
      }],
    },
  });

  const data = await response.json();

  // Do NOT log the full Shopify response or the signed upload URLs — they
  // contain short-lived credentialed CDN URLs. Log only non-sensitive status.
  const userErrors = data.data?.stagedUploadsCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error("[staged-upload] userErrors", userErrors);
    return json({ error: userErrors[0].message }, { status: 400 });
  }

  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    console.error("[staged-upload] no stagedTargets returned");
    return json({ error: "Staged upload creation failed" }, { status: 500 });
  }

  return json({
    url: target.url,
    resourceUrl: target.resourceUrl,
    parameters: target.parameters,
  });
};

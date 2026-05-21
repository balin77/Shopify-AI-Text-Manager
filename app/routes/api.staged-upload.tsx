import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { consumeImageOperations } from "../utils/imageOperations.server";
import { classifyFile, kindToStagedResource } from "../utils/mediaKind";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { filename, mimeType, fileSize } = await request.json();

  // Detect upload kind from the client-supplied mime-type. We never trust the
  // mimeType blindly for security, but stagedUploadsCreate.resource is just a
  // routing hint to Shopify — they re-validate on PUT.
  const kind = classifyFile(mimeType, filename);
  if (!kind) {
    return json(
      { error: `Unsupported media type: ${mimeType}` },
      { status: 400 }
    );
  }
  const resource = kindToStagedResource(kind);
  // Shopify's staged-upload destinations differ by resource:
  //   IMAGE     → Google Cloud Storage signed PUT (simple body upload)
  //   VIDEO     → multipart POST (typically Mux / GCS POST policy)
  //   MODEL_3D  → multipart POST (same as VIDEO)
  // Using `httpMethod: "PUT"` for VIDEO/MODEL_3D returns a target URL that
  // rejects PUT (405 Method Not Allowed) — the upload silently fails on the
  // client side and the merchant sees "nothing happens" when they try to
  // upload a .glb. Pick the method that matches the resource so each
  // staged target is reachable with the upload technique it expects.
  const httpMethod: "PUT" | "POST" = resource === "IMAGE" ? "PUT" : "POST";

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
        resource,
        httpMethod,
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
    // Client uses this to decide between a single-body PUT (image) and a
    // multipart-form POST that includes Shopify's signed `parameters`
    // (video / 3D model). Older clients that ignore the field still PUT,
    // which only works for images.
    httpMethod,
    kind,
  });
};

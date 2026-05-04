import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { filename, mimeType, fileSize } = await request.json();

  console.log("[staged-upload] request", { filename, mimeType, fileSize });

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
  console.log("[staged-upload] Shopify response", JSON.stringify(data, null, 2));

  const userErrors = data.data?.stagedUploadsCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error("[staged-upload] userErrors", userErrors);
    return json({ error: userErrors[0].message }, { status: 400 });
  }

  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    console.error("[staged-upload] no stagedTargets in response", data);
    return json({ error: "Staged upload creation failed" }, { status: 500 });
  }

  console.log("[staged-upload] returning target", { url: target.url, resourceUrl: target.resourceUrl });
  return json({
    url: target.url,
    resourceUrl: target.resourceUrl,
    parameters: target.parameters,
  });
};

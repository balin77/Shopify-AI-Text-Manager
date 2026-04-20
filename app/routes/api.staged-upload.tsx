import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { filename, mimeType, fileSize } = await request.json();

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
  const userErrors = data.data?.stagedUploadsCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return json({ error: userErrors[0].message }, { status: 400 });
  }

  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    return json({ error: "Staged upload creation failed" }, { status: 500 });
  }

  return json({
    url: target.url,
    resourceUrl: target.resourceUrl,
    parameters: target.parameters,
  });
};

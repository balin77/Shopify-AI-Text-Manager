import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Materializes a staging-area asset (returned by /api/staged-upload + a
 * subsequent client-side PUT) into a permanent Shopify File via fileCreate.
 * Polls the file's status until READY, then returns the CDN URL.
 *
 * Used by the variant image manager for .glb model previews (generated
 * client-side via app/utils/threeDSnapshot.ts). The resulting CDN URL is
 * persisted in custom.variant_3d_previews (list.url) parallel to
 * custom.variant_3d_models so the storefront has a real thumbnail without
 * having to render the model itself for every visitor.
 *
 * Why fileCreate vs productCreateMedia: we don't want the preview JPEG to
 * appear in the product's media library next to the real variant images —
 * it's an internal helper asset, not merchandise content. fileCreate puts
 * it in the generic Files section, out of sight.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body = (await request.json()) as {
    resourceUrl?: string;
    alt?: string;
  };
  const resourceUrl = String(body.resourceUrl ?? "").trim();
  const alt = String(body.alt ?? "").slice(0, 255);

  if (!resourceUrl || !resourceUrl.startsWith("https://")) {
    return json({ error: "resourceUrl required" }, { status: 400 });
  }

  const createRes = await admin.graphql(
    `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message code }
      }
    }
  `,
    {
      variables: {
        files: [{ originalSource: resourceUrl, contentType: "IMAGE", alt }],
      },
    },
  );
  const createData = await createRes.json();
  const userErrors = createData.data?.fileCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error("[create-shopify-file] userErrors", userErrors);
    return json({ error: userErrors[0].message }, { status: 400 });
  }
  const created = createData.data?.fileCreate?.files?.[0];
  if (!created) {
    return json({ error: "fileCreate returned no file" }, { status: 500 });
  }
  const fileId: string = created.id;

  // fileCreate is async on Shopify's side: image.url is null until the
  // file's status flips to READY. Poll with bounded backoff. Snapshot
  // JPEGs are tiny (<100KB), so processing is usually done within a few
  // seconds — but a busy ingestion queue can take longer. Bail with a
  // 504 after ~9s; the client retries on next save.
  const waits = [0, 600, 1200, 2000, 3000, 4000];
  let cdnUrl: string | null = null;
  for (const ms of waits) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    const pollRes = await admin.graphql(
      `
      query GetFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id
            fileStatus
            image { url }
          }
        }
      }
    `,
      { variables: { id: fileId } },
    );
    const pollData = await pollRes.json();
    const node = pollData.data?.node;
    if (node?.fileStatus === "READY" && node?.image?.url) {
      cdnUrl = node.image.url;
      break;
    }
    if (node?.fileStatus === "FAILED") {
      return json({ error: "Shopify rejected preview upload" }, { status: 422 });
    }
  }
  if (!cdnUrl) {
    // The file EXISTS — only its CDN url is still being produced. Callers that
    // need the url (the 3D snapshot) retry; callers that only need the
    // reference (a metaobject `file_reference` field) can use `fileId` and go
    // without a thumbnail, which beats leaving an orphaned file behind.
    return json(
      { fileId, error: "Preview upload still processing — try saving again in a moment" },
      { status: 504 },
    );
  }
  return json({ fileId, url: cdnUrl });
};

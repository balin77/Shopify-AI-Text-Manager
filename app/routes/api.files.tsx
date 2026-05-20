import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Browse the merchant's Shopify Files library.
 *
 * Used by the Image Manager's "Browse existing files" picker so merchants
 * can select previously uploaded media (across products) and drop it into
 * a variant gallery — without having to leave the app and re-upload.
 *
 * Query params:
 *   q?      — free-text search (Shopify treats it as a filename substring
 *             plus tag/alt match).
 *   kind?   — "image" | "video" | "model" — narrows the result by media
 *             type using Shopify's `media_type:` query operator.
 *   first?  — page size (default 50, capped at 100).
 *   after?  — pagination cursor from the previous response's
 *             `pageInfo.endCursor`.
 *
 * Response: `{ files: ResolvedMediaItem[], pageInfo: { endCursor, hasNextPage } }`.
 * Each file is normalised to the same `ResolvedMediaItem` shape the rest of
 * the Image Manager uses, so the picker UI can render thumbnails uniformly.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") ?? "").trim();
  const kindParam = url.searchParams.get("kind") ?? "";
  const firstRaw = parseInt(url.searchParams.get("first") ?? "50", 10);
  const first = Number.isFinite(firstRaw) ? Math.min(Math.max(firstRaw, 1), 100) : 50;
  const after = url.searchParams.get("after") || null;

  const queryParts: string[] = [];
  if (q) {
    // Wrap in quotes so spaces / colons inside the term are not parsed as
    // search operators. Shopify's parser is forgiving but quoting is safest.
    queryParts.push(`"${q.replace(/"/g, '\\"')}"`);
  }
  const kindToShopifyType: Record<string, string> = {
    image: "IMAGE",
    video: "VIDEO",
    model: "MODEL_3D",
  };
  if (kindParam && kindToShopifyType[kindParam]) {
    queryParts.push(`media_type:${kindToShopifyType[kindParam]}`);
  }
  const queryString = queryParts.join(" AND ") || null;

  const r = await admin.graphql(`
    query browseFiles($first: Int!, $after: String, $query: String) {
      files(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            __typename
            id
            alt
            ... on MediaImage {
              image { url width height }
              mimeType
            }
            ... on Video {
              preview { image { url } }
              sources { url mimeType }
            }
            ... on Model3d {
              preview { image { url } }
              sources { url mimeType }
            }
            ... on GenericFile {
              url
              mimeType
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { variables: { first, after, query: queryString } });

  const data = await r.json();
  const edges = data?.data?.files?.edges ?? [];

  // Normalise each Shopify file into the resolved shape the picker renders.
  // GenericFile is included because GLB uploads sometimes resolve to that
  // type rather than Model3d, but we hide it unless the merchant explicitly
  // searches with kind=model (otherwise picker results would be polluted by
  // arbitrary downloads like PDFs).
  const files = edges
    .map((e: any) => {
      const n = e.node;
      const tn = n.__typename;
      if (tn === "MediaImage") {
        return {
          kind: "image" as const,
          id: n.id,
          previewUrl: n?.image?.url ?? "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "Video") {
        return {
          kind: "video" as const,
          id: n.id,
          previewUrl: n?.preview?.image?.url ?? "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "Model3d") {
        return {
          kind: "model" as const,
          id: n.id,
          previewUrl: n?.preview?.image?.url ?? "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "GenericFile" && kindParam === "model" && /\.glb$/i.test(n?.url ?? "")) {
        return {
          kind: "model" as const,
          id: n.id,
          previewUrl: "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      return null;
    })
    .filter(Boolean);

  return json({
    files,
    pageInfo: data?.data?.files?.pageInfo ?? { hasNextPage: false, endCursor: null },
  });
};

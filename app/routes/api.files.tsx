import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Browse the merchant's Shopify Files library.
 *
 * Used by the Image Manager's "Browse existing files" picker so merchants
 * can select previously uploaded media (across products) and drop it into
 * a variant gallery — without having to leave the app and re-upload.
 *
 * Query params:
 *   q?               — free-text search (Shopify treats it as a filename
 *                      substring plus tag/alt match).
 *   kind?            — "image" | "video" | "model" — narrows the result by
 *                      media type using Shopify's `media_type:` operator.
 *   first?           — page size (default 50, capped at 100).
 *   after?           — pagination cursor from the previous response's
 *                      `pageInfo.endCursor`.
 *   usedByProductId? — full Shopify product GID. When set the loader
 *                      switches branches and returns the product's media
 *                      (via product(id).media) instead of the library-wide
 *                      files() query. q / kind still apply as in-memory
 *                      filters. pageInfo is reported as a single page
 *                      because product.media(first:250) is already capped
 *                      well above any realistic product gallery size.
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
  const usedByProductId = url.searchParams.get("usedByProductId");

  // Branch B: scoped to a single product. We use product(id).media because
  // Shopify's files() query has no "used in product" facet. The media field
  // returns the same FileReference union as files() so the normalization
  // below stays uniform.
  if (usedByProductId) {
    const r = await admin.graphql(`
      query productFiles($id: ID!) {
        product(id: $id) {
          media(first: 250) {
            edges {
              node {
                __typename
                ... on MediaImage { id alt image { url width height } mimeType }
                ... on Video      { id alt preview { image { url } } sources { url mimeType format } }
                ... on Model3d    { id alt preview { image { url } } sources { url mimeType format } }
                ... on ExternalVideo { id alt host originUrl embeddedUrl preview { image { url } } }
              }
            }
          }
        }
      }
    `, { variables: { id: usedByProductId } });
    const data = await r.json();
    const productEdges = data?.data?.product?.media?.edges ?? [];

    // In-memory q + kind filter so the client UI behaves identically to the
    // library-wide branch. Lowercased substring match on alt + filename.
    const qLower = q.toLowerCase();
    const kindAllow = kindParam || null;
    const files = productEdges
      .map((e: any) => {
        const n = e.node;
        const tn = n.__typename;
        const altText = n.alt ?? null;
        const filename = String(n?.image?.url ?? n?.preview?.image?.url ?? "").split("/").pop()?.split("?")[0] ?? "";
        if (qLower && !altText?.toLowerCase().includes(qLower) && !filename.toLowerCase().includes(qLower)) {
          return null;
        }
        if (tn === "MediaImage") {
          if (kindAllow && kindAllow !== "image") return null;
          const assetUrl = n?.image?.url ?? "";
          return { kind: "image" as const, id: n.id, previewUrl: assetUrl, assetUrl, reference: n.id, alt: altText };
        }
        if (tn === "Video") {
          if (kindAllow && kindAllow !== "video") return null;
          return { kind: "video" as const, id: n.id, previewUrl: n?.preview?.image?.url ?? "", assetUrl: n?.sources?.[0]?.url ?? "", reference: n.id, alt: altText };
        }
        if (tn === "Model3d") {
          if (kindAllow && kindAllow !== "model") return null;
          // Model3d.sources is a heterogeneous list (glb / usdz / gltf etc).
          // Prefer the .glb source — it's the format <model-viewer> needs and
          // it's what the storefront renderer expects. `sources[0]` blindly
          // could land on `.usdz` (iOS quicklook) which isn't a valid
          // model_src for our renderer and would fail validation on save.
          const glbSource = (n?.sources ?? []).find((s: any) =>
            String(s?.format ?? "").toLowerCase() === "glb" ||
            /\.glb(\?|$)/i.test(String(s?.url ?? ""))
          );
          const chosen = glbSource ?? n?.sources?.[0];
          return { kind: "model" as const, id: n.id, previewUrl: n?.preview?.image?.url ?? "", assetUrl: chosen?.url ?? "", reference: n.id, alt: altText };
        }
        // ExternalVideo deliberately excluded from the picker — URLs are
        // managed via the modal's link input, not as selectable file tiles.
        return null;
      })
      .filter(Boolean);

    return json({
      files,
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  }

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
  // `assetUrl` is the actual media file URL (not the poster). Needed so the
  // product-mode "add this library file to the product gallery" path can
  // pass it to productCreateMedia.originalSource — without it videos/3D
  // would get re-uploaded as the poster image.
  const files = edges
    .map((e: any) => {
      const n = e.node;
      const tn = n.__typename;
      if (tn === "MediaImage") {
        const assetUrl = n?.image?.url ?? "";
        return {
          kind: "image" as const,
          id: n.id,
          previewUrl: assetUrl,
          assetUrl,
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "Video") {
        return {
          kind: "video" as const,
          id: n.id,
          previewUrl: n?.preview?.image?.url ?? "",
          assetUrl: n?.sources?.[0]?.url ?? "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "Model3d") {
        // Same glb-preference logic as the usedByProductId branch — pick
        // the source matching .glb so the resulting assetUrl is the one
        // <model-viewer> can render and isValid3dModelUrl accepts.
        const glbSource = (n?.sources ?? []).find((s: any) =>
          String(s?.format ?? "").toLowerCase() === "glb" ||
          /\.glb(\?|$)/i.test(String(s?.url ?? ""))
        );
        const chosen = glbSource ?? n?.sources?.[0];
        return {
          kind: "model" as const,
          id: n.id,
          previewUrl: n?.preview?.image?.url ?? "",
          assetUrl: chosen?.url ?? "",
          reference: n.id,
          alt: n.alt ?? null,
        };
      }
      if (tn === "GenericFile" && kindParam === "model" && /\.glb$/i.test(n?.url ?? "")) {
        return {
          kind: "model" as const,
          id: n.id,
          previewUrl: "",
          assetUrl: n?.url ?? "",
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

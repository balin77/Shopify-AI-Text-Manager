import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

async function ensureVariantMetafieldDefinition(
  adminClient: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> },
  key: string,
  name: string,
  type: string,
) {
  const existing = await adminClient.graphql(`
    query {
      metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "custom", key: "${key}") {
        edges { node { id } }
      }
    }
  `);
  const d = await existing.json();
  if ((d.data?.metafieldDefinitions?.edges?.length ?? 0) > 0) return;

  await adminClient.graphql(`
    mutation {
      metafieldDefinitionCreate(definition: {
        name: "${name}"
        namespace: "custom"
        key: "${key}"
        type: "${type}"
        ownerType: PRODUCTVARIANT
      }) {
        createdDefinition { id }
        userErrors { field message }
      }
    }
  `);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ error: "productId required" }, { status: 400 });
  }

  await ensureVariantMetafieldDefinition(admin, "variant_gallery", "Variant Gallery", "list.file_reference");
  await ensureVariantMetafieldDefinition(admin, "image_key", "Image Key", "single_line_text_field");
  // YouTube/Vimeo URLs cannot be stored in list.file_reference, so they live
  // in a parallel list.url metafield. Order across files + URLs is held by
  // variant_gallery_order (json) — kept idempotent: defining it twice is a
  // no-op thanks to ensureVariantMetafieldDefinition's lookup.
  await ensureVariantMetafieldDefinition(admin, "variant_external_videos", "Variant External Videos", "list.url");
  // 3D models (.glb) cannot live in list.file_reference (it rejects Media3d),
  // so they sit in their own list.url metafield. The variant_gallery_order
  // entries with kind "model" reference these URLs.
  await ensureVariantMetafieldDefinition(admin, "variant_3d_models", "Variant 3D Models", "list.url");
  // Per-model JPEG preview URLs. Parallel array to variant_3d_models — index N
  // here is the preview for index N in variant_3d_models. Generated client-side
  // at upload time via <model-viewer>.toBlob (see app/utils/threeDSnapshot.ts),
  // uploaded via fileCreate as a standalone Shopify File (so it does not
  // pollute the product media library), and stored here as a CDN URL. The
  // storefront uses it as both the thumb and the model-viewer poster.
  await ensureVariantMetafieldDefinition(admin, "variant_3d_previews", "Variant 3D Model Previews", "list.url");
  await ensureVariantMetafieldDefinition(admin, "variant_gallery_order", "Variant Gallery Order", "json");

  // Fetch product media + variants in one query.
  // media(first:250) gives us a definitive GID→URL map for ALL product images,
  // independent of the DB cache — so gallery thumbnails always resolve correctly.
  const response = await admin.graphql(`
    query GetVariantsWithGallery($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          edges {
            node {
              __typename
              ... on MediaImage {
                id
                image { url }
              }
              ... on Video {
                id
                preview { image { url } }
                sources { url mimeType format height width }
              }
              ... on Model3d {
                id
                preview { image { url } }
                sources { url mimeType format filesize }
              }
              ... on ExternalVideo {
                id
                host
                originUrl
                embeddedUrl
                preview { image { url } }
              }
            }
          }
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              position
              image { url altText }
              selectedOptions { name value }
              metafield(namespace: "custom", key: "variant_gallery") {
                value
              }
              imageKeyMetafield: metafield(namespace: "custom", key: "image_key") {
                value
              }
              externalVideosMetafield: metafield(namespace: "custom", key: "variant_external_videos") {
                value
              }
              threeDModelsMetafield: metafield(namespace: "custom", key: "variant_3d_models") {
                value
              }
              threeDPreviewsMetafield: metafield(namespace: "custom", key: "variant_3d_previews") {
                value
              }
              galleryOrderMetafield: metafield(namespace: "custom", key: "variant_gallery_order") {
                value
              }
            }
          }
        }
      }
    }
  `, { variables: { id: productId } });

  const data = await response.json();
  const productData = data.data?.product;

  // Fetch metaobject handles + GIDs separately — optional, degrades gracefully if unavailable.
  const optionHandleMap: Record<string, Record<string, string | null>> = {};
  const optionGidMap: Record<string, Record<string, string | null>> = {};
  const optionValueIdMap: Record<string, Record<string, string | null>> = {};
  try {
    // Step 1: get optionValues with their id and linked metaobject GID (stored as string)
    const optionsRes = await admin.graphql(`
      query GetProductOptionValues($id: ID!) {
        product(id: $id) {
          options {
            name
            optionValues {
              id
              name
              linkedMetafieldValue
            }
          }
        }
      }
    `, { variables: { id: productId } });
    const optionsData = await optionsRes.json();

    // Collect all non-null metaobject GIDs and track which option/value they belong to
    type OVRef = { optionName: string; valueName: string };
    const gidToRefs: Record<string, OVRef[]> = {};
    for (const opt of (optionsData.data?.product?.options ?? [])) {
      for (const ov of (opt.optionValues ?? [])) {
        // Always remember the ProductOptionValue id so non-linked options can be translated too.
        if (ov.id) {
          if (!optionValueIdMap[opt.name]) optionValueIdMap[opt.name] = {};
          optionValueIdMap[opt.name][ov.name] = ov.id;
        }
        if (ov.linkedMetafieldValue) {
          if (!gidToRefs[ov.linkedMetafieldValue]) gidToRefs[ov.linkedMetafieldValue] = [];
          gidToRefs[ov.linkedMetafieldValue].push({ optionName: opt.name, valueName: ov.name });
        }
      }
    }

    const gids = Object.keys(gidToRefs);
    if (gids.length > 0) {
      // Step 2: batch-fetch all metaobject handles in one nodes query
      const nodesRes = await admin.graphql(`
        query GetMetaobjectHandles($ids: [ID!]!) {
          nodes(ids: $ids) {
            id
            ... on Metaobject { handle }
          }
        }
      `, { variables: { ids: gids } });
      const nodesData = await nodesRes.json();
      for (const node of (nodesData.data?.nodes ?? [])) {
        if (!node?.id || !node?.handle) continue;
        for (const { optionName, valueName } of (gidToRefs[node.id] ?? [])) {
          if (!optionHandleMap[optionName]) optionHandleMap[optionName] = {};
          optionHandleMap[optionName][valueName] = node.handle;
          // Also store the GID so translation lookup can use it directly (no type required)
          if (!optionGidMap[optionName]) optionGidMap[optionName] = {};
          optionGidMap[optionName][valueName] = node.id;
        }
      }
    }
  } catch (err: any) {
    console.error("[api.product-variants] handle lookup failed:", err?.message);
  }

  const variants = (productData?.variants?.edges?.map((e: any) => {
    const node = e.node;
    const selectedOptions = (node.selectedOptions ?? []).map((so: any) => ({
      name: so.name,
      value: so.value,
      handle: optionHandleMap[so.name]?.[so.value] ?? null,
      metaobjectGid: optionGidMap[so.name]?.[so.value] ?? null,
      optionValueGid: optionValueIdMap[so.name]?.[so.value] ?? null,
    }));
    return { ...node, selectedOptions };
  }) ?? []);

  // Build a GID→{kind,previewUrl} map from ALL current product media. For
  // backwards compatibility, mediaMap[gid] is still a plain URL string (used
  // by older callers that only render images), and mediaMetaMap[gid] carries
  // the richer descriptor so the Image Manager can pick the right thumbnail
  // overlay (play / 3D badge).
  const mediaMap: Record<string, string> = {};
  const mediaMetaMap: Record<string, { kind: "image" | "video" | "model" | "external_video"; previewUrl: string }> = {};
  for (const edge of (productData?.media?.edges ?? [])) {
    const node: any = edge.node;
    if (!node?.id) continue;
    const tn = node.__typename;
    let kind: "image" | "video" | "model" | "external_video" | null = null;
    let previewUrl = "";
    if (tn === "MediaImage" && node?.image?.url) {
      kind = "image";
      previewUrl = node.image.url;
    } else if (tn === "Video") {
      kind = "video";
      previewUrl = node?.preview?.image?.url ?? "";
    } else if (tn === "Model3d") {
      kind = "model";
      previewUrl = node?.preview?.image?.url ?? "";
    } else if (tn === "ExternalVideo") {
      kind = "external_video";
      previewUrl = node?.preview?.image?.url ?? "";
    }
    if (!kind) continue;
    if (previewUrl) mediaMap[node.id] = previewUrl;
    mediaMetaMap[node.id] = { kind, previewUrl };
  }

  // In DB cachen (upsert)
  await Promise.all(variants.map((v: any) => {
    const numericId = v.id.replace("gid://shopify/ProductVariant/", "");
    return db.productVariant.upsert({
      where: { shopifyGid: v.id },
      create: {
        id: numericId,
        shopifyGid: v.id,
        productId,
        title: v.title,
        sku: v.sku ?? null,
        imageKey: v.imageKeyMetafield?.value ?? null,
        position: v.position,
        galleryJson: v.metafield?.value ?? null,
      },
      update: {
        title: v.title,
        sku: v.sku ?? null,
        imageKey: v.imageKeyMetafield?.value ?? null,
        position: v.position,
        galleryJson: v.metafield?.value ?? null,
      },
    });
  }));

  const mappedVariants = variants.map((v: any) => ({
    ...v,
    shopifyGid: v.id,
    galleryJson: v.metafield?.value ?? null,
    imageKey: v.imageKeyMetafield?.value ?? null,
    externalVideosJson: v.externalVideosMetafield?.value ?? null,
    threeDModelsJson: v.threeDModelsMetafield?.value ?? null,
    threeDPreviewsJson: v.threeDPreviewsMetafield?.value ?? null,
    galleryOrderJson: v.galleryOrderMetafield?.value ?? null,
    // selectedOptions already enriched with handles above
  }));

  return json({ variants: mappedVariants, mediaMap, mediaMetaMap });
};

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

  // Fetch product media + variants in one query.
  // media(first:250) gives us a definitive GID→URL map for ALL product images,
  // independent of the DB cache — so gallery thumbnails always resolve correctly.
  const response = await admin.graphql(`
    query GetVariantsWithGallery($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          edges {
            node {
              ... on MediaImage {
                id
                image { url }
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
            }
          }
        }
      }
    }
  `, { variables: { id: productId } });

  const data = await response.json();
  const productData = data.data?.product;

  // Fetch metaobject handles separately — optional, degrades gracefully if unavailable.
  const optionHandleMap: Record<string, Record<string, string | null>> = {};
  try {
    // Step 1: get optionValues with their linked metaobject GID (stored as string)
    const optionsRes = await admin.graphql(`
      query GetProductOptionValues($id: ID!) {
        product(id: $id) {
          options {
            name
            optionValues {
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
        }
      }
    }
    console.log("[api.product-variants] optionHandleMap:", JSON.stringify(optionHandleMap));
  } catch (err: any) {
    console.error("[api.product-variants] handle lookup failed:", err?.message);
    console.error("[api.product-variants] graphQLErrors:", JSON.stringify(err?.graphQLErrors ?? null, null, 2));
  }

  const variants = (productData?.variants?.edges?.map((e: any) => {
    const node = e.node;
    const selectedOptions = (node.selectedOptions ?? []).map((so: any) => ({
      name: so.name,
      value: so.value,
      handle: optionHandleMap[so.name]?.[so.value] ?? null,
    }));
    return { ...node, selectedOptions };
  }) ?? []);

  // Build a GID→URL map from ALL current product media (authoritative, not DB-cached).
  const mediaMap: Record<string, string> = {};
  for (const edge of (productData?.media?.edges ?? [])) {
    const node = edge.node;
    if (node?.id && node?.image?.url) mediaMap[node.id] = node.image.url;
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
    // selectedOptions already enriched with handles above
  }));

  return json({ variants: mappedVariants, mediaMap });
};

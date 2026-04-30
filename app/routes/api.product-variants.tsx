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
  const variants = productData?.variants?.edges?.map((e: any) => e.node) ?? [];

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
  }));

  return json({ variants: mappedVariants, mediaMap });
};

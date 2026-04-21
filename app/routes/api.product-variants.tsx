import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

async function ensureVariantGalleryMetafieldDefinition(adminClient: { graphql: (query: string, options?: Record<string, unknown>) => Promise<Response> }) {
  const existing = await adminClient.graphql(`
    query {
      metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "custom", key: "variant_gallery") {
        edges { node { id } }
      }
    }
  `);
  const d = await existing.json();
  if ((d.data?.metafieldDefinitions?.edges?.length ?? 0) > 0) return;

  await adminClient.graphql(`
    mutation {
      metafieldDefinitionCreate(definition: {
        name: "Variant Gallery"
        namespace: "custom"
        key: "variant_gallery"
        type: "list.file_reference"
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

  await ensureVariantGalleryMetafieldDefinition(admin);

  const response = await admin.graphql(`
    query GetVariantsWithGallery($id: ID!) {
      product(id: $id) {
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
                references(first: 250) {
                  edges {
                    node {
                      ... on MediaImage {
                        id
                        image { url }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { id: productId } });

  const data = await response.json();
  const variants = data.data?.product?.variants?.edges?.map((e: any) => e.node) ?? [];

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
        position: v.position,
        galleryJson: v.metafield?.value ?? null,
      },
      update: {
        title: v.title,
        sku: v.sku ?? null,
        position: v.position,
        galleryJson: v.metafield?.value ?? null,
      },
    });
  }));

  // Map to shape the client expects: shopifyGid + galleryJson + galleryImageMap
  // galleryImageMap provides GID→URL for every referenced image so the client can display
  // gallery thumbnails even when a GID is absent from the productImages DB cache.
  const mappedVariants = variants.map((v: any) => {
    const refEdges: any[] = v.metafield?.references?.edges ?? [];
    const galleryImageMap: Record<string, string> = {};
    for (const edge of refEdges) {
      const node = edge.node;
      if (node?.id && node?.image?.url) {
        galleryImageMap[node.id] = node.image.url;
      }
    }
    return {
      ...v,
      shopifyGid: v.id,
      galleryJson: v.metafield?.value ?? null,
      galleryImageMap,
    };
  });

  return json({ variants: mappedVariants });
};

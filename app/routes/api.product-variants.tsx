import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ error: "productId required" }, { status: 400 });
  }

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

  return json({ variants });
};

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

interface UpdateVariantGalleriesBody {
  productId: string;
  newMedia?: Array<{ resourceUrl: string }>;
  variantGalleries?: Array<{ variantId: string; fileGids: string[] }>;
  mediaOrder?: Array<{ mediaId: string; position: number }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body: UpdateVariantGalleriesBody = await request.json();
  const { productId, newMedia = [], variantGalleries = [], mediaOrder = [] } = body;

  // 1. Neue Bilder zu Produkt hinzufügen
  if (newMedia.length > 0) {
    await admin.graphql(`
      mutation productUpdate($input: ProductInput!, $media: [CreateMediaInput!]) {
        productUpdate(input: $input, media: $media) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: { id: productId },
        media: newMedia.map(m => ({
          originalSource: m.resourceUrl,
          mediaContentType: "IMAGE",
        })),
      },
    });
  }

  // 2. Bilder neu sortieren
  if (mediaOrder.length > 0) {
    await admin.graphql(`
      mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        id: productId,
        moves: mediaOrder.map(m => ({ id: m.mediaId, newPosition: String(m.position) })),
      },
    });
  }

  // 3. Variant-Galerien (Metafelder) updaten
  if (variantGalleries.length > 0) {
    await admin.graphql(`
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        productId,
        variants: variantGalleries.map(vg => ({
          id: vg.variantId,
          metafields: [{
            namespace: "custom",
            key: "variant_gallery",
            value: JSON.stringify(vg.fileGids),
            type: "list.file_reference",
          }],
        })),
      },
    });

    // DB-Cache updaten
    await Promise.all(variantGalleries.map(vg =>
      db.productVariant.updateMany({
        where: { shopifyGid: vg.variantId },
        data: { galleryJson: JSON.stringify(vg.fileGids) },
      })
    ));
  }

  return json({ success: true });
};

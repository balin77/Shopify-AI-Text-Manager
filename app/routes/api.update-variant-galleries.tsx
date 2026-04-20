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

  const errors: string[] = [];

  // 1. Neue Bilder zu Produkt hinzufügen
  if (newMedia.length > 0) {
    const r = await admin.graphql(`
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
    const d = await r.json();
    const ue = d.data?.productUpdate?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => e.message));
  }

  // 2. Bilder neu sortieren
  if (mediaOrder.length > 0) {
    const r = await admin.graphql(`
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
    const d = await r.json();
    const ue = d.data?.productReorderMedia?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => e.message));
  }

  // 3. Variant-Galerien (Metafelder) updaten
  if (variantGalleries.length > 0) {
    const r = await admin.graphql(`
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
          ...(vg.fileGids.length > 0 && { mediaId: vg.fileGids[0] }),
          metafields: [{
            namespace: "custom",
            key: "variant_gallery",
            value: JSON.stringify(vg.fileGids),
            type: "list.file_reference",
          }],
        })),
      },
    });
    const d = await r.json();
    const ue = d.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => e.message));

    if (errors.length === 0) {
      await Promise.all(variantGalleries.map(vg =>
        db.productVariant.updateMany({
          where: { shopifyGid: vg.variantId },
          data: { galleryJson: JSON.stringify(vg.fileGids) },
        })
      ));
    }
  }

  if (errors.length > 0) {
    return json({ success: false, errors }, { status: 422 });
  }
  return json({ success: true });
};

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

interface UpdateVariantGalleriesBody {
  productId: string;
  newMedia?: Array<{ resourceUrl: string }>;
  variantGalleries?: Array<{ variantId: string; fileGids: string[] }>;
  mediaOrder?: Array<{ mediaId: string; position: number }>;
  // Variant IDs whose Shopify image (mediaId) should be explicitly set to null.
  // fileGids for these variants (if present) are gallery-only — no main GID at position 0.
  clearVariantMainImages?: string[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body: UpdateVariantGalleriesBody = await request.json();
  const { productId, newMedia = [], variantGalleries = [], mediaOrder = [], clearVariantMainImages = [] } = body;

  console.log("[update-variant-galleries] incoming", {
    productId,
    newMediaCount: newMedia.length,
    newMediaUrls: newMedia.map(m => m.resourceUrl),
    variantGalleriesCount: variantGalleries.length,
    variantGalleries,
    mediaOrderCount: mediaOrder.length,
    clearVariantMainImages,
  });

  const errors: string[] = [];

  // 1. Neue Bilder zu Produkt hinzufügen und GID-Mapping aufbauen
  // resourceUrl (staged upload URL) → Shopify MediaImage GID
  const resourceUrlToGid: Record<string, string> = {};
  if (newMedia.length > 0) {
    console.log("[update-variant-galleries] calling productCreateMedia with", newMedia.length, "items");
    const r = await admin.graphql(`
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id }
          mediaUserErrors { field message }
        }
      }
    `, {
      variables: {
        productId,
        media: newMedia.map(m => ({
          originalSource: m.resourceUrl,
          mediaContentType: "IMAGE",
        })),
      },
    });
    const d = await r.json();
    console.log("[update-variant-galleries] productCreateMedia response", JSON.stringify(d, null, 2));
    const ue = d.data?.productCreateMedia?.mediaUserErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => e.message));

    // Map each resourceUrl to the GID of the newly created media (response order matches input order)
    const createdMedia: { id: string }[] = d.data?.productCreateMedia?.media ?? [];
    console.log("[update-variant-galleries] createdMedia", createdMedia);
    newMedia.forEach((m, i) => {
      if (createdMedia[i]?.id) {
        resourceUrlToGid[m.resourceUrl] = createdMedia[i].id;
        console.log("[update-variant-galleries] mapped", m.resourceUrl, "→", createdMedia[i].id);
      } else {
        console.warn("[update-variant-galleries] no GID for index", i, "resourceUrl", m.resourceUrl);
      }
    });
    console.log("[update-variant-galleries] resourceUrlToGid", resourceUrlToGid);
  }

  // Resolve a fileGid that may be a staged resourceUrl to an actual Shopify GID
  const resolveGid = (gid: string): string =>
    gid.startsWith("gid://") ? gid : (resourceUrlToGid[gid] ?? gid);

  // Translate all resourceUrls in variantGalleries.fileGids to actual Shopify GIDs
  const resolvedVariantGalleries = variantGalleries.map(vg => ({
    ...vg,
    fileGids: vg.fileGids.map(resolveGid),
  }));

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

  console.log("[update-variant-galleries] resolvedVariantGalleries", resolvedVariantGalleries);

  // 3. Variant-Galerien (Metafelder) updaten + Hauptbilder ggf. löschen
  const clearSet = new Set(clearVariantMainImages);
  const hasVariantChanges = resolvedVariantGalleries.length > 0 || clearSet.size > 0;
  console.log("[update-variant-galleries] hasVariantChanges", hasVariantChanges);
  if (hasVariantChanges) {
    // Build variant update objects:
    //  - Normal variants: fileGids[0] is the main image GID, fileGids[1..] are gallery.
    //  - Clear-main variants: fileGids are gallery-only (no main at pos 0); set mediaId: null.
    //  - Clear-only variants (not in variantGalleries): only send mediaId: null, no metafield change.
    const variantMap = new Map<string, object>();

    for (const vg of resolvedVariantGalleries) {
      if (clearSet.has(vg.variantId)) {
        variantMap.set(vg.variantId, {
          id: vg.variantId,
          mediaId: null,
          metafields: [{
            namespace: "custom",
            key: "variant_gallery",
            value: JSON.stringify(vg.fileGids),
            type: "list.file_reference",
          }],
        });
      } else {
        // fileGids[0] is the variant's native main image; the gallery metafield must only
        // contain the remaining images to prevent the main image appearing twice on the storefront.
        variantMap.set(vg.variantId, {
          id: vg.variantId,
          ...(vg.fileGids.length > 0 && { mediaId: vg.fileGids[0] }),
          metafields: [{
            namespace: "custom",
            key: "variant_gallery",
            value: JSON.stringify(vg.fileGids.slice(1)),
            type: "list.file_reference",
          }],
        });
      }
    }

    // Add variants that only need mediaId cleared (no gallery change)
    for (const vid of clearSet) {
      if (!variantMap.has(vid)) {
        variantMap.set(vid, { id: vid, mediaId: null });
      }
    }

    const variantPayload = [...variantMap.values()];
    console.log("[update-variant-galleries] productVariantsBulkUpdate payload", JSON.stringify(variantPayload, null, 2));
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
        variants: variantPayload,
      },
    });
    const d = await r.json();
    console.log("[update-variant-galleries] productVariantsBulkUpdate response", JSON.stringify(d, null, 2));
    const ue = d.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => e.message));

    if (errors.length === 0) {
      await Promise.all(resolvedVariantGalleries.map(vg => {
        const galleryGids = clearSet.has(vg.variantId) ? vg.fileGids : vg.fileGids.slice(1);
        return db.productVariant.updateMany({
          where: { shopifyGid: vg.variantId },
          data: { galleryJson: JSON.stringify(galleryGids) },
        });
      }));
    }
  }

  if (errors.length > 0) {
    console.error("[update-variant-galleries] finished with errors", errors);
    return json({ success: false, errors }, { status: 422 });
  }
  console.log("[update-variant-galleries] success");
  return json({ success: true });
};

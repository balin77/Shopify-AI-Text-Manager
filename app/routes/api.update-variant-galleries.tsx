import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidExternalVideoUrl, kindToMediaContentType } from "../utils/mediaKind";
import type { MediaKind } from "../components/image-manager/types";

interface UpdateVariantGalleriesBody {
  productId: string;
  /** New uploads to materialize into Shopify media. `kind` is the media type
   *  used for productCreateMedia.mediaContentType — defaults to "image" if
   *  unset, for backwards compatibility with older clients. */
  newMedia?: Array<{ resourceUrl: string; kind?: MediaKind }>;
  variantGalleries?: Array<{ variantId: string; fileGids: string[]; galleryOnly?: boolean }>;
  mediaOrder?: Array<{ mediaId: string; position: number }>;
  // Variant IDs whose Shopify image (mediaId) should be explicitly set to null.
  // fileGids for these variants (if present) are gallery-only — no main GID at position 0.
  clearVariantMainImages?: string[];
  /** YouTube/Vimeo URLs per variant — persisted to custom.variant_external_videos
   *  (list.url). Server re-validates every URL with isValidExternalVideoUrl and
   *  drops anything we can't safely embed. */
  variantExternalVideos?: Array<{ variantId: string; urls: string[] }>;
  /** Combined order across files + external URLs per variant. JSON array of
   *  { kind: "file" | "url", value: gid|url }. Position 0 must be a file
   *  reference (image) — enforced client-side. Stored in
   *  custom.variant_gallery_order (json). */
  variantGalleryOrder?: Array<{ variantId: string; orderJson: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body: UpdateVariantGalleriesBody = await request.json();
  const {
    productId,
    newMedia = [],
    variantGalleries = [],
    mediaOrder = [],
    clearVariantMainImages = [],
    variantExternalVideos = [],
    variantGalleryOrder = [],
  } = body;

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
  // Steps that already mutated Shopify, so a partial failure is traceable.
  // Shopify offers no transaction across productCreateMedia / productReorderMedia /
  // productVariantsBulkUpdate; on a mid-pipeline failure we abort early, skip the
  // local DB write, and report what ran so the webhook drift-reconcile / a retry
  // can resync.
  //
  // completedSteps semantics are deliberately ASYMMETRIC and mean "did this
  // mutation change Shopify state", not "did it fully succeed":
  //   - productCreateMedia is recorded when createdMedia.length > 0, i.e. even
  //     on a partial/aborted createMedia (mediaUserErrors or count mismatch
  //     followed by fail()) — because ≥1 media was already created on Shopify
  //     and must be considered for resync.
  //   - productReorderMedia / productVariantsBulkUpdate are recorded only when
  //     they returned zero userErrors (a failed reorder/bulk-update did not
  //     reliably mutate state).
  // Consumers must treat completedSteps as a resync hint, not a success log.
  //
  // We intentionally do NOT wait for new media to leave PROCESSING — the
  // MediaImage GID is permanent and stable from creation and is valid as a
  // list.file_reference metafield value / mediaId even while still processing.
  // Residual gap (out of scope, accepted): if Shopify later marks a media as
  // FAILED, the metafield/mediaId points at an invalid media and this route
  // does not detect it (no status poll) — left to the webhook drift-reconcile.
  const completedSteps: string[] = [];
  const fail = () => {
    console.error("[update-variant-galleries] aborting with errors", { errors, completedSteps });
    return json({ success: false, errors, completedSteps }, { status: 422 });
  };

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
          mediaContentType: kindToMediaContentType(m.kind ?? "image"),
        })),
      },
    });
    const d = await r.json();
    console.log("[update-variant-galleries] productCreateMedia response", JSON.stringify(d, null, 2));
    const ue = d.data?.productCreateMedia?.mediaUserErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `createMedia: ${e.message}`));

    const createdMedia: { id: string }[] = d.data?.productCreateMedia?.media ?? [];
    console.log("[update-variant-galleries] createdMedia", createdMedia);
    if (createdMedia.length > 0) completedSteps.push("productCreateMedia");

    // The resourceUrl→GID map below relies on response order matching input order.
    // If the counts differ we cannot trust positional mapping — bail before any
    // variant metafield write so we never point a metafield at the wrong image.
    if (createdMedia.length !== newMedia.length) {
      errors.push(
        `createMedia: expected ${newMedia.length} created media, got ${createdMedia.length} — ` +
        `aborting to avoid mapping variant galleries to the wrong images`
      );
    }
    if (errors.length > 0) return fail();

    // Map each resourceUrl to the GID of the newly created media (response order matches input order)
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

  // Position-0 of a variant gallery becomes the variant's mediaId, which
  // Shopify only accepts as a MediaImage GID. If the merchant accidentally
  // drags a freshly uploaded video / 3D model into position 0 we reject up
  // front with a clearer error than Shopify's "must be an Image" userError.
  // Only known-non-image kinds (from newMedia) are blocked here — existing
  // gid://shopify/Video/* and gid://shopify/Model3d/* are caught further
  // down via the GID prefix check.
  const newMediaKindByResourceUrl: Record<string, MediaKind> = {};
  for (const m of newMedia) {
    if (m.kind) newMediaKindByResourceUrl[m.resourceUrl] = m.kind;
  }
  const clearSetEarly = new Set(clearVariantMainImages);
  for (const vg of variantGalleries) {
    if (vg.galleryOnly || clearSetEarly.has(vg.variantId)) continue;
    const headRaw = vg.fileGids[0];
    if (!headRaw) continue;
    const headKind = newMediaKindByResourceUrl[headRaw];
    const isKnownNonImage =
      (headKind && headKind !== "image") ||
      headRaw.startsWith("gid://shopify/Video/") ||
      headRaw.startsWith("gid://shopify/Model3d/");
    if (isKnownNonImage) {
      errors.push(
        `position-0: variant ${vg.variantId} would receive a non-image as featured media — ` +
        `Shopify only accepts MediaImage for variant.image. Place an image at position 0.`
      );
    }
  }
  if (errors.length > 0) return fail();

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
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `reorder: ${e.message}`));
    else completedSteps.push("productReorderMedia");
    if (errors.length > 0) return fail();
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
        // Explicitly cleared main image: all fileGids are gallery-only.
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
      } else if (vg.galleryOnly) {
        // Variant already has a main image — do NOT touch mediaId, only update gallery metafield.
        variantMap.set(vg.variantId, {
          id: vg.variantId,
          metafields: [{
            namespace: "custom",
            key: "variant_gallery",
            value: JSON.stringify(vg.fileGids),
            type: "list.file_reference",
          }],
        });
      } else {
        // fileGids[0] is the new/existing variant main image; fileGids[1..] are gallery.
        // (When variant had no main image, fileGids[0] is the first newly uploaded image.)
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
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `variantsBulkUpdate: ${e.message}`));
    else completedSteps.push("productVariantsBulkUpdate");

    if (errors.length === 0) {
      await Promise.all(resolvedVariantGalleries.map(vg => {
        // clearSet variants and galleryOnly variants: all fileGids are gallery (no main at [0])
        // normal variants: fileGids[0] is the main image, fileGids[1..] are gallery
        const galleryGids = (clearSet.has(vg.variantId) || vg.galleryOnly)
          ? vg.fileGids
          : vg.fileGids.slice(1);
        return db.productVariant.updateMany({
          where: { shopifyGid: vg.variantId },
          data: { galleryJson: JSON.stringify(galleryGids) },
        });
      }));
    }
  }

  // 4. External videos (YouTube/Vimeo URLs) + combined gallery order.
  // These live on separate metafields because list.file_reference cannot hold
  // URLs. We use metafieldsSet (idempotent upsert by namespace+key+ownerId) so
  // we don't need to know the prior metafield id.
  const metafieldOps: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];

  // Track URLs the client sent that we had to drop so we can surface a
  // partial-failure to the caller. Silent filtering would let a merchant see
  // "save succeeded" while their URL never made it into the metafield.
  const droppedExternalUrls: Array<{ variantId: string; url: string }> = [];
  for (const ev of variantExternalVideos) {
    const sanitized: string[] = [];
    for (const u of ev.urls) {
      if (isValidExternalVideoUrl(u)) sanitized.push(u);
      else droppedExternalUrls.push({ variantId: ev.variantId, url: u });
    }
    metafieldOps.push({
      ownerId: ev.variantId,
      namespace: "custom",
      key: "variant_external_videos",
      type: "list.url",
      value: JSON.stringify(sanitized),
    });
  }

  for (const vo of variantGalleryOrder) {
    // The order metafield is the source of truth for the voll-mix gallery
    // sequence. Validate the shape here — relying purely on client-side
    // checks would let a DevTools-savvy merchant persist e.g. a URL at
    // position 0, which would desync variant.featured_image (still
    // MediaImage from vg.fileGids[0]) from the storefront's first tile.
    // Shape contract: array of { kind: "file" | "url", value: string }
    // with the first entry's kind === "file".
    let parsed: unknown;
    try {
      parsed = JSON.parse(vo.orderJson);
    } catch {
      errors.push(`variantGalleryOrder: variant ${vo.variantId} — orderJson is not valid JSON.`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push(`variantGalleryOrder: variant ${vo.variantId} — orderJson must be an array.`);
      continue;
    }
    let invalidEntry = false;
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i] as { kind?: unknown; value?: unknown };
      if (!entry || typeof entry !== "object" || (entry.kind !== "file" && entry.kind !== "url") || typeof entry.value !== "string") {
        errors.push(`variantGalleryOrder: variant ${vo.variantId} — entry ${i} is malformed.`);
        invalidEntry = true;
        break;
      }
    }
    if (invalidEntry) continue;
    if (parsed.length > 0 && (parsed[0] as { kind: string }).kind !== "file") {
      errors.push(
        `variantGalleryOrder: variant ${vo.variantId} — position 0 must be a file ` +
        `reference (image). Move an image to the first position before saving.`
      );
      continue;
    }
    metafieldOps.push({
      ownerId: vo.variantId,
      namespace: "custom",
      key: "variant_gallery_order",
      type: "json",
      value: vo.orderJson,
    });
  }
  if (errors.length > 0) return fail();

  if (metafieldOps.length > 0) {
    const r = await admin.graphql(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }
    `, { variables: { metafields: metafieldOps } });
    const d = await r.json();
    const ue = d.data?.metafieldsSet?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `metafieldsSet: ${e.message}`));
    else completedSteps.push("metafieldsSet");
  }

  if (errors.length > 0) return fail();
  console.log("[update-variant-galleries] success", { completedSteps, droppedExternalUrlCount: droppedExternalUrls.length });
  return json({ success: true, droppedExternalUrls });
};

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidExternalVideoUrl, isValid3dModelUrl, kindToMediaContentType } from "../utils/mediaKind";
import type { MediaKind } from "../components/image-manager/types";
import { invalidateVariantDefsCache } from "./api.product-variants";

// metafieldsSet userError messages that indicate one of our variant
// metafield definitions has gone missing (deleted externally, type-changed,
// etc.). When we see one of these, drop the verified-definitions cache for
// the shop so the next /api/product-variants hit re-creates the definition
// instead of papering over the broken state for the rest of the process
// lifetime.
function looksLikeMissingDefinitionError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("definition") &&
    (m.includes("not found") || m.includes("does not exist") || m.includes("unknown") || m.includes("invalid"));
}

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
  /** GLB CDN URLs per variant — persisted to custom.variant_3d_models
   *  (list.url). Shopify rejects Media3d in list.file_reference, so 3D models
   *  live in their own list.url metafield. Server re-validates every URL with
   *  isValid3dModelUrl and drops anything that isn't a `.glb`. */
  variant3dModels?: Array<{ variantId: string; urls: string[] }>;
  /** JPEG preview URLs per variant — persisted to custom.variant_3d_previews
   *  (list.url). Parallel array to variant3dModels: index N is the preview for
   *  index N in variant3dModels. Empty string at an index means no preview.
   *  Generated client-side via app/utils/threeDSnapshot.ts → uploaded via
   *  /api/create-shopify-file. Server passes the URLs through verbatim
   *  (they're already Shopify-CDN URLs from fileCreate), but trims the array
   *  to the same length as the corresponding variant3dModels array so a
   *  dropped/processing model never has an orphaned preview. */
  variant3dPreviews?: Array<{ variantId: string; urls: string[] }>;
  /** Carry-over from a previous save where a Model3d upload didn't finish
   *  processing within the bounded polling window. Maps each still-staging
   *  URL onto the Model3d GID returned by the prior productCreateMedia call.
   *  The backend polls these GIDs directly (no re-upload, no duplicate
   *  product media) and substitutes the resolved sources URL into the
   *  variant_3d_models metafield write. */
  knownModelGids?: Record<string, string>;
  /** Combined order across files + external URLs + 3D models per variant.
   *  JSON array of { kind: "file" | "url" | "model", value: gid|url }.
   *  Position 0 must be a file reference (image) — enforced client-side.
   *  Stored in custom.variant_gallery_order (json). */
  variantGalleryOrder?: Array<{ variantId: string; orderJson: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body: UpdateVariantGalleriesBody = await request.json();
  const {
    productId,
    newMedia = [],
    variantGalleries = [],
    mediaOrder = [],
    clearVariantMainImages = [],
    variantExternalVideos = [],
    variant3dModels = [],
    variant3dPreviews = [],
    knownModelGids = {},
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
  // For uploaded .glb files in variant mode: maps the staging URL the client
  // pushed into pendingVariant3dModels onto the final Model3d.sources[0].url
  // (Shopify-CDN, public). Populated by the polling block below.
  const resourceUrlToModelUrl: Record<string, string> = {};
  // Parallel to resourceUrlToModelUrl: Shopify's auto-generated preview JPG
  // for the Model3d (via the `preview { image { url } }` field). Used as a
  // fallback when the client's WebGL snapshot pipeline failed (e.g. .glb is
  // too large for in-browser model-viewer rendering — saw a 20s timeout on
  // an 80MB file). Shopify generates the preview server-side regardless of
  // file size, so this is the only reliable path for big models.
  const resourceUrlToShopifyPreviewUrl: Record<string, string> = {};
  // Per-staging-URL post-create status used by the variant3dModels loop to
  // route to the right dropped-bucket: "ready" → substitute, "processing" →
  // polling timed out (merchant should re-save), "failed" → Shopify rejected
  // the .glb (invalid file).
  const modelResolutionStatus: Record<string, "ready" | "processing" | "failed"> = {};
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

  // Post-create resolution for Model3d uploads: Shopify processes .glb
  // asynchronously, so productCreateMedia returns the Model3d GID
  // immediately but Model3d.sources[0].url is populated only after the
  // processor finishes (typically 1–5s for small files). The
  // pendingVariant3dModels metafield is list.url — it needs the FINAL CDN
  // URL, not the staging URL the client pushed in.
  //
  // Two inputs feed the polling:
  //   1. Fresh uploads from this save (newMedia + kind === "model"). Their
  //      Model3d GIDs come from this request's productCreateMedia response.
  //   2. Carry-over from a PREVIOUS save where polling timed out
  //      (knownModelGids). These GIDs already exist on product.media; we
  //      just need to check whether processing finished in the meantime.
  // Both populate the SAME `modelResources` list so one polling pass
  // resolves all of them with shared GraphQL roundtrips.
  const modelResources: Array<{ gid: string; resourceUrl: string }> = [];
  for (const [resourceUrl, gid] of Object.entries(knownModelGids)) {
    if (typeof gid === "string" && gid.startsWith("gid://")) {
      modelResources.push({ gid, resourceUrl });
    }
  }
  if (newMedia.length > 0) {
    // resourceUrlToGid was populated inside the productCreateMedia block;
    // re-derive the Model3d entries from there. Using resourceUrlToGid
    // (vs reaching back into createdMedia) keeps this block self-contained.
    for (const m of newMedia) {
      if (m.kind === "model") {
        const gid = resourceUrlToGid[m.resourceUrl];
        if (gid) modelResources.push({ gid, resourceUrl: m.resourceUrl });
      }
    }
  }
  // ── Backfill pass: also poll Model3d previews for .glb URLs that are
  // already on the variant_3d_models metafield (from earlier saves) but
  // still have an empty slot in variant_3d_previews. Big files often
  // generate their Shopify preview minutes after the initial save —
  // without this backfill, the preview never lands on the metafield
  // unless the merchant re-uploads the file. Resolves URLs to Model3d
  // GIDs by querying product.media once per save.
  // CRITICAL: exclude staging URLs (the fresh uploads from THIS save).
  // They live in `newMedia` and are handled by the productCreateMedia
  // path — treating them as backfill candidates breaks source-URL
  // substitution (the staging URL never gets replaced with the CDN URL,
  // metafield write rejects it via isValid3dModelUrl, model gets dropped
  // entirely on the first save and the merchant has no model in the
  // gallery after reload despite the .glb being in Shopify).
  const freshUploadStagingUrls = new Set<string>(
    newMedia.filter(m => m.kind === "model").map(m => m.resourceUrl)
  );
  const cdnUrlsNeedingPreview = new Set<string>();
  for (const m of variant3dModels) {
    const previewsForVariant = variant3dPreviews.find(p => p.variantId === m.variantId)?.urls ?? [];
    for (let i = 0; i < m.urls.length; i++) {
      const u = m.urls[i];
      const previewAtIdx = previewsForVariant[i] ?? "";
      if (
        previewAtIdx.trim() === "" &&
        u.startsWith("https://") &&
        !freshUploadStagingUrls.has(u) &&
        !resourceUrlToShopifyPreviewUrl[u]
      ) {
        cdnUrlsNeedingPreview.add(u);
      }
    }
  }
  if (cdnUrlsNeedingPreview.size > 0) {
    try {
      // product.media gives us every Model3d on this product with its
      // sources.url — match URL → GID, then append to modelResources so
      // the polling loop below picks them up alongside fresh uploads.
      const pmRes = await admin.graphql(`
        query ProductMedia3D($id: ID!) {
          product(id: $id) {
            media(first: 250) {
              nodes {
                ... on Model3d {
                  id
                  sources { url }
                }
              }
            }
          }
        }
      `, { variables: { id: productId } });
      const pmData = await pmRes.json();
      const nodes = (pmData.data?.product?.media?.nodes ?? []) as Array<{ id?: string; sources?: { url: string }[] }>;
      for (const n of nodes) {
        if (!n?.id || !n.sources) continue;
        for (const s of n.sources) {
          if (cdnUrlsNeedingPreview.has(s.url)) {
            modelResources.push({ gid: n.id, resourceUrl: s.url });
          }
        }
      }
    } catch (err) {
      console.warn("[update-variant-galleries] backfill product.media query failed:", err);
    }
  }
  if (modelResources.length > 0) {
    const gidToResourceUrl = new Map(modelResources.map(m => [m.gid, m.resourceUrl]));
    const pending = new Set(modelResources.map(m => m.gid));
    // 10-step backoff: starts immediate, extends to ~38s total. Big .glb
    // files (60MB+) commonly need 20-30s before Shopify's Model3d.preview
    // is generated server-side — the short 8.8s window meant the merchant
    // saved with an empty preview every time and had no way to backfill it
    // (besides re-uploading the same file). The window early-exits as
    // soon as `pending` empties, so saves with no pending models still
    // complete instantly.
    const delays = [0, 800, 1500, 2500, 4000, 5000, 6000, 6000, 6000, 6000];
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      if (pending.size === 0) break;
      try {
        const q = await admin.graphql(`
          query GetModel3dSources($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Model3d {
                id
                status
                sources { url }
                preview { image { url } status }
              }
            }
          }
        `, { variables: { ids: [...pending] } });
        const qd = await q.json();
        for (const node of (qd.data?.nodes ?? []) as Array<{ id: string; status: string; sources?: { url: string }[]; preview?: { image?: { url?: string } | null; status?: string } | null }>) {
          if (!node?.id) continue;
          const resourceUrl = gidToResourceUrl.get(node.id);
          if (!resourceUrl) continue;
          // Capture the auto-generated preview URL whenever Shopify has it.
          if (node.preview?.image?.url) {
            resourceUrlToShopifyPreviewUrl[resourceUrl] = node.preview.image.url;
          }
          if (node.status === "FAILED") {
            modelResolutionStatus[resourceUrl] = "failed";
            pending.delete(node.id);
            continue;
          }
          const isBackfill = cdnUrlsNeedingPreview.has(resourceUrl);
          if (node.sources?.[0]?.url && !isBackfill && !resourceUrlToModelUrl[resourceUrl]) {
            resourceUrlToModelUrl[resourceUrl] = node.sources[0].url;
            modelResolutionStatus[resourceUrl] = "ready";
          }
          // Stop polling this entry once we have everything we need from it.
          // Fresh uploads need both source URL and preview before they can
          // exit; backfill candidates only need the preview (their CDN URL
          // is already on the metafield).
          const sourceDone = isBackfill || !!resourceUrlToModelUrl[resourceUrl];
          const previewDone = !!resourceUrlToShopifyPreviewUrl[resourceUrl];
          if (sourceDone && previewDone) {
            pending.delete(node.id);
          }
        }
      } catch (err) {
        console.warn("[update-variant-galleries] Model3d polling iteration failed:", err);
        // Don't abort the save — the unresolved staging URLs simply land
        // in the "processing" bucket and the merchant retries the save.
        break;
      }
    }
    // Anything still pending after the bounded polling window is treated
    // as processing — the client carries the GID across so the next save
    // polls it directly (no duplicate productCreateMedia).
    // Exception: backfill candidates (CDN URLs already in variant_3d_models
    // whose preview hadn't generated yet). Their model itself is fine —
    // only the preview lagged. Don't mark them as "processing", which
    // would cause the sanitiser below to drop the model entirely. The
    // preview slot simply stays empty for this save; the next save's
    // backfill pass tries again.
    for (const gid of pending) {
      const resourceUrl = gidToResourceUrl.get(gid);
      if (!resourceUrl) continue;
      if (cdnUrlsNeedingPreview.has(resourceUrl)) continue;
      modelResolutionStatus[resourceUrl] = "processing";
    }
    console.log("[update-variant-galleries] resourceUrlToModelUrl", resourceUrlToModelUrl,
      "| modelResolutionStatus", modelResolutionStatus);
  }
  // Expose the staging-URL → Model3d-GID mapping so the variant3dModels loop
  // can attach it to "processing" drops, letting the client carry it across
  // to the next save.
  const resourceUrlToModelGid: Record<string, string> = {};
  for (const r of modelResources) {
    resourceUrlToModelGid[r.resourceUrl] = r.gid;
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

  // Any-position Model3d guard. variant_gallery is a list.file_reference
  // metafield, which Shopify rejects for Model3d at *any* index (the union
  // is MediaImage | Video | GenericFile). 3D models picked in variant mode
  // are routed to custom.variant_3d_models (list.url) — they must NEVER
  // appear in vg.fileGids. Fail closed here if an older client build or
  // a direct API call still slips one through.
  for (const vg of variantGalleries) {
    for (let i = 0; i < vg.fileGids.length; i++) {
      const raw = vg.fileGids[i];
      const kind = newMediaKindByResourceUrl[raw];
      const isModel = kind === "model" || raw.startsWith("gid://shopify/Model3d/");
      if (isModel) {
        errors.push(
          `position-${i}: variant ${vg.variantId} would store a 3D model in variant_gallery — ` +
          `Shopify only accepts MediaImage/Video/GenericFile here. Add the 3D model to the product gallery instead.`
        );
      }
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

  // 3D models (.glb URLs) per variant — same partial-failure semantics as
  // external videos. Drops include a `reason` so the client can give a
  // useful nudge instead of a generic "save failed". Three reasons:
  //   "processing"  — uploaded .glb still being processed by Shopify after
  //                   the post-create polling window timed out; re-save
  //                   in a few seconds and it lands.
  //   "invalid_glb" — Shopify Model3d.status came back FAILED (corrupt
  //                   file, unsupported format inside the GLB container).
  //   "invalid_url" — anything else that doesn't pass isValid3dModelUrl
  //                   (typo, non-`.glb` URL, malformed).
  const dropped3dModelUrls: Array<{ variantId: string; url: string; reason: "processing" | "invalid_glb" | "invalid_url"; gid?: string }> = [];
  // Look up parallel previews per variant. Same-index pairing with the
  // model urls array — when a model gets dropped (processing / invalid /
  // failed) its preview at the same index is dropped too so the persisted
  // arrays stay aligned at write time.
  const previewsByVid: Record<string, string[]> = {};
  for (const p of variant3dPreviews) previewsByVid[p.variantId] = p.urls;
  for (const m of variant3dModels) {
    const sanitized: string[] = [];
    const sanitizedPreviews: string[] = [];
    const previewsForVariant = previewsByVid[m.variantId] ?? [];
    for (let i = 0; i < m.urls.length; i++) {
      const u = m.urls[i];
      const status = modelResolutionStatus[u];
      if (status === "processing") {
        // Attach the Model3d GID so the client can carry it across and the
        // next save polls it directly (skipping productCreateMedia, so no
        // duplicate product media).
        dropped3dModelUrls.push({
          variantId: m.variantId,
          url: u,
          reason: "processing",
          gid: resourceUrlToModelGid[u],
        });
        continue;
      }
      if (status === "failed") {
        dropped3dModelUrls.push({ variantId: m.variantId, url: u, reason: "invalid_glb" });
        continue;
      }
      // Substitute staging URLs with their resolved CDN URLs (status==="ready"
      // entries land here). Library-picked URLs are not in the map and pass
      // through unchanged.
      const resolved = resourceUrlToModelUrl[u] ?? u;
      if (isValid3dModelUrl(resolved)) {
        sanitized.push(resolved);
        // Prefer the client's WebGL snapshot when present (handles existing
        // saves + small models), else fall back to Shopify's auto-generated
        // Model3d.preview.image.url (catches large .glb files where the
        // in-browser snapshot pipeline timed out).
        const clientPreview = previewsForVariant[i];
        const shopifyPreview = resourceUrlToShopifyPreviewUrl[u];
        sanitizedPreviews.push(clientPreview && clientPreview.trim() !== "" ? clientPreview : (shopifyPreview ?? ""));
      } else {
        dropped3dModelUrls.push({ variantId: m.variantId, url: u, reason: "invalid_url" });
      }
    }
    metafieldOps.push({
      ownerId: m.variantId,
      namespace: "custom",
      key: "variant_3d_models",
      type: "list.url",
      value: JSON.stringify(sanitized),
    });
    metafieldOps.push({
      ownerId: m.variantId,
      namespace: "custom",
      key: "variant_3d_previews",
      type: "list.url",
      value: JSON.stringify(sanitizedPreviews),
    });
  }

  for (const vo of variantGalleryOrder) {
    // The order metafield is the source of truth for the voll-mix gallery
    // sequence. Validate the shape here — relying purely on client-side
    // checks would let a DevTools-savvy merchant persist e.g. a URL at
    // position 0, which would desync variant.featured_image (still
    // MediaImage from vg.fileGids[0]) from the storefront's first tile.
    // Shape contract: array of { kind: "file" | "url" | "model", value: string }
    // with the first entry's kind === "file" (only MediaImage can become
    // variant.image — URLs / models can never occupy position 0).
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
      const validKind = entry?.kind === "file" || entry?.kind === "url" || entry?.kind === "model";
      if (!entry || typeof entry !== "object" || !validKind || typeof entry.value !== "string") {
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
    if (ue.length > 0) {
      errors.push(...ue.map((e: { message: string }) => `metafieldsSet: ${e.message}`));
      // If any userError points at a missing definition, drop the
      // verified-definitions cache for this shop. Next product open
      // will re-create whatever got deleted, so the merchant recovers
      // without needing a server restart.
      const missingDef = ue.some((e: { message: string }) => looksLikeMissingDefinitionError(e.message));
      if (missingDef) invalidateVariantDefsCache(session.shop);
    } else {
      completedSteps.push("metafieldsSet");
    }
  }

  if (errors.length > 0) return fail();
  if (dropped3dModelUrls.length > 0) {
    // Log the actual dropped URLs + reasons so a "model disappeared on
    // reload" report can be diagnosed without a separate trace pass.
    // Reasons: "processing" (poll timeout, carry-over via knownModelGids),
    // "invalid_glb" (Shopify Model3d status === FAILED), "invalid_url"
    // (URL did not pass isValid3dModelUrl — typically a library-pick
    // returning a non-glb / non-Shopify-Model3d source URL).
    console.warn("[update-variant-galleries] dropped 3D model URLs", dropped3dModelUrls);
  }
  if (droppedExternalUrls.length > 0) {
    console.warn("[update-variant-galleries] dropped external video URLs", droppedExternalUrls);
  }
  console.log("[update-variant-galleries] success", {
    completedSteps,
    droppedExternalUrlCount: droppedExternalUrls.length,
    dropped3dModelUrlCount: dropped3dModelUrls.length,
  });
  return json({ success: true, droppedExternalUrls, dropped3dModelUrls });
};

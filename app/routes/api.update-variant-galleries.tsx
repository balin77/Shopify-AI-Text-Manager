import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { isValidExternalVideoUrl, isValid3dModelUrl, kindToMediaContentType } from "../utils/mediaKind";
import type { MediaKind } from "../components/image-manager/types";
import { invalidateVariantDefsCache } from "./api.product-variants";
import {
  planVariantWrite,
  orderAfterMainChange,
  orderRestrictedToLinks,
  normalizeOrderHead,
  parseGalleryOrder,
  planMainMove,
  validateMainMoves,
  type MainMove,
  type MainRefusal,
  type VariantLookup,
  type VariantWritePlan,
} from "../services/variant-main-image.shared";

type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export interface ProductMediaLookup {
  /** The product's media: GID -> mediaContentType. */
  media: Map<string, string>;
  /** Only the variants that were asked for. */
  variants: Map<string, VariantLookup>;
  /** How many variants the product has (Shopify's default variant counts as one); null = not answered. */
  variantCount: number | null;
}

// Query sizes are a COST decision (Shopify's single-query ceiling is 1000 points):
// a media page of 100 is ~102 points, a variant chunk of 50 (own image + two
// metafields each) ~300. The first cut asked for 250 media and 250 variants in
// ONE query, which is ~2000 by the same estimate and was refused outright on a
// product with many variants. Only the variants the request names are read.
const MEDIA_PAGE_SIZE = 100;
const MEDIA_MAX_PAGES = 3;
const VARIANT_CHUNK = 50;

/** One GraphQL call; a top-level `errors` (including throttling) is logged, never swallowed. */
async function runLookupQuery(
  graphql: AdminGraphql,
  label: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any | null> {
  let d: any;
  try {
    const r = await graphql(query, { variables });
    d = await r.json();
  } catch (err) {
    // The app's admin.graphql THROWS (GraphqlQueryError) on a top-level errors array instead of
    // returning it: the codes are read off the error, never swallowed.
    const body = (err as { body?: { errors?: unknown } })?.body?.errors;
    const codes = Array.isArray(body)
      ? body.map((e: { message?: string; extensions?: { code?: string } }) => e?.extensions?.code ?? e?.message).join(", ")
      : err instanceof Error ? err.message : "unknown";
    console.warn(`[update-variant-galleries] ${label} lookup threw: ${codes}`);
    return null;
  }
  if (d?.errors) {
    const codes = Array.isArray(d.errors) ? d.errors.map((e: { message?: string; extensions?: { code?: string } }) => e?.extensions?.code ?? e?.message).join(", ") : String(d.errors);
    console.warn(`[update-variant-galleries] ${label} lookup returned errors: ${codes}`);
    return null;
  }
  return d?.data ?? null;
}

/**
 * A fresh read of what Shopify holds for this product: which media exist, and for
 * the named variants their native image, stored gallery and stored order. The
 * route does not trust the client for "what the current main image is". `null` =
 * the read failed (logged): a write that touches a main image is then refused and
 * nothing is written for it (fail closed); a plain gallery write falls back to
 * what the client sent.
 */
export async function lookupProductMedia(
  graphql: AdminGraphql,
  productId: string,
  variantIds: readonly string[],
): Promise<ProductMediaLookup | null> {
  try {
    const media = new Map<string, string>();
    let variantCount: number | null = null;
    let after: string | null = null;
    for (let page = 0; page < MEDIA_MAX_PAGES; page++) {
      const data = await runLookupQuery(
        graphql,
        "product media",
        `query productMediaPage($id: ID!, $first: Int!, $after: String) {
          product(id: $id) {
            variantsCount { count }
            media(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id mediaContentType }
            }
          }
        }`,
        { id: productId, first: MEDIA_PAGE_SIZE, after },
      );
      const conn = data?.product?.media;
      if (!conn) return null;
      const count = data?.product?.variantsCount?.count;
      if (typeof count === "number" && Number.isFinite(count)) variantCount = count;
      for (const n of conn.nodes ?? []) media.set(n.id, n.mediaContentType);
      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor ?? null;
      if (!after) break;
    }
    const variants = new Map<string, VariantLookup>();
    const ids = [...new Set(variantIds)];
    for (let i = 0; i < ids.length; i += VARIANT_CHUNK) {
      const data = await runLookupQuery(
        graphql,
        "variants",
        `query variantsForGalleries($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              media(first: 1) { nodes { id } }
              gallery: metafield(namespace: "custom", key: "variant_gallery") { value }
              order: metafield(namespace: "custom", key: "variant_gallery_order") { value }
              links: metafield(namespace: "custom", key: "variant_external_videos") { value }
              models: metafield(namespace: "custom", key: "variant_3d_models") { value }
            }
          }
        }`,
        { ids: ids.slice(i, i + VARIANT_CHUNK) },
      );
      if (!data) return null;
      for (const v of data.nodes ?? []) {
        if (!v?.id) continue;
        let gallery: string[] = [];
        try {
          const parsed = JSON.parse(v.gallery?.value ?? "[]");
          if (Array.isArray(parsed)) gallery = parsed.filter((g): g is string => typeof g === "string");
        } catch { /* an unreadable list is no list */ }
        const strList = (raw?: string | null): string[] | undefined => {
          if (raw == null) return [];
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : undefined;
          } catch { return undefined; }
        };
        variants.set(v.id, {
          main: v.media?.nodes?.[0]?.id ?? null,
          gallery,
          order: v.order?.value ?? null,
          links: strList(v.links?.value),
          models: strList(v.models?.value),
        });
      }
    }
    return { media, variants, variantCount };
  } catch (err) {
    console.warn("[update-variant-galleries] lookup failed", err instanceof Error ? err.message : "unknown");
    return null;
  }
}

/**
 * Image references in a gallery whose file does not exist any more (a deleted
 * medium can leave a dead reference in `variant_gallery`). Such a reference is
 * never promoted: it is not a failed attach, there is nothing to attach. A read
 * that fails reports none (the attach step still refuses a file it cannot find).
 */
async function findDeadFiles(graphql: AdminGraphql, gids: readonly string[]): Promise<Set<string>> {
  const dead = new Set<string>();
  const ids = [...new Set(gids)];
  for (let i = 0; i < ids.length; i += VARIANT_CHUNK) {
    const chunk = ids.slice(i, i + VARIANT_CHUNK);
    try {
      const data = await runLookupQuery(
        graphql,
        "file existence",
        `query fileExistence($ids: [ID!]!) {
          nodes(ids: $ids) { ... on MediaImage { id } }
        }`,
        { ids: chunk },
      );
      if (!data) continue;
      const alive = new Set<string>((data.nodes ?? []).filter(Boolean).map((n: { id?: string }) => n.id).filter(Boolean));
      for (const g of chunk) if (!alive.has(g)) dead.add(g);
    } catch (err) {
      // unknown = alive, but never silent
      console.warn("[update-variant-galleries] file existence check threw", err instanceof Error ? err.message : "unknown");
    }
  }
  return dead;
}

/**
 * Attach a MediaImage that is a library file (not yet one of the product's media)
 * to the product, so it can be a variant's native image. `fileUpdate` with
 * `referencesToAdd` only ever ADDS the reference (never `referencesToRemove`, and
 * nothing here undoes an attach). A file that is not READY is not attempted.
 * Returns an error string, or null when Shopify accepted it; the caller confirms
 * by reading the product's media again.
 */
async function attachFileToProduct(graphql: AdminGraphql, productId: string, fileId: string): Promise<string | null> {
  try {
    const status = await runLookupQuery(
      graphql,
      "file status",
      `query fileStatusForAttach($ids: [ID!]!) {
        nodes(ids: $ids) { ... on MediaImage { id fileStatus } }
      }`,
      { ids: [fileId] },
    );
    const node = (status?.nodes ?? [])[0];
    if (!node?.id) return "file not found";
    if (node.fileStatus !== "READY") return `file is not ready (${String(node.fileStatus)})`;
    const r = await graphql(
      `mutation fileAttachToProduct($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
      { variables: { files: [{ id: fileId, referencesToAdd: [productId] }] } },
    );
    const d = await r.json();
    if (d?.errors) return "fileUpdate was refused";
    const ue = d?.data?.fileUpdate?.userErrors ?? [];
    if (ue.length > 0) return ue.map((e: { message: string }) => e.message).join("; ");
    return null;
  } catch (err) {
    console.warn("[update-variant-galleries] attach failed", err instanceof Error ? err.message : "unknown");
    return "attach failed";
  }
}

const REFUSAL_TEXT: Record<MainRefusal, string> = {
  mainChangedElsewhere: "the variant's main image was changed elsewhere in the meantime",
  lookupFailed: "the variant's current state could not be read from Shopify",
  attachFailed: "the image could not be added to the product",
  attachNotConfirmed: "the image was added to the product but is not visible yet; nothing was saved for the variant, try again",
  variantNotFound: "the variant no longer exists",
  notAnImage: "only an image can be a variant's main image",
  mainFileGone: "the image chosen as main image no longer exists",
  moveCounterpartRefused: "the other variant of the main image move could not be saved, so neither variant was changed",
};


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
  /** Per variant: the file references as the editor holds them, plus the EXPLICIT intent about
   *  its main image (see variant-main-image.shared.ts): `galleryOnly` (main untouched),
   *  `promoteIfEmpty` (no native image: a real edit promotes the first own image),
   *  `removedMainGid` (the main image the merchant removed) or `mainGid` +
   *  `expectedMainGid` (dragged to the first slot of the variant's own gallery). */
  variantGalleries?: Array<{
    variantId: string;
    fileGids: string[];
    galleryOnly?: boolean;
    promoteIfEmpty?: boolean;
    removedMainGid?: string;
    mainGid?: string;
    expectedMainGid?: string | null;
  }>;
  mediaOrder?: Array<{ mediaId: string; position: number }>;
  /** Variants whose main image the merchant removed (medium deleted) WITHOUT a pending
   *  gallery, with the GID that was removed. Acts only while the fresh main image still is
   *  that GID (or empty): a replay, a double click or a stale tab changes nothing. */
  removedMainImages?: Array<{ variantId: string; removedMainGid: string }>;
  /** Main images MOVED from one variant to another. Each move ties two ordinary statements together:
   *  the source's `removedMainGid` (in `variantGalleries` or `removedMainImages`) and the target's list /
   *  `mainGid` in `variantGalleries`. Both are checked against the fresh read before anything is written
   *  and are written in ONE productVariantsBulkUpdate, or neither is (see planMainMove). */
  mainMoves?: MainMove[];
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
  /** GIDs of media an EARLIER, failed attempt of this save created (the retry references them by GID).
   *  A removal does not promote them either; each must be product media in the fresh read. */
  retainedCreatedGids?: string[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body: UpdateVariantGalleriesBody = await request.json();
  const {
    productId,
    newMedia = [],
    variantGalleries = [],
    mediaOrder = [],
    removedMainImages = [],
    variantExternalVideos = [],
    variant3dModels = [],
    variant3dPreviews = [],
    knownModelGids = {},
    variantGalleryOrder = [],
    retainedCreatedGids = [],
    mainMoves = [],
  } = body;

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
  const fail = (refusals: Array<{ variantId: string; code: MainRefusal }> = []) => {
    console.error("[update-variant-galleries] aborting with errors", {
      errors,
      completedSteps,
      refusals,
      newMediaCount: newMedia?.length ?? 0,
      newMediaKinds: (newMedia ?? []).map((m: { kind?: string }) => m.kind ?? "image"),
    });
    // Media created before the failure are reported with it, so a second Save converts the staged
    // references to these GIDs instead of uploading every new medium again.
    return json({ success: false, errors, completedSteps, refusals, createdMedia: createdMediaList() }, { status: 422 });
  };
  const createdMediaList = () =>
    newMedia
      .map(m => ({ resourceUrl: m.resourceUrl, mediaId: resourceUrlToGid[m.resourceUrl] ?? null, kind: (m.kind ?? "image") as MediaKind }))
      .filter((m): m is { resourceUrl: string; mediaId: string; kind: MediaKind } => m.mediaId !== null);

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

  // A main-image MOVE must be well-formed before anything is created or written: both statements present,
  // consistent with each other. A malformed one is a client bug or a direct POST; nothing is done for it.
  if (Array.isArray(mainMoves) && mainMoves.length > 0) {
    const views = new Map<string, { fileGids: readonly string[] | null; removedMainGid: string | null; mainGid: string | null }>();
    for (const vg of variantGalleries) {
      views.set(vg.variantId, { fileGids: vg.fileGids, removedMainGid: vg.removedMainGid ?? null, mainGid: vg.mainGid ?? null });
    }
    for (const rm of removedMainImages) {
      if (rm?.variantId && !views.has(rm.variantId)) views.set(rm.variantId, { fileGids: null, removedMainGid: rm.removedMainGid ?? null, mainGid: null });
      else if (rm?.variantId && !views.get(rm.variantId)!.removedMainGid) views.get(rm.variantId)!.removedMainGid = rm.removedMainGid ?? null;
    }
    const moveErrors = validateMainMoves(mainMoves, views);
    if (moveErrors.length > 0) {
      errors.push(...moveErrors, "nothing was uploaded and nothing was written");
      return fail();
    }
  }

  // Pre-flight, BEFORE anything is created: a request that touches a main image needs a fresh read.
  // Failing here (nothing written, nothing uploaded) means a retry cannot upload the new media twice.
  {
    const touching = [
      ...variantGalleries.filter(v => v.removedMainGid || v.mainGid || v.promoteIfEmpty).map(v => v.variantId),
      ...removedMainImages.map(r => r?.variantId),
      // both variants of a move are checked against the fresh read, the target too
      ...(Array.isArray(mainMoves) ? mainMoves.flatMap(m => [m.sourceVariantId, m.targetVariantId]) : []),
    ].filter((id): id is string => typeof id === "string");
    if (touching.length > 0) {
      const pre = await lookupProductMedia(admin.graphql as unknown as AdminGraphql, productId, touching);
      if (!pre) {
        const refusals = [...new Set(touching)].map(variantId => ({ variantId, code: "lookupFailed" as MainRefusal }));
        errors.push(`variants: ${REFUSAL_TEXT.lookupFailed}; nothing was uploaded and nothing was written`);
        return fail(refusals);
      }
    }
  }
  if (newMedia.length > 0) {
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
    const ue = d.data?.productCreateMedia?.mediaUserErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `createMedia: ${e.message}`));

    const createdMedia: { id: string }[] = d.data?.productCreateMedia?.media ?? [];
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
    // With equal counts the positional mapping holds even beside mediaUserErrors: what was created is
    // reported with the failure, so a retry does not upload it again. With different counts nothing is
    // mapped (the order of the answer cannot be trusted); those media may be duplicated by a retry.
    if (errors.length > 0) {
      if (createdMedia.length === newMedia.length) {
        newMedia.forEach((m, i) => { if (createdMedia[i]?.id) resourceUrlToGid[m.resourceUrl] = createdMedia[i].id; });
      }
      return fail();
    }

    // Map each resourceUrl to the GID of the newly created media (response order matches input order)
    newMedia.forEach((m, i) => {
      if (createdMedia[i]?.id) {
        resourceUrlToGid[m.resourceUrl] = createdMedia[i].id;
      } else {
        console.warn("[update-variant-galleries] no GID for index", i, "resourceUrl", m.resourceUrl);
      }
    });
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
  // CRITICAL: exclude staging URLs from the backfill candidate set.
  //   • Fresh uploads (newMedia[kind=model]) — handled by productCreateMedia.
  //   • Carry-over from a prior save (knownModelGids keys) — handled by the
  //     polling block via the GID directly, NOT by URL.
  // Treating either as backfill makes the polling block skip source-URL
  // substitution (isBackfill === true short-circuits the assignment), so
  // modelResolutionStatus never reaches "ready", the cleanup downgrades
  // it to "processing", and the merchant's carry-over loops forever.
  const freshUploadStagingUrls = new Set<string>([
    ...newMedia.filter(m => m.kind === "model").map(m => m.resourceUrl),
    ...Object.keys(knownModelGids ?? {}),
  ]);
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
  // Set of every CDN URL Shopify currently exposes on product.media for
  // any Model3d on this product. Used for (a) backfill (matching the URL
  // back to its Model3d GID so we can poll the preview) and (b) orphan
  // detection (drop variant_3d_models entries whose underlying Model3d
  // has been deleted from product.media — without this the metafield
  // would carry a dead URL forever and the storefront would 404 on it).
  const knownProductModelUrls = new Set<string>();
  // Build a separate map: variant URL (whatever we have in the metafield,
  // possibly stale) → currently-known canonical sources for its Model3d.
  // Lets us check "is this URL one of the sources of any current Model3d?".
  // Only fire the query when we actually have variant_3d_models data to
  // validate — saves a roundtrip for products with no 3D.
  const anyCdnLikeUrl = variant3dModels.some(m => m.urls.some(u =>
    u.startsWith("https://") && !freshUploadStagingUrls.has(u)
  ));
  if (anyCdnLikeUrl || cdnUrlsNeedingPreview.size > 0) {
    try {
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
          knownProductModelUrls.add(s.url);
          if (cdnUrlsNeedingPreview.has(s.url)) {
            modelResources.push({ gid: n.id, resourceUrl: s.url });
          }
        }
      }
    } catch (err) {
      console.warn("[update-variant-galleries] product.media query failed:", err);
    }
  }
  if (modelResources.length > 0) {
    // Multiple entries can share the same Model3d GID — e.g. the merchant
    // uploads the same .glb twice in the same save (carry-over staging URL
    // from a previous save + a fresh upload), or a backfill candidate's
    // CDN URL maps to a Model3d whose other source URL is also in
    // newMedia. Track resourceUrls per GID as a Set so polling can apply
    // the resolution to every variant slot pointing at that Model3d, not
    // just the last one inserted.
    const gidToResourceUrls = new Map<string, Set<string>>();
    for (const r of modelResources) {
      const set = gidToResourceUrls.get(r.gid) ?? new Set();
      set.add(r.resourceUrl);
      gidToResourceUrls.set(r.gid, set);
    }
    const pending = new Set(gidToResourceUrls.keys());
    // Minimal sync polling: one immediate query, one quick retry. Source
    // URL resolution for small .glb files often lands within ~1.5s; if
    // it doesn't, we don't block the save — fall through to "processing",
    // let the client carry the Model3d GID across, and the background
    // /api/refresh-3d-previews endpoint resolves it asynchronously while
    // the merchant continues working. Anything longer here just freezes
    // the Save button for no upside.
    const delays = [0, 1500];
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
                sources { url format mimeType }
                preview { image { url } status }
              }
            }
          }
        `, { variables: { ids: [...pending] } });
        const qd = await q.json();
        for (const node of (qd.data?.nodes ?? []) as Array<{ id: string; status: string; sources?: { url: string; format?: string; mimeType?: string }[]; preview?: { image?: { url?: string } | null; status?: string } | null }>) {
          if (!node?.id) continue;
          const resourceUrls = gidToResourceUrls.get(node.id);
          if (!resourceUrls || resourceUrls.size === 0) continue;
          // Pick the GLB source explicitly. Shopify exposes multiple sources
          // per Model3d (.glb + .usdz at minimum). The storefront's
          // <model-viewer> only renders glTF — .usdz in the metafield would
          // make the variant gallery show a generic placeholder and the
          // storefront fail to load the model.
          const glbSource = node.sources?.find(s =>
            s.format === "model/gltf-binary" ||
            s.mimeType === "model/gltf-binary" ||
            /\.glb(\?|$)/i.test(s.url),
          );
          let allDone = true;
          for (const resourceUrl of resourceUrls) {
            // Capture the auto-generated preview URL whenever Shopify has it.
            if (node.preview?.image?.url) {
              resourceUrlToShopifyPreviewUrl[resourceUrl] = node.preview.image.url;
            }
            if (node.status === "FAILED") {
              modelResolutionStatus[resourceUrl] = "failed";
              continue;
            }
            const isBackfill = cdnUrlsNeedingPreview.has(resourceUrl);
            if (glbSource?.url && !isBackfill && !resourceUrlToModelUrl[resourceUrl]) {
              resourceUrlToModelUrl[resourceUrl] = glbSource.url;
              modelResolutionStatus[resourceUrl] = "ready";
            }
            // Stop polling this entry once the source URL is resolved (or it's
            // already resolved for backfill candidates). Preview readiness is
            // deferred to the /api/refresh-3d-previews background path so the
            // save doesn't block on it. For backfill candidates we still
            // require the preview because backfill IS the preview poll —
            // there's nothing else to wait for.
            const sourceDone = isBackfill || !!resourceUrlToModelUrl[resourceUrl];
            const previewDone = !!resourceUrlToShopifyPreviewUrl[resourceUrl];
            if (!(isBackfill ? previewDone : sourceDone)) allDone = false;
          }
          if (allDone || node.status === "FAILED") pending.delete(node.id);
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
    // Exceptions (do NOT downgrade to "processing"):
    //   • Backfill candidates: their model is fine, only the preview lagged.
    //     Skip; the preview slot stays empty this save, next save retries.
    //   • Already-resolved fresh uploads: status was set to "ready" when the
    //     source URL came back, but the entry stayed in `pending` because
    //     the loop exit also needed the preview. For big .glb files the
    //     preview can take minutes — overwriting "ready" to "processing"
    //     made the sanitiser drop the model entirely (variant_3d_models
    //     metafield saved as []), even though the source URL was perfectly
    //     usable. Keep "ready" and let the model land on the metafield;
    //     the preview backfill on the next save fills the preview slot.
    for (const gid of pending) {
      const resourceUrls = gidToResourceUrls.get(gid);
      if (!resourceUrls) continue;
      for (const resourceUrl of resourceUrls) {
        if (cdnUrlsNeedingPreview.has(resourceUrl)) continue;
        if (modelResolutionStatus[resourceUrl] === "ready") continue;
        modelResolutionStatus[resourceUrl] = "processing";
      }
    }
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
    ...(typeof vg.mainGid === "string" ? { mainGid: resolveGid(vg.mainGid) } : {}),
  }));

  // What the client sent about a variant's main image is validated against the
  // GID prefix further down (the plan refuses a main image that is not a
  // MediaImage); the kinds of freshly uploaded media are known only here.
  const newMediaKindByResourceUrl: Record<string, MediaKind> = {};
  for (const m of newMedia) {
    if (m.kind) newMediaKindByResourceUrl[m.resourceUrl] = m.kind;
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

  // The combined gallery order the client sent per variant is the source of truth
  // for the voll-mix sequence. Validate its shape BEFORE anything is written for a
  // variant: shape contract = array of { kind: "file" | "url" | "model", value:
  // string } whose first entry is a file reference (only a MediaImage can be a
  // variant's image; URLs / models can never lead).
  const clientOrders = new Map<string, string>();
  // Variants whose stored order must be DELETED (the client sent an empty order: no file entry is left,
  // for example after the last image was removed and only a link would remain).
  const orderClears = new Set<string>();
  for (const vo of variantGalleryOrder) {
    if (vo.orderJson === "") { orderClears.add(vo.variantId); continue; }
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
    // (an order of links / models only has no file entry and is valid: the embed renders those straight from it)
    if ((parsed as Array<{ kind: string }>).some(e => e.kind === "file") && (parsed[0] as { kind: string }).kind !== "file") {
      errors.push(
        `variantGalleryOrder: variant ${vo.variantId} — position 0 must be a file ` +
        `reference (image). Move an image to the first position before saving.`
      );
      continue;
    }
    // File entries are written as GIDs: a staged upload / asset URL of a medium created in this request
    // becomes that medium's GID; one that resolves to nothing is dropped (never written as it is).
    const resolved = (parsed as Array<{ kind: "file" | "url" | "model"; value: string }>)
      .map(e => (e.kind === "file" ? { ...e, value: resolveGid(e.value) } : e))
      .filter(e => e.kind !== "file" || e.value.startsWith("gid://"));
    const head = normalizeOrderHead(resolved);
    if (!head) { orderClears.add(vo.variantId); continue; }
    clientOrders.set(vo.variantId, head);
  }

  // Links and models an order may list: the ones the request writes for the variant, else the stored ones
  // (from the fresh read), else no restriction. A removed link must not stay live through an order.
  const resolveModelForOrder = (u: string): string | null => {
    const status = modelResolutionStatus[u];
    if (status === "processing" || status === "failed") return null;
    const resolved = resourceUrlToModelUrl[u] ?? u;
    if (knownProductModelUrls.size > 0 && resolved === u && !freshUploadStagingUrls.has(u) && !knownProductModelUrls.has(u)) return null;
    return isValid3dModelUrl(resolved) ? resolved : null;
  };
  const orderFor = (variantId: string, lk: VariantLookup | null | undefined): string | null | undefined => {
    const raw = clientOrders.get(variantId);
    if (raw === undefined) return undefined;
    const ev = variantExternalVideos.find(e => e.variantId === variantId);
    const md = variant3dModels.find(e => e.variantId === variantId);
    const urls = ev ? new Set(ev.urls.filter(isValidExternalVideoUrl)) : lk?.links ? new Set(lk.links) : null;
    // A model entry is written exactly as the metafield gets it: the staging URL of an upload becomes
    // its CDN URL, and a model that is dropped (still processing, invalid, orphaned, not listed) is
    // not in the order either.
    const mapped: Array<{ kind: string; value: string }> = [];
    for (const e of parseGalleryOrder(raw) ?? []) {
      if (e.kind !== "model") { mapped.push(e); continue; }
      if (md && !md.urls.includes(e.value)) continue;
      const m = resolveModelForOrder(e.value);
      if (m) mapped.push({ ...e, value: m });
    }
    return orderRestrictedToLinks(JSON.stringify(mapped), urls, md ? null : lk?.models ? new Set(lk.models) : null);
  };
  const storedOrderFor = (variantId: string, lk: VariantLookup): VariantLookup => {
    if (!lk.order) return lk;
    const ev = variantExternalVideos.find(e => e.variantId === variantId);
    const md = variant3dModels.find(e => e.variantId === variantId);
    const urls = ev ? new Set(ev.urls.filter(isValidExternalVideoUrl)) : lk.links ? new Set(lk.links) : null;
    const models = md ? new Set(md.urls) : lk.models ? new Set(lk.models) : null;
    return { ...lk, order: orderRestrictedToLinks(lk.order, urls, models) };
  };
  // Variants whose order metafield is deleted by this request (no plan wrote an order for them).
  const orderDeletes = new Set<string>(orderClears);

  if (errors.length > 0) return fail();

  // 2. Bilder neu sortieren. Runs AFTER the variants were read afresh and checked (step 3),
  // right before the variant write, so a refused variant leaves the product's media order alone.
  let reordered = false;
  const runReorder = async (): Promise<boolean> => {
    reordered = true;
    if (mediaOrder.length === 0) return true;
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
    return errors.length === 0;
  };

  // 3. Variant-Galerien (Metafelder) updaten + Hauptbilder ggf. ersetzen
  //
  // Write order: productCreateMedia (above); attach a library image to the product
  // when it is to become a main image; a FRESH read and the expected-state check
  // after both; productReorderMedia; ONE productVariantsBulkUpdate per call with
  // `mediaId`, `variant_gallery` and `variant_gallery_order` in the same variant
  // input; the DB mirror; metafieldsSet for videos and models (below).
  //
  // The rule for every variant written here (see variant-main-image.shared.ts):
  // the variant's main image is NEVER stored in `variant_gallery`, it changes only
  // on an explicit intent compared with the fresh read, and a variant that loses
  // its main image gets the next image of its OWN gallery in the same write. A
  // variant the fresh read contradicts is refused (and nothing is written for it);
  // the others are written. A failed read refuses every variant whose main image
  // the request touches (fail closed).
  type VariantIntent = {
    variantId: string;
    fileGids: string[] | null;
    galleryOnly: boolean;
    promoteIfEmpty: boolean;
    removedMainGid: string | null;
    mainGid: string | null;
    expectedMainGid: string | null;
  };
  const gidOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? resolveGid(v) : null);
  const intents = new Map<string, VariantIntent>();
  for (const vg of resolvedVariantGalleries) {
    intents.set(vg.variantId, {
      variantId: vg.variantId,
      fileGids: vg.fileGids,
      galleryOnly: !!vg.galleryOnly,
      promoteIfEmpty: !!vg.promoteIfEmpty,
      removedMainGid: gidOrNull(vg.removedMainGid),
      mainGid: gidOrNull(vg.mainGid),
      expectedMainGid: gidOrNull(vg.expectedMainGid),
    });
  }
  for (const rm of removedMainImages) {
    const gid = gidOrNull(rm?.removedMainGid);
    if (!rm?.variantId || !gid) continue;
    const existing = intents.get(rm.variantId);
    if (existing) existing.removedMainGid = existing.removedMainGid ?? gid;
    else {
      intents.set(rm.variantId, {
        variantId: rm.variantId,
        fileGids: null,
        galleryOnly: false,
        promoteIfEmpty: false,
        removedMainGid: gid,
        mainGid: null,
        expectedMainGid: null,
      });
    }
  }

  // Variants refused (variantId -> code), reported to the client in its own words.
  const refusedVariants: Array<{ variantId: string; code: MainRefusal }> = [];
  // The plan each written variant got, for the local mirror.
  const plans = new Map<string, VariantWritePlan>();
  const writtenByBulk = new Set<string>();
  let lookedFinal: ProductMediaLookup | null = null;
  if (intents.size > 0) {
    const graphql = admin.graphql as unknown as AdminGraphql;
    const touchesMain = (i: VariantIntent) => !!i.removedMainGid || !!i.mainGid || i.promoteIfEmpty;
    let looked = await lookupProductMedia(graphql, productId, [...intents.keys()]);

    // Image references that are not product media may be library files (attachable) or
    // dead references (a deleted medium); only the latter must never be promoted.
    let deadFiles = new Set<string>();
    if (looked) {
      const refs: string[] = [];
      for (const intent of intents.values()) {
        for (const g of [...(intent.fileGids ?? looked.variants.get(intent.variantId)?.gallery ?? []), ...(intent.mainGid ? [intent.mainGid] : [])]) {
          if (g.startsWith("gid://shopify/MediaImage/") && !looked.media.has(g)) refs.push(g);
        }
      }
      deadFiles = await findDeadFiles(graphql, refs);
    }

    const createdFromRequest = Object.values(resourceUrlToGid);
    const planAll = (lookup: ProductMediaLookup | null) => {
      // (media of an earlier failed attempt count as created too, when the fresh read confirms them)
      const createdGidSet = new Set([
        ...createdFromRequest,
        ...(Array.isArray(retainedCreatedGids) ? retainedCreatedGids : []).filter((g): g is string => typeof g === "string" && !!lookup?.media.has(g)),
      ]);
      plans.clear();
      // Moves are decided against the fresh read of BOTH variants first: a move that is already done
      // writes nothing for either, one the read contradicts refuses both.
      const moveVerdict = new Map<string, { kind: "done" } | { kind: "refuse"; code: MainRefusal }>();
      for (const move of mainMoves) {
        const src = lookup?.variants.get(move.sourceVariantId) ?? null;
        const tgt = lookup?.variants.get(move.targetVariantId) ?? null;
        if (!lookup) continue;
        const d = planMainMove(move, src, tgt);
        if (d.kind === "proceed") continue;
        if (d.kind === "done") {
          moveVerdict.set(move.sourceVariantId, { kind: "done" });
          moveVerdict.set(move.targetVariantId, { kind: "done" });
        } else {
          const own = d.side === "source" ? move.sourceVariantId : move.targetVariantId;
          const other = d.side === "source" ? move.targetVariantId : move.sourceVariantId;
          moveVerdict.set(own, { kind: "refuse", code: d.code });
          moveVerdict.set(other, { kind: "refuse", code: "moveCounterpartRefused" });
        }
      }
      for (const intent of intents.values()) {
        const verdict = moveVerdict.get(intent.variantId);
        if (verdict?.kind === "done") {
          plans.set(intent.variantId, { action: "skip", mediaId: undefined, gallery: [] });
          continue;
        }
        if (verdict?.kind === "refuse") {
          plans.set(intent.variantId, { action: "refuse", refusal: verdict.code, mediaId: undefined, gallery: [] });
          continue;
        }
        if (lookup && !lookup.variants.has(intent.variantId)) {
          // An unknown or deleted variant refuses only itself; Shopify would refuse the whole bulk update.
          plans.set(intent.variantId, { action: "refuse", refusal: "variantNotFound", mediaId: undefined, gallery: [] });
          continue;
        }
        if (intent.mainGid && deadFiles.has(intent.mainGid)) {
          // A chosen main image whose file is gone: refused before any attach is attempted.
          plans.set(intent.variantId, { action: "refuse", refusal: "mainFileGone", mediaId: undefined, gallery: [] });
          continue;
        }
        const plan = planVariantWrite({
            fileGids: intent.fileGids,
            galleryOnly: intent.galleryOnly,
            promoteIfEmpty: intent.promoteIfEmpty,
            removedMainGid: intent.removedMainGid,
            mainGid: intent.mainGid,
            expectedMainGid: intent.expectedMainGid,
            lookup: lookup?.variants.get(intent.variantId) ? storedOrderFor(intent.variantId, lookup.variants.get(intent.variantId)!) : null,
            clientOrderJson: orderFor(intent.variantId, lookup?.variants.get(intent.variantId)) ?? null,
            productMedia: lookup?.media ?? null,
            isCandidate: (gid: string) => !deadFiles.has(gid),
            // A removal does not promote a medium created in THIS request (the editor shows no promoted image
            // for it); a variant with NO native image gets its first own image, a created one included.
            createdGids: createdGidSet,
            variantCount: lookup?.variantCount ?? null,
        });
        // A reference to a file that no longer exists is not written back into the gallery.
        if (deadFiles.size > 0) plan.gallery = plan.gallery.filter((g) => !deadFiles.has(g));
        plans.set(intent.variantId, plan);
      }
      coupleMoves();
    };
    // Both or neither: when either variant of a move is refused (for ANY reason: the fresh read, a dead
    // file, a failed attach), the other is refused too, so the image never leaves the source without
    // arriving in the target, nor the other way round.
    const coupleMoves = () => {
      for (const move of mainMoves) {
        const a = plans.get(move.sourceVariantId);
        const b = plans.get(move.targetVariantId);
        if (!a || !b) continue;
        if (a.action === "refuse" && b.action !== "refuse") {
          plans.set(move.targetVariantId, { action: "refuse", refusal: "moveCounterpartRefused", mediaId: undefined, gallery: [] });
        } else if (b.action === "refuse" && a.action !== "refuse") {
          plans.set(move.sourceVariantId, { action: "refuse", refusal: "moveCounterpartRefused", mediaId: undefined, gallery: [] });
        }
      }
    };
    planAll(looked);

    // A main image is never touched on a guess: a failed read refuses the write
    // (the media already created above stay on the product, nothing else changes).
    const unread = [...plans.entries()].filter(([, p]) => p.action === "refuse" && p.refusal === "lookupFailed");
    if (unread.length > 0) {
      for (const [variantId] of unread) refusedVariants.push({ variantId, code: "lookupFailed" });
      errors.push(`variants: ${REFUSAL_TEXT.lookupFailed}; no main image was changed and nothing was written for the variants`);
      return fail(refusedVariants);
    }

    // Attach library images that are about to become a main image. Shopify refuses a
    // `mediaId` that is not one of the product's media, and that would refuse the whole
    // bulk update. The attach only ADDS the product reference; nothing here undoes it.
    const toAttach = [...new Set([...plans.values()].map(p => p.attach).filter((g): g is string => !!g))];
    if (toAttach.length > 0) {
      const attachFailed = new Set<string>();
      for (const gid of toAttach) {
        const err = await attachFileToProduct(graphql, productId, gid);
        if (err) {
          attachFailed.add(gid);
          console.warn("[update-variant-galleries] attach refused", { error: err });
        } else {
          completedSteps.push("fileUpdate");
        }
      }
      // Fresh read after the attach: the expected-state check runs again on it, and
      // an image that did not show up among the product's media is not promoted.
      looked = await lookupProductMedia(graphql, productId, [...intents.keys()]);
      if (!looked && [...intents.values()].some(touchesMain)) {
        for (const intent of intents.values()) if (touchesMain(intent)) refusedVariants.push({ variantId: intent.variantId, code: "lookupFailed" });
        errors.push(`variants: ${REFUSAL_TEXT.lookupFailed}; no main image was changed and nothing was written for the variants`);
        return fail(refusedVariants);
      }
      planAll(looked);
      for (const [variantId, plan] of plans) {
        if (plan.attach && (attachFailed.has(plan.attach) || !looked?.media.has(plan.attach))) {
          // Shopify accepted the attach but the read does not show it yet (read lag) is NOT a refusal
          // by Shopify: nothing is written and the merchant keeps the edit to try again.
          const code: MainRefusal = attachFailed.has(plan.attach) ? "attachFailed" : "attachNotConfirmed";
          plans.set(variantId, { action: "refuse", refusal: code, mediaId: undefined, gallery: [] });
        }
      }
      coupleMoves();
      const unconfirmed = [...plans.entries()].filter(([, p]) => p.refusal === "attachNotConfirmed");
      if (unconfirmed.length > 0) {
        // Every refused variant is named, not only the unconfirmed ones.
        for (const [variantId, p] of plans) if (p.action === "refuse") refusedVariants.push({ variantId, code: p.refusal ?? "attachNotConfirmed" });
        errors.push(`variants: ${REFUSAL_TEXT.attachNotConfirmed}`);
        return fail(refusedVariants);
      }
    }

    lookedFinal = looked;
    const galleryMetafield = (gallery: string[]) => ({
      namespace: "custom",
      key: "variant_gallery",
      value: JSON.stringify(gallery),
      type: "list.file_reference",
    });
    const variantMap = new Map<string, object>();
    for (const [variantId, plan] of plans) {
      if (plan.action === "refuse") {
        refusedVariants.push({ variantId, code: plan.refusal ?? "mainChangedElsewhere" });
        continue;
      }
      if (plan.action === "skip") continue;
      const clientOrderNow = orderFor(variantId, looked?.variants.get(variantId));
      const orderValue = plan.clearOrder ? undefined : (plan.order ?? clientOrderNow ?? undefined);
      // The client sent an order, but nothing valid is left of it (only links): the stored one is deleted;
      // so is a main-only entry that no longer applies (the plan says so).
      if (plan.clearOrder || (!plan.order && clientOrderNow === null)) orderDeletes.add(variantId);
      variantMap.set(variantId, {
        id: variantId,
        ...(plan.mediaId !== undefined && { mediaId: plan.mediaId }),
        metafields: [
          galleryMetafield(plan.gallery),
          ...(orderValue ? [{ namespace: "custom", key: "variant_gallery_order", value: orderValue, type: "json" }] : []),
        ],
      });
      writtenByBulk.add(variantId);
    }

    if (!(await runReorder())) return fail();
    if (variantMap.size > 0) {
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
          variants: [...variantMap.values()],
        },
      });
      const d = await r.json();
      const ue = d.data?.productVariantsBulkUpdate?.userErrors ?? [];
      if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `variantsBulkUpdate: ${e.message}`));
      else completedSteps.push("productVariantsBulkUpdate");

      if (errors.length === 0) {
        await Promise.all([...variantMap.keys()].map((variantId) =>
          db.productVariant.updateMany({
            where: { shopifyGid: variantId },
            data: { galleryJson: JSON.stringify(plans.get(variantId)!.gallery) },
          }),
        ));
      }
    }
  }

  if (!reordered && !(await runReorder())) return fail();

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
  //   "orphaned"    — URL no longer matches any Model3d on product.media
  //                   (the merchant deleted the file). Drop it so the
  //                   metafield doesn't carry a dead reference indefinitely.
  const dropped3dModelUrls: Array<{ variantId: string; url: string; reason: "processing" | "invalid_glb" | "invalid_url" | "orphaned"; gid?: string }> = [];
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
      // Orphan check: a CDN URL the merchant has in their metafield but
      // that no longer matches any Model3d on product.media (file was
      // deleted in Shopify, or the URL came from a different product).
      // Skip the orphan check for staging URLs (knownProductModelUrls is
      // built from CDN sources only) and for entries we resolved via
      // resourceUrlToModelUrl (those came from product.media this call).
      if (
        knownProductModelUrls.size > 0 &&
        resolved === u && // unchanged → not a fresh-upload resolution
        !freshUploadStagingUrls.has(u) &&
        !knownProductModelUrls.has(u)
      ) {
        dropped3dModelUrls.push({ variantId: m.variantId, url: u, reason: "orphaned" });
        continue;
      }
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

  // A client order for a variant this request wrote above travelled in the same
  // variant input; a refused or skipped variant gets none. Only an order for a
  // variant with no gallery entry of its own is written here.
  for (const variantId of clientOrders.keys()) {
    const orderJson = orderFor(variantId, lookedFinal?.variants.get(variantId));
    if (intents.has(variantId)) {
      // A bare replay (skip) must not drop an order-only pending change; the removed main image is
      // taken out of it.
      const plan = plans.get(variantId);
      if (plan?.action === "skip") {
        if (orderJson === null) { orderDeletes.add(variantId); continue; }
        const removed = intents.get(variantId)?.removedMainGid ?? null;
        const cleaned = removed && orderJson ? orderAfterMainChange(orderJson, removed, null) : orderJson;
        if (cleaned ?? orderJson) metafieldOps.push({ ownerId: variantId, namespace: "custom", key: "variant_gallery_order", type: "json", value: (cleaned ?? orderJson)! });
      }
      continue;
    }
    if (orderJson === null) { orderDeletes.add(variantId); continue; }
    if (orderJson) metafieldOps.push({ ownerId: variantId, namespace: "custom", key: "variant_gallery_order", type: "json", value: orderJson });
  }
  if (errors.length > 0) return fail();

  // A refused variant gets nothing: no videos, 3D models or previews either.
  const refusedIds = new Set(refusedVariants.map(r => r.variantId));
  for (let i = metafieldOps.length - 1; i >= 0; i--) if (refusedIds.has(metafieldOps[i].ownerId)) metafieldOps.splice(i, 1);

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

  // Orders that are left with no file entry are DELETED (an order with only links would be invalid, and the
  // stored one would keep a removed link live): the embed then takes its default path.
  // (a clear that arrives together with an intent whose plan writes its own order is not applied: that order was
  // built from the stored one restricted to the variant's real links / models, so no removed entry stays live)
  const deleteIds = [...orderDeletes].filter(id => !refusedIds.has(id) && !(plans.get(id)?.order));
  if (errors.length === 0 && deleteIds.length > 0) {
    const r = await admin.graphql(`
      mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId namespace key }
          userErrors { field message }
        }
      }
    `, { variables: { metafields: deleteIds.map(ownerId => ({ ownerId, namespace: "custom", key: "variant_gallery_order" })) } });
    const d = await r.json();
    const payload = d.data?.metafieldsDelete;
    const ue = payload?.userErrors ?? [];
    if (ue.length > 0) errors.push(...ue.map((e: { message: string }) => `metafieldsDelete: ${e.message}`));
    else if (!payload || !Array.isArray(payload.deletedMetafields)) {
      // a payload that is null (a throttled answer carries empty userErrors too) confirms nothing
      errors.push("metafieldsDelete: no confirmation from Shopify");
    } else {
      const echoed: Array<{ ownerId?: string; key?: string } | null> = payload.deletedMetafields;
      // positional: slot i answers input i; a null slot means "not found" = already gone for THAT input
      const missing = echoed.length !== deleteIds.length
        ? deleteIds
        : deleteIds.filter((id, i) => echoed[i] !== null && !(echoed[i]?.ownerId === id && echoed[i]?.key === "variant_gallery_order"));
      if (missing.length > 0) errors.push("metafieldsDelete: the order was not confirmed deleted");
      else completedSteps.push("metafieldsDelete");
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
  // Hand every freshly created media node back with the staging URL it came
  // from. Shopify processes a new MediaImage asynchronously: productCreateMedia
  // returns the GID immediately but `image.url` stays null until processing
  // finishes, and /api/product-variants can only report media that HAS a URL.
  // Without this map the client had no way to tell "the image I just saved is
  // still processing" from "the image is gone", so it dropped its optimistic
  // tile on the post-save refetch and the merchant saw the upload vanish until
  // a full page reload. With it, the client keeps the tile (and polls) until
  // the GID shows up in the media map.
  const createdMedia = newMedia
    .map(m => ({
      resourceUrl: m.resourceUrl,
      mediaId: resourceUrlToGid[m.resourceUrl] ?? null,
      kind: (m.kind ?? "image") as MediaKind,
    }))
    .filter((m): m is { resourceUrl: string; mediaId: string; kind: MediaKind } => m.mediaId !== null);
  // Refused variants: when nothing at all was written the request failed (the client
  // keeps its pending state); when something was (created media, other variants) it
  // went through, and the client is told which variants were left alone, in its own
  // words, so it neither replays the new media nor hides that part of the edit.
  // (an attach alone is not a saved edit: a variant refused after only a fileUpdate is not "saved")
  if (refusedVariants.length > 0 && completedSteps.filter(step => step !== "fileUpdate").length === 0) {
    errors.push(...refusedVariants.map(r => `variant ${r.variantId}: ${REFUSAL_TEXT[r.code]}`));
    return fail(refusedVariants);
  }
  return json({ success: true, droppedExternalUrls, dropped3dModelUrls, createdMedia, refusedVariants });
};

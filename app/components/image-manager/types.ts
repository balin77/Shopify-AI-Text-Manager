export interface StagedItemParsedMeta {
  productName: string;
  variants: string[];
  identifier: string;
}

/** Coarse-grained media type as understood by both Shopify's productCreateMedia
 *  contentType enum and our admin/storefront UI. "external_video" never reaches
 *  productCreateMedia — it's persisted in a separate URL metafield. */
export type MediaKind = "image" | "video" | "model" | "external_video";

export interface StagedItem {
  uniqueId: string;
  previewUrl: string;
  resourceUrl: string;
  fileName: string;
  mimeType: string;
  progress: number;
  status: "uploading" | "ready" | "error";
  targetVariantId?: string;
  /** Parsed from filename: productName_variant1_..._identifier.ext */
  parsedMeta?: StagedItemParsedMeta;
  /** "unassigned" = no SKU match, "assigned" = auto-matched, "manual" = user-placed */
  assignmentMode?: "unassigned" | "assigned" | "manual";
  /** Drives upload route (stagedUploadsCreate.resource) + productCreateMedia.mediaContentType. */
  kind?: MediaKind;
  /** For 3D models only: the permanent Shopify CDN URL of the auto-generated
   *  preview JPEG (snapshot of the .glb via <model-viewer>.toBlob). Lives on
   *  the item from the moment BulkImageUploadPanel finishes uploading the
   *  snapshot via fileCreate. Distinct from `previewUrl`, which is a local
   *  blob: URL good only for the current session's admin display. The
   *  persistent URL is what gets written to custom.variant_3d_previews so
   *  the storefront can use it as both thumb and model-viewer poster. */
  persistentPreviewUrl?: string;
}

export interface VariantSelectedOption {
  name: string;    // option name, e.g. "Farbe"
  value: string;   // display value, e.g. "Aschgrau"
  handle: string | null;       // metaobject handle if linked, e.g. "ashgrey"
  metaobjectGid: string | null; // metaobject GID if linked — used for translation lookup (no type required)
  optionValueGid: string | null; // ProductOptionValue GID — used for translating non-linked option values (key="name")
}

export interface VariantWithGallery {
  id: string;              // gid://shopify/ProductVariant/...
  title: string;
  sku: string | null;
  imageKey: string | null;
  position: number;
  galleryFileGids: string[];  // gallery metafield only — does NOT include the main variant image
  mainImageGid?: string;      // GID of the variant's native featured image (mediaId)
  defaultImageUrl?: string;
  selectedOptions: VariantSelectedOption[];
  /** YouTube/Vimeo URLs from custom.variant_external_videos (list.url). */
  externalVideoUrls?: string[];
  /** GLB CDN URLs from custom.variant_3d_models (list.url). Shopify's
   *  list.file_reference rejects Media3d, so 3D models live in a parallel
   *  list.url metafield and are woven into galleryOrderJson via
   *  { kind: "model", value: url } entries. */
  threeDModelUrls?: string[];
  /** JPEG preview URLs from custom.variant_3d_previews (list.url). Parallel
   *  array to threeDModelUrls — index N here is the preview for index N in
   *  threeDModelUrls. Empty string at an index means no preview was
   *  generated for that model (e.g. legacy entries from before this
   *  metafield existed) — UI falls back to the "3D" placeholder. */
  threeDPreviewUrls?: string[];
  /** Optional total order across galleryFileGids ∪ externalVideoUrls ∪
   *  threeDModelUrls as JSON array of
   *  { kind: "file" | "url" | "model", value: gid|url }. Position 0 is
   *  always the variant's featured image — must remain image-only. */
  galleryOrderJson?: string | null;
}

/** Resolved media descriptor displayed in the Image Manager.
 *  GID-backed (image/video/model) or URL-backed (external_video). */
export interface ResolvedMediaItem {
  kind: MediaKind;
  /** GID for file-backed items, "ext:youtube:<id>"/"ext:vimeo:<id>" for URLs. */
  id: string;
  /** Best-effort thumbnail URL. May be empty for GLB without preview or for
   *  external videos before metadata fetch — UI must fall back to a placeholder. */
  previewUrl: string;
  /** Original GID for file items, full URL for external_video items. */
  reference: string;
}

export interface ImageMeta {
  altText?: string | null;
  mimeType?: string;       // e.g. "image/webp", "image/jpeg"
  isConverting?: boolean;  // true while a WebP conversion task is running for this image
  /** Drives the thumbnail rendering in SortableImageGrid: play overlay for
   *  video / external_video, "3D" badge for model. Undefined falls back to
   *  the legacy image branch. */
  kind?: MediaKind;
  /** Optional host label for external_video tiles (e.g. "YouTube" / "Vimeo"),
   *  shown as a small badge so the merchant can tell platforms apart at a
   *  glance. */
  externalHost?: string;
  /** Visual stand-in URL for non-image tiles whose primary URL can't be
   *  rendered as an <img> (3D model .glb, video resourceUrl). Populated from
   *  mediaMetaMap which receives it from BulkImageUploadPanel's snapshot
   *  pipeline for .glb uploads. Empty/undefined falls back to the kind-
   *  specific placeholder (e.g. "3D" badge for models). */
  previewUrl?: string;
  /** Tile is an unsaved optimistic entry: a fresh upload or library pick
   *  that has been added to pendingProductNewMedia / pendingVariantGalleries
   *  but not yet persisted to Shopify (productCreateMedia + metafieldsSet).
   *  Drives a semi-transparent treatment + a "Save?" badge so the merchant
   *  sees at a glance which tiles still need saving. */
  isPending?: boolean;
}

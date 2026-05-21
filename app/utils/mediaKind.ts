/**
 * Shared media-kind helpers for the Image Manager pipeline.
 *
 * Three orthogonal jobs live in this file:
 *   1. Classify a File / mime-type into a `MediaKind` (image | video | model).
 *   2. Translate that kind into the enum values Shopify expects on
 *      stagedUploadsCreate.resource and productCreateMedia.mediaContentType.
 *   3. Parse + validate YouTube / Vimeo URLs into an "external video"
 *      descriptor for the merchant-facing URL input.
 *
 * The list of accepted mime types is deliberately conservative — we only
 * accept what Shopify will accept on its end, so a successful local
 * classification implies a successful upload (modulo size limits).
 */

import type { MediaKind } from "../components/image-manager/types";

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

export const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export const MODEL_MIME_TYPES = [
  "model/gltf-binary",
  "model/gltf+json",
] as const;

export const ALL_UPLOADABLE_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  ...VIDEO_MIME_TYPES,
  ...MODEL_MIME_TYPES,
] as const;

/**
 * Classify a file by mime-type, with a filename fallback for GLB —
 * browsers commonly report .glb as application/octet-stream because
 * model/gltf-binary is not yet in the standard mime DB.
 */
export function classifyFile(mimeType: string, fileName?: string): MediaKind | null {
  if (IMAGE_MIME_TYPES.includes(mimeType as typeof IMAGE_MIME_TYPES[number])) return "image";
  if (VIDEO_MIME_TYPES.includes(mimeType as typeof VIDEO_MIME_TYPES[number])) return "video";
  if (MODEL_MIME_TYPES.includes(mimeType as typeof MODEL_MIME_TYPES[number])) return "model";
  if (fileName && /\.(glb|gltf)$/i.test(fileName)) return "model";
  return null;
}

/** Map our MediaKind to StagedUploadInput.resource. External video never
 *  hits stagedUploadsCreate (it's a URL, not a file upload) — the fallback
 *  is image-y just so an accidental call doesn't throw. */
export function kindToStagedResource(kind: MediaKind): "IMAGE" | "VIDEO" | "MODEL_3D" {
  switch (kind) {
    case "video": return "VIDEO";
    case "model": return "MODEL_3D";
    case "external_video":
    case "image":
    default: return "IMAGE";
  }
}

/** Map our MediaKind to productCreateMedia.mediaContentType. EXTERNAL_VIDEO
 *  is a first-class Shopify content type — it lets us hand productCreateMedia
 *  a YouTube/Vimeo URL as originalSource and Shopify produces an
 *  ExternalVideo node on product.media (which the storefront Liquid already
 *  knows how to render). */
export function kindToMediaContentType(kind: MediaKind): "IMAGE" | "VIDEO" | "MODEL_3D" | "EXTERNAL_VIDEO" {
  switch (kind) {
    case "video": return "VIDEO";
    case "model": return "MODEL_3D";
    case "external_video": return "EXTERNAL_VIDEO";
    case "image":
    default: return "IMAGE";
  }
}

// ---------------------------------------------------------------------------
// External video URL parsing (YouTube + Vimeo)
// ---------------------------------------------------------------------------

export type ExternalVideoHost = "youtube" | "vimeo";

export interface ParsedExternalVideo {
  host: ExternalVideoHost;
  externalId: string;
  /** Canonical embed URL (used for storefront iframe src). */
  embedUrl: string;
  /** A normalized form of the original input we can store in list.url. */
  canonicalUrl: string;
  /** Best-effort thumbnail URL — only YouTube returns one without an API call;
   *  Vimeo requires an OEmbed call, which we deliberately skip in the admin UI. */
  thumbnailUrl: string | null;
}

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_RE = /^\d{6,12}$/;

/**
 * Parse a YouTube/Vimeo URL into a structured descriptor. Returns null for
 * anything we can't safely embed — the caller surfaces that as a validation
 * error to the merchant. Accepts the common shapes:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://vimeo.com/ID
 *   - https://player.vimeo.com/video/ID
 */
export function parseExternalVideoUrl(input: string): ParsedExternalVideo | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  // YouTube ------------------------------------------------------------------
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    let id: string | null = null;
    if (host === "youtu.be") {
      id = u.pathname.replace(/^\//, "").split("/")[0] || null;
    } else if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else {
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
    if (!id || !YOUTUBE_ID_RE.test(id)) return null;
    return {
      host: "youtube",
      externalId: id,
      embedUrl: `https://www.youtube.com/embed/${id}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    };
  }

  // Vimeo --------------------------------------------------------------------
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/(?:video\/)?(\d+)/);
    const id = m?.[1] ?? null;
    if (!id || !VIMEO_ID_RE.test(id)) return null;
    return {
      host: "vimeo",
      externalId: id,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      canonicalUrl: `https://vimeo.com/${id}`,
      thumbnailUrl: null,
    };
  }

  return null;
}

/**
 * Validate that a value persisted in `custom.variant_external_videos` is still
 * a host we recognize. Defends against a stale or hand-edited metafield value
 * leaking through to the storefront.
 */
export function isValidExternalVideoUrl(input: string): boolean {
  return parseExternalVideoUrl(input) !== null;
}

// ---------------------------------------------------------------------------
// 3D model URL validation
// ---------------------------------------------------------------------------

/**
 * Validate that a value persisted in `custom.variant_3d_models` plausibly
 * points at a 3D model.
 *
 * Two acceptance paths:
 *   1. The URL pathname ends in `.glb` or `.gltf`. Covers self-hosted /
 *      external assets that the merchant pastes by hand.
 *   2. The URL is on a Shopify CDN host and lives under a Model3d-shaped
 *      path (`/3d/models/`). Shopify-served Model3d source URLs do NOT
 *      always end in `.glb` — depending on the storefront file delivery
 *      they can land on a hash-only path served with the right MIME but
 *      no file extension. The previous strict `.glb$` check rejected
 *      those library-pick URLs and the metafield ended up with `[]` on
 *      every save, so the model "disappeared" after reload.
 */
export function isValid3dModelUrl(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (/\.(glb|gltf)$/i.test(u.pathname)) return true;
  // Shopify-served Model3d sources live under /3d/models/ on cdn.shopify.com
  // (and a couple of variants like shopifycdn.com). Accept those even
  // without an extension since the merchant didn't author the URL — it
  // came from a /api/files lookup of an existing Model3d node.
  const host = u.hostname.toLowerCase();
  if ((host === "cdn.shopify.com" || host.endsWith(".shopifycdn.com")) && /\/3d\/models\//i.test(u.pathname)) {
    return true;
  }
  return false;
}

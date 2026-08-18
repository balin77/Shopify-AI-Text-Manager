/**
 * Upload dates for product videos — the piece Liquid cannot know.
 *
 * `VideoObject` is emitted by the storefront block from the native
 * `product.media`, which carries everything Google needs EXCEPT `uploadDate`:
 * Liquid's media objects have no creation date, and `uploadDate` is one of
 * Google's four required properties for the video rich result. Guessing it
 * (product creation, "now") is exactly the fabrication `priceValidUntil` was
 * cured of, so the value has to come from a real source.
 *
 * The Admin API HAS it — `Video`/`ExternalVideo` implement `File`, which
 * carries `createdAt`. This module is how that date travels from the sync to
 * the storefront: the product sync selects it (PRODUCT_VIDEO_MEDIA_FIELDS),
 * this file turns it into a stable JSON map keyed by the media id, and the app
 * stores that map in a product metafield the Liquid block reads back.
 *
 * The key is the NUMERIC media id, not the GID: Liquid's `media.id` is the
 * number, so a map keyed by `gid://shopify/Video/123` could never be looked up
 * on the storefront.
 *
 * Pure and client-safe — the Shopify write lives in video-schema.server.ts.
 */

/** Where the map is stored. `custom` matches the app's other Liquid-read metafields. */
export const VIDEO_SCHEMA_NAMESPACE = "custom";
export const VIDEO_SCHEMA_KEY = "video_upload_dates";
/** `metafieldsSet` requires the type when creating without a definition. */
export const VIDEO_SCHEMA_TYPE = "json";

/**
 * The media sub-selection that makes video dates available, to be interpolated
 * into a product query's `media(...) { edges { node { … } } }`.
 *
 * Interpolated rather than copied because the product query exists FOUR times
 * (product-sync.service.ts twice, api.sync-products.tsx, api.sync-missing-
 * products.tsx) — see CLAUDE.md. Only paths with the FULL media window may
 * feed `videoUploadDatesFromMedia`: a narrower window (api.sync-missing-
 * products selects 20) cannot tell "no videos" from "outside the window", and
 * writing a truncated map would drop the uploadDate of a real video.
 */
export const PRODUCT_VIDEO_MEDIA_FIELDS = `... on Video {
                          id
                          createdAt
                        }
                        ... on ExternalVideo {
                          id
                          createdAt
                        }`;

/** Numeric id of a Shopify GID ("gid://shopify/Video/123" → "123"). */
export function numericMediaId(gid: string | null | undefined): string {
  const raw = (gid || "").trim();
  if (!raw) return "";
  const tail = raw.split("/").pop() || "";
  return /^\d+$/.test(tail) ? tail : "";
}

/** ISO date (YYYY-MM-DD) of a Shopify timestamp, or "" when unusable. */
export function isoDay(timestamp: string | null | undefined): string {
  const raw = (timestamp || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

export type VideoUploadDates = Record<string, string>;

interface MediaEdgeLike {
  node?: { id?: string | null; createdAt?: string | null } | null;
}

/**
 * Build the `{ mediaId: uploadDate }` map from a product's media edges.
 *
 * Returns `{}` for a product whose media carry no video — that is a REAL
 * answer ("this product has no videos"), and the caller uses it to clear a map
 * that is no longer true. A caller whose query did not select
 * PRODUCT_VIDEO_MEDIA_FIELDS must not call this at all: image-only nodes look
 * exactly like an unselected video fragment, and the two mean opposite things.
 */
export function videoUploadDatesFromMedia(
  edges: MediaEdgeLike[] | null | undefined,
): VideoUploadDates {
  const out: VideoUploadDates = {};
  for (const edge of edges ?? []) {
    const node = edge?.node;
    if (!node?.id || !node.createdAt) continue;
    const id = numericMediaId(node.id);
    const day = isoDay(node.createdAt);
    // A media node without a createdAt is an image (the fragment doesn't
    // select one) — silently skipped rather than stored as an empty date.
    if (!id || !day) continue;
    out[id] = day;
  }
  return out;
}

/**
 * Stable serialization: keys sorted, so an unchanged catalog always produces
 * the identical string and the diff below stays quiet. Returns null for an
 * empty map — "no videos" is expressed by REMOVING the metafield, never by
 * storing `{}` (and `metafieldsSet` rejects an empty value anyway).
 *
 * The JSON is assembled by hand rather than through `JSON.stringify(obj)`:
 * JavaScript reorders integer-like object keys into ascending NUMERIC order no
 * matter how they were inserted, so building a "sorted" object and stringifying
 * it silently produces a different order than the sort chose. Both are stable,
 * but only one of them is the order this function claims to produce — and the
 * mirror comparison downstream is a string comparison.
 */
export function serializeVideoUploadDates(map: VideoUploadDates): string | null {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return null;
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(map[key])}`);
  return `{${pairs.join(",")}}`;
}

/** True when the freshly built value differs from what we last wrote. */
export function videoSchemaChanged(
  storedJson: string | null | undefined,
  nextJson: string | null,
): boolean {
  return (storedJson ?? null) !== nextJson;
}

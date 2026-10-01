/**
 * "Images per language" for PRODUCTS — the Shopify half (PLAN_LOCALIZED_IMAGES
 * Phase 1b). Reads and writes the product's `custom.localized_media`
 * metafield; the shape and every rule about it live in
 * localized-media.shared.ts.
 *
 * Three rules this module owns:
 *  - A write counts only when Shopify ECHOES it: `metafieldsSet` must hand
 *    back this product's metafield carrying exactly the value sent
 *    (`userErrors: []` alone confirms nothing — CLAUDE.md). An emptied list is
 *    `metafieldsDelete`, because `metafieldsSet` rejects a blank value, and it
 *    counts only on the echoed owner.
 *  - Every write is READ-MODIFY-WRITE of the whole list, fresh from Shopify,
 *    never from a client copy: the client names ONE change and the server
 *    applies it to what is stored now. Two editors at the same moment: the
 *    later write wins (stated in the plan).
 *  - Nothing the storefront trusts comes from the client. The original's
 *    filename comes from the product's OWN media, the replacement's URL from
 *    a fresh read of the chosen file (READY, a MediaImage, on Shopify's CDN),
 *    the locale must be a non-primary shop locale and the market an active one.
 *
 * VIDEOS ride the same list (PLAN_LOCALIZED_IMAGES §7): a Shopify-hosted video
 * is replaced by another Shopify-hosted video (a Video file), a YouTube/Vimeo
 * video by another YouTube/Vimeo link — never across the two, because the
 * storefront swap rewrites addresses inside the element the theme rendered
 * (`<video>` sources, an `<iframe>` src) and cannot turn one into the other.
 *
 * `setLocalizedMedia` takes `origin` so stage 2 (the AI translating the text
 * inside an image) writes through this same function with `origin: "ai"`.
 */
import { METAFIELDS_DELETE, METAFIELDS_SET } from "~/graphql/content.mutations";
import { logger } from "~/utils/logger.server";
import { parseExternalVideoUrl } from "~/utils/mediaKind";
import {
  LOCALIZED_MEDIA_KEY,
  LOCALIZED_MEDIA_NAMESPACE,
  LOCALIZED_MEDIA_TYPE,
  MAX_LOCALIZED_MEDIA_ENTRIES,
  isSafeFilename,
  isShopifyCdnUrl,
  marketNumericId,
  normalizeLocale,
  isForeignLocalizedMediaValue,
  parseLocalizedMediaValue,
  removeLocalizedMediaEntry,
  serializeLocalizedMedia,
  storefrontFilename,
  upsertLocalizedMediaEntry,
  externalVideoKey,
  isSafeEmbedUrl,
  isSafeExternalThumbnail,
  videoKeyFromSources,
  isVideoMime,
  type LocalizedVideoSource,
  type LocalizedMediaEntry,
  type LocalizedMediaOrigin,
} from "./localized-media.shared";

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

export type ProductMediaKind = "image" | "video" | "external";

/**
 * One medium of the product as the card shows it and the write path checks
 * it. `key` is what the storefront matches on (an image's filename, a video's
 * hash directory, "<host>.<id>" for YouTube/Vimeo) and is NULL where it could
 * not be derived — such a medium is listed but cannot be replaced. `stamp` is
 * the value an entry's source stamp is compared with ("the original changed").
 */
export interface ProductMediaItem {
  id: string;
  kind: ProductMediaKind;
  /** Thumbnail to show: the image itself, or the video's preview image ("" = none). */
  url: string;
  alt: string | null;
  key: string | null;
  /** Filename of the poster the theme shows before a video plays ("" = none / not a video). */
  poster: string;
  stamp: string;
}

/** @deprecated kept for the image-only callers; every medium is a ProductMediaItem now. */
export type ProductMediaImage = ProductMediaItem;

export type LocalizedMediaErrorCode =
  | "notFound"
  | "readFailed"
  | "writeNotConfirmed"
  | "invalidLocale"
  | "invalidMarket"
  | "invalidSource"
  | "invalidFile"
  | "fileNotReady"
  | "sameFile"
  | "replacementIsOriginal"
  | "tooManyEntries"
  | "invalidExternalUrl"
  | "kindMismatch"
  | "foreignMetafieldValue";

export type LocalizedMediaResult<T> = ({ ok: true } & T) | { ok: false; code: LocalizedMediaErrorCode; message?: string };

// Prose stays out of the documents (CLAUDE.md: #graphql literals are sent verbatim).
const READ_PRODUCT = `#graphql
  query localizedMediaProduct($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      id
      metafield(namespace: $namespace, key: $key) { id value }
      media(first: 250) {
        nodes {
          id
          mediaContentType
          ... on MediaImage { alt image { url } }
          ... on Video { alt sources { url mimeType } preview { image { url } } }
          ... on ExternalVideo { alt originUrl preview { image { url } } }
        }
      }
    }
  }
`;

const READ_FILE = `#graphql
  query localizedMediaFile($id: ID!) {
    node(id: $id) {
      id
      ... on MediaImage { fileStatus image { url } }
      ... on Video { fileStatus sources { url mimeType } preview { image { url } } }
    }
  }
`;

async function gqlData<T>(graphql: Graphql, query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await graphql(query, { variables });
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch (error) {
    logger.warn("[localized-media] graphql failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

interface RawMediaNode {
  id: string;
  mediaContentType: string;
  alt?: string | null;
  image?: { url: string } | null;
  sources?: Array<{ url: string; mimeType: string }> | null;
  preview?: { image?: { url: string } | null } | null;
  originUrl?: string | null;
}

function safePoster(url: string | null | undefined): string {
  const name = storefrontFilename(url ?? "");
  return isSafeFilename(name) ? name : "";
}

/** Exported for tests: how a raw media node becomes what the card and the write path see. */
export function toProductMediaItem(n: RawMediaNode): ProductMediaItem | null {
  if (n.mediaContentType === "IMAGE") {
    if (!n.image?.url) return null;
    const name = storefrontFilename(n.image.url);
    return { id: n.id, kind: "image", url: n.image.url, alt: n.alt ?? null, key: isSafeFilename(name) ? name : null, poster: "", stamp: n.image.url };
  }
  if (n.mediaContentType === "VIDEO") {
    const sources = n.sources ?? [];
    const key = videoKeyFromSources(sources.map((src) => src.url));
    const preview = n.preview?.image?.url ?? "";
    // Stamped with the KEY, not a source URL: Shopify adds renditions after
    // processing and does not promise their order, so a URL stamp would report
    // "the original changed" about a video nobody touched.
    return { id: n.id, kind: "video", url: preview, alt: n.alt ?? null, key, poster: safePoster(preview), stamp: key ?? "" };
  }
  if (n.mediaContentType === "EXTERNAL_VIDEO") {
    const parsed = n.originUrl ? parseExternalVideoUrl(n.originUrl) : null;
    const key = parsed ? externalVideoKey(parsed.host, parsed.externalId) : null;
    const preview = n.preview?.image?.url ?? "";
    return { id: n.id, kind: "external", url: preview, alt: n.alt ?? null, key, poster: safePoster(preview), stamp: n.originUrl ?? "" };
  }
  return null;
}

export async function readProductLocalizedMedia(
  graphql: Graphql,
  productId: string,
): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaItem[]; hasMetafield: boolean; foreignValue: boolean }>> {
  const data = await gqlData<{
    product: {
      metafield: { id: string; value: string } | null;
      media: { nodes: RawMediaNode[] };
    } | null;
  }>(graphql, READ_PRODUCT, { id: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY });
  if (!data) return { ok: false, code: "readFailed" };
  if (!data.product) return { ok: false, code: "notFound" };
  const media = (data.product.media?.nodes ?? [])
    .map(toProductMediaItem)
    .filter((m): m is ProductMediaItem => m !== null);
  return {
    ok: true,
    entries: parseLocalizedMediaValue(data.product.metafield?.value ?? null),
    media,
    hasMetafield: !!data.product.metafield,
    foreignValue: isForeignLocalizedMediaValue(data.product.metafield?.value ?? null),
  };
}

/**
 * Writes the WHOLE list and confirms it by the echo. Empty ⇒ delete (only when
 * there is something to delete — a delete of nothing echoes nothing).
 */
export async function writeProductLocalizedMedia(
  graphql: Graphql,
  productId: string,
  entries: LocalizedMediaEntry[],
  hadMetafield: boolean,
): Promise<LocalizedMediaResult<object>> {
  if (entries.length > MAX_LOCALIZED_MEDIA_ENTRIES) return { ok: false, code: "tooManyEntries" };
  if (entries.length === 0) {
    if (!hadMetafield) return { ok: true };
    const data = await gqlData<{
      metafieldsDelete: { deletedMetafields: Array<{ ownerId: string; key: string; namespace: string } | null> | null; userErrors: { message: string }[] } | null;
    }>(graphql, METAFIELDS_DELETE, {
      metafields: [{ ownerId: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY }],
    });
    const confirmed = (data?.metafieldsDelete?.deletedMetafields ?? []).some(
      (d) => d?.ownerId === productId && d.key === LOCALIZED_MEDIA_KEY && d.namespace === LOCALIZED_MEDIA_NAMESPACE,
    );
    if (!confirmed) {
      logger.warn("[localized-media] delete not confirmed", { productId, userErrors: data?.metafieldsDelete?.userErrors });
      return { ok: false, code: "writeNotConfirmed", message: data?.metafieldsDelete?.userErrors?.[0]?.message };
    }
    return { ok: true };
  }

  const value = serializeLocalizedMedia(entries);
  const data = await gqlData<{
    metafieldsSet: {
      metafields: Array<{ key: string; namespace: string; value: string; owner: { id?: string } | null }> | null;
      userErrors: { message: string }[];
    } | null;
  }>(graphql, METAFIELDS_SET, {
    metafields: [{ ownerId: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY, type: LOCALIZED_MEDIA_TYPE, value }],
  });
  const echoed = (data?.metafieldsSet?.metafields ?? []).find(
    (mf) => mf.owner?.id === productId && mf.key === LOCALIZED_MEDIA_KEY && mf.namespace === LOCALIZED_MEDIA_NAMESPACE,
  );
  // Compared as parsed data: Shopify may re-serialise JSON (key order, spacing).
  const same = !!echoed && serializeLocalizedMedia(parseLocalizedMediaValue(echoed.value)) === serializeLocalizedMedia(parseLocalizedMediaValue(value));
  if (!same) {
    logger.warn("[localized-media] write not confirmed", { productId, userErrors: data?.metafieldsSet?.userErrors });
    return { ok: false, code: "writeNotConfirmed", message: data?.metafieldsSet?.userErrors?.[0]?.message };
  }
  return { ok: true };
}

export interface LocaleMarketScope {
  /** Every shop locale code with its primary flag. An EMPTY list means the lookup failed. */
  shopLocales: Array<{ locale: string; primary: boolean }>;
  /** Active markets (GIDs). */
  activeMarketIds: string[];
}

function validateScope(locale: string, marketId: string, scope: LocaleMarketScope): LocalizedMediaErrorCode | null {
  const foreign = scope.shopLocales.filter((l) => !l.primary).map((l) => normalizeLocale(l.locale));
  // An empty locale list is a FAILED lookup, never "one language": refuse
  // rather than write an entry for a locale nobody could confirm.
  if (scope.shopLocales.length === 0 || !foreign.includes(normalizeLocale(locale))) return "invalidLocale";
  if (marketId && !scope.activeMarketIds.includes(marketId)) return "invalidMarket";
  if (marketNumericId(marketId) === null) return "invalidMarket";
  return null;
}

type ReplacementResult = { ok: true; entry: Omit<LocalizedMediaEntry, "m" | "l" | "k" | "a" | "s" | "t" | "o"> } | { ok: false; code: LocalizedMediaErrorCode };

async function imageReplacement(graphql: Graphql, source: ProductMediaItem, media: ProductMediaItem[], fileId: string): Promise<ReplacementResult> {
  if (!/^gid:\/\/shopify\/MediaImage\/\d+$/.test(fileId)) return { ok: false, code: "kindMismatch" };
  const file = await gqlData<{ node: { id: string; fileStatus?: string; image?: { url: string } | null } | null }>(graphql, READ_FILE, { id: fileId });
  if (!file) return { ok: false, code: "readFailed" };
  if (!file.node) return { ok: false, code: "invalidFile" };
  if (file.node.fileStatus && file.node.fileStatus !== "READY") return { ok: false, code: "fileNotReady" };
  const url = file.node.image?.url;
  if (!url) return { ok: false, code: "fileNotReady" };
  const replacementName = storefrontFilename(url);
  if (!isShopifyCdnUrl(url) || !isSafeFilename(replacementName)) return { ok: false, code: "invalidFile" };
  // Same filename would make the storefront swap a no-op (and the pre-paint
  // hide would then fall to its fail-safe) — refuse it as the pointless edit it is.
  if (replacementName.toLowerCase() === source.key!.toLowerCase()) return { ok: false, code: "sameFile" };
  // A replacement that is itself one of this product's images would chain
  // (A→B while B→C shows C in the gallery but B in og:image) or cycle (A→B,
  // B→A). The storefront guards against the loop, but the only honest answer
  // is one level of replacement, so it is refused here.
  if (media.some((mm) => mm.kind === "image" && (mm.key ?? "").toLowerCase() === replacementName.toLowerCase())) {
    return { ok: false, code: "replacementIsOriginal" };
  }
  return { ok: true, entry: { u: url, f: fileId } };
}

async function videoReplacement(graphql: Graphql, source: ProductMediaItem, media: ProductMediaItem[], fileId: string): Promise<ReplacementResult> {
  if (!/^gid:\/\/shopify\/Video\/\d+$/.test(fileId)) return { ok: false, code: "kindMismatch" };
  const file = await gqlData<{
    node: { id: string; fileStatus?: string; sources?: Array<{ url: string; mimeType: string }> | null; preview?: { image?: { url: string } | null } | null } | null;
  }>(graphql, READ_FILE, { id: fileId });
  if (!file) return { ok: false, code: "readFailed" };
  if (!file.node) return { ok: false, code: "invalidFile" };
  if (file.node.fileStatus && file.node.fileStatus !== "READY") return { ok: false, code: "fileNotReady" };
  const sources: LocalizedVideoSource[] = (file.node.sources ?? [])
    .filter((src) => isShopifyCdnUrl(src.url) && isVideoMime(src.mimeType))
    .map((src) => ({ u: src.url, t: src.mimeType }));
  // The same MIME rule the parse applies: a source the next read would drop
  // must not be written either, or the echo check compares two lists that
  // both lost it and confirms a write the storefront then plays differently.
  if (sources.length === 0) return { ok: false, code: (file.node.sources ?? []).length ? "invalidFile" : "fileNotReady" };
  const key = videoKeyFromSources(sources.map((src) => src.u));
  if (!key) return { ok: false, code: "invalidFile" };
  if (key === source.key) return { ok: false, code: "sameFile" };
  if (media.some((mm) => mm.kind === "video" && mm.key === key)) return { ok: false, code: "replacementIsOriginal" };
  const poster = file.node.preview?.image?.url ?? "";
  return { ok: true, entry: { x: "v", u: isShopifyCdnUrl(poster) ? poster : "", f: fileId, p: source.poster, w: sources } };
}

function externalReplacement(source: ProductMediaItem, media: ProductMediaItem[], externalUrl: string): ReplacementResult {
  const parsed = parseExternalVideoUrl(externalUrl);
  const key = parsed ? externalVideoKey(parsed.host, parsed.externalId) : null;
  if (!parsed || !key || !isSafeEmbedUrl(parsed.embedUrl)) return { ok: false, code: "invalidExternalUrl" };
  if (key === source.key) return { ok: false, code: "sameFile" };
  if (media.some((mm) => mm.kind === "external" && mm.key === key)) return { ok: false, code: "replacementIsOriginal" };
  const thumb = parsed.thumbnailUrl && isSafeExternalThumbnail(parsed.thumbnailUrl) ? parsed.thumbnailUrl : "";
  return { ok: true, entry: { x: "e", u: thumb, f: "", p: source.poster, r: parsed.embedUrl } };
}

export async function setLocalizedMedia(args: {
  graphql: Graphql;
  productId: string;
  sourceMediaId: string;
  locale: string;
  marketId: string;
  /** A MediaImage GID (image original) or a Video GID (Shopify-video original). */
  fileId?: string;
  /** A YouTube/Vimeo link (external-video original). */
  externalUrl?: string;
  origin: LocalizedMediaOrigin;
  scope: LocaleMarketScope;
}): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaItem[] }>> {
  const { graphql, productId, sourceMediaId, locale, marketId, fileId = "", externalUrl = "", origin, scope } = args;
  const scopeError = validateScope(locale, marketId, scope);
  if (scopeError) return { ok: false, code: scopeError };

  const current = await readProductLocalizedMedia(graphql, productId);
  if (!current.ok) return current;
  // The metafield is in the merchant's namespace: a value that is not ours is
  // never overwritten (the write replaces the whole list).
  if (current.foreignValue) return { ok: false, code: "foreignMetafieldValue" };
  const source = current.media.find((m) => m.id === sourceMediaId);
  if (!source || !isSafeFilename(source.key)) return { ok: false, code: "invalidSource" };

  const replacement =
    source.kind === "image" ? await imageReplacement(graphql, source, current.media, fileId)
    : source.kind === "video" ? await videoReplacement(graphql, source, current.media, fileId)
    : externalReplacement(source, current.media, externalUrl);
  if (!replacement.ok) return { ok: false, code: replacement.code };

  const entry: LocalizedMediaEntry = {
    ...replacement.entry,
    o: source.key,
    m: sourceMediaId,
    l: normalizeLocale(locale),
    k: marketNumericId(marketId) ?? "",
    a: origin,
    s: source.stamp,
    t: new Date().toISOString(),
  };
  const next = upsertLocalizedMediaEntry(current.entries, entry);
  const written = await writeProductLocalizedMedia(graphql, productId, next, current.hasMetafield);
  if (!written.ok) return written;
  return { ok: true, entries: next, media: current.media };
}

/** The image-only name the first cut shipped with; same function. */
export const setLocalizedImage = setLocalizedMedia;

export async function removeLocalizedImage(args: {
  graphql: Graphql;
  productId: string;
  sourceMediaId: string;
  locale: string;
  marketId: string;
}): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaItem[] }>> {
  const { graphql, productId, sourceMediaId, locale, marketId } = args;
  const k = marketNumericId(marketId);
  if (k === null) return { ok: false, code: "invalidMarket" };
  const current = await readProductLocalizedMedia(graphql, productId);
  if (!current.ok) return current;
  if (current.foreignValue) return { ok: false, code: "foreignMetafieldValue" };
  // No scope validation on removal: an entry for a language the shop has
  // since removed (or an original that is gone) must still be deletable.
  const next = removeLocalizedMediaEntry(current.entries, sourceMediaId, locale, k);
  if (next.length === current.entries.length) return { ok: true, entries: current.entries, media: current.media };
  const written = await writeProductLocalizedMedia(graphql, productId, next, current.hasMetafield);
  if (!written.ok) return written;
  return { ok: true, entries: next, media: current.media };
}

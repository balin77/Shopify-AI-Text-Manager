/**
 * "Images per language" for PRODUCTS — the pure half (client-safe, import-free).
 * PLAN_LOCALIZED_IMAGES Phase 1b.
 *
 * Shopify cannot store a product image per language (a MediaImage translates
 * its `alt` and nothing else — measured), so the replacement lives in ONE
 * product metafield, `custom.localized_media` (json), and the storefront swaps
 * it in (extensions/storefront: blocks/localized-media.liquid +
 * assets/localized-media.js for the gallery, snippets/cp-localized-image.liquid
 * for og:image and the JSON-LD image list).
 *
 * That metafield is the ONE store. There is deliberately no DB mirror: the plan
 * cache cleanup may delete products from the local cache, and a mirror row
 * gone with them would show the merchant "no replacements" while the
 * storefront serves them. Every read is a live read of the metafield.
 *
 * Entry fields (short, because the storefront Liquid budget pays per byte of
 * code that reads them, not per byte of data):
 *   o  original's FILENAME as it appears in its CDN URL (URL-encoded form) —
 *      the storefront's match key: rendered <img> URLs, `product.images` and
 *      `product.media` all carry it, while their ids are different numbers
 *   m  original MediaImage GID — the app's identity of the original
 *   l  locale, LOWERCASE (Liquid compares `request.locale.iso_code | downcase`)
 *   k  market NUMERIC id (Liquid's `localization.market.id`), "" = every market
 *   u  replacement CDN URL (https://cdn.shopify.com/…)
 *   f  replacement file GID
 *   a  origin: "manual" | "ai" — stage 2 (AI image translation) writes "ai"
 *   s  source stamp: the original's URL when the entry was set; differs from
 *      the current URL ⇒ the original was replaced since ("check it")
 *   t  ISO timestamp of the write
 *
 * `o` and `u` land inside a CSS attribute selector and a JSON island on the
 * storefront, so both are VALIDATED before they are ever written
 * (`isSafeFilename`, `isShopifyCdnUrl`) — the Liquid side trusts them.
 */

export const LOCALIZED_MEDIA_NAMESPACE = "custom";
export const LOCALIZED_MEDIA_KEY = "localized_media";
export const LOCALIZED_MEDIA_TYPE = "json";
/**
 * Every entry of a product travels in its page's <head> (the storefront island),
 * so the cap is about page weight as much as sanity: 20 images × 5 languages ×
 * 2 market layers.
 */
export const MAX_LOCALIZED_MEDIA_ENTRIES = 200;

export type LocalizedMediaOrigin = "manual" | "ai";

/**
 * What an entry replaces. ABSENT means an image (every entry written before
 * videos existed reads as one). A replacement is always of the SAME kind as
 * its original, because the storefront swap rewrites ADDRESSES inside an
 * element the theme already rendered: an `<img>` stays an `<img>`, a
 * `<video>` gets other sources, an `<iframe>` another embed address. Turning
 * one element into another would mean rebuilding the theme's own markup.
 *   "v"  a Shopify-hosted video: `o` is the video KEY (the hash directory of
 *        its CDN sources, `videoKeyFromUrl`), `w` the replacement's sources,
 *        `u` the replacement's poster ("" = none), `f` its Video GID
 *   "e"  a YouTube/Vimeo video: `o` is "<host>.<id>" (`externalVideoKey`),
 *        `r` the replacement's embed address, `u` its thumbnail ("" for
 *        Vimeo, which publishes none without an API call), `f` ""
 * Both carry `p`, the ORIGINAL's poster filename ("" = unknown), so the poster
 * image the theme shows before playback is swapped with the video.
 */
export type LocalizedMediaKind = "v" | "e";

export interface LocalizedVideoSource {
  /** Source URL on Shopify's CDN. */
  u: string;
  /** MIME type as Shopify reports it (video/mp4, application/x-mpegURL, …). */
  t: string;
}

export interface LocalizedMediaEntry {
  o: string;
  m: string;
  l: string;
  k: string;
  u: string;
  f: string;
  a: LocalizedMediaOrigin;
  s: string;
  t: string;
  x?: LocalizedMediaKind;
  p?: string;
  w?: LocalizedVideoSource[];
  r?: string;
}

const VIDEO_KEY = /\/videos\/c\/(?:vp|o\/v)\/([A-Za-z0-9]{8,64})/;

/**
 * The stable part of a Shopify-hosted video's URL: the hash directory every
 * rendition (HLS, each mp4 size) and the original share. NOT measured on a
 * live storefront — read off the Admin API's `Video.sources` shape
 * (`/videos/c/vp/<hash>/<hash>.HD-1080p….mp4`, `/videos/c/o/v/<hash>.mp4`);
 * an original whose sources carry no such segment is REFUSED rather than
 * guessed, so a wrong assumption costs a refusal, never a wrong swap.
 */
export function videoKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = VIDEO_KEY.exec(url.split("?")[0]);
  return m ? m[1] : null;
}

/** "youtube.<id>" / "vimeo.<id>" — the storefront's key for an external video. */
export function externalVideoKey(host: string, id: string): string | null {
  if (host === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(id)) return `youtube.${id}`;
  if (host === "vimeo" && /^\d{6,12}$/.test(id)) return `vimeo.${id}`;
  return null;
}

const VIDEO_MIME = /^(video\/[a-z0-9.+-]+|application\/x-mpegurl|application\/vnd\.apple\.mpegurl)$/i;

/** The only two embed shapes the storefront swap writes into an iframe. */
export function isSafeEmbedUrl(url: unknown): url is string {
  return typeof url === "string" && (
    /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(url) ||
    /^https:\/\/player\.vimeo\.com\/video\/\d{6,12}$/.test(url)
  );
}

/** A poster for an external replacement: YouTube's own thumbnail host only. */
export function isSafeExternalThumbnail(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/img\.youtube\.com\/vi\/[A-Za-z0-9_-]{11}\/hqdefault\.jpg$/.test(url);
}

const SAFE_FILENAME = /^[A-Za-z0-9._~%+-]{1,255}$/;

/** A filename that is safe inside `img[src*="/<name>"]` and a JSON string. */
export function isSafeFilename(name: unknown): name is string {
  return typeof name === "string" && SAFE_FILENAME.test(name) && name !== "." && name !== "..";
}

/** Only Shopify's own file CDN — the only host the admin API hands back for Files. */
export function isShopifyCdnUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  if (/["'<>\s\\]/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "cdn.shopify.com";
  } catch {
    return false;
  }
}

/**
 * The filename of a Shopify image URL in the form a rendered `<img>` carries
 * (still URL-encoded). Null for anything without a usable last segment.
 */
export function storefrontFilename(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.split("#")[0].split("?")[0];
  const last = path.split("/").pop() ?? "";
  return last || null;
}

/** "gid://shopify/Market/123" → "123"; "" → "" (every market); junk → null. */
export function marketNumericId(marketId: string | null | undefined): string | null {
  if (!marketId) return "";
  const m = /^gid:\/\/shopify\/Market\/(\d+)$/.exec(marketId);
  return m ? m[1] : null;
}

export function normalizeLocale(locale: string): string {
  return locale.trim().toLowerCase();
}

/**
 * Parses the stored metafield value. Tolerant in ONE direction only: an entry
 * that does not carry every field in the right shape is dropped, so a hand
 * edit in the Shopify admin cannot make the app write garbage back — and the
 * write path always writes the whole list, so a dropped entry is dropped from
 * the storefront too (it was not usable there either).
 */
export function parseLocalizedMediaValue(raw: unknown): LocalizedMediaEntry[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = (data as { e?: unknown } | null)?.e;
  if (!Array.isArray(list)) return [];
  const out: LocalizedMediaEntry[] = [];
  for (const item of list) {
    const e = item as Partial<LocalizedMediaEntry> | null;
    if (!e || typeof e !== "object") continue;
    if (!isSafeFilename(e.o) || typeof e.m !== "string" || !e.m) continue;
    if (typeof e.l !== "string" || !e.l || typeof e.k !== "string") continue;
    if (typeof e.f !== "string") continue;
    const base: LocalizedMediaEntry = {
      o: e.o,
      m: e.m,
      l: normalizeLocale(e.l),
      k: e.k,
      u: typeof e.u === "string" ? e.u : "",
      f: e.f,
      a: e.a === "ai" ? "ai" : "manual",
      s: typeof e.s === "string" ? e.s : "",
      t: typeof e.t === "string" ? e.t : "",
    };
    const poster = e.p === undefined || e.p === "" || isSafeFilename(e.p) ? (e.p ?? "") : null;
    if (e.x === undefined) {
      if (!isShopifyCdnUrl(base.u)) continue;
      out.push(base);
    } else if (e.x === "v") {
      const sources = Array.isArray(e.w)
        ? e.w.filter((s): s is LocalizedVideoSource => !!s && isShopifyCdnUrl(s.u) && typeof s.t === "string" && VIDEO_MIME.test(s.t))
        : [];
      if (poster === null || sources.length === 0) continue;
      if (base.u !== "" && !isShopifyCdnUrl(base.u)) continue;
      out.push({ ...base, x: "v", p: poster, w: sources });
    } else if (e.x === "e") {
      if (poster === null || !isSafeEmbedUrl(e.r)) continue;
      if (base.u !== "" && !isSafeExternalThumbnail(base.u)) continue;
      out.push({ ...base, x: "e", p: poster, r: e.r });
    }
  }
  return out;
}

export function serializeLocalizedMedia(entries: LocalizedMediaEntry[]): string {
  return JSON.stringify({ v: 1, e: entries });
}

function sameSlot(e: LocalizedMediaEntry, m: string, l: string, k: string): boolean {
  return e.m === m && e.l === normalizeLocale(l) && e.k === k;
}

/** Replaces the entry for the same (original, locale, market), or appends. 1:1 by construction. */
export function upsertLocalizedMediaEntry(entries: LocalizedMediaEntry[], entry: LocalizedMediaEntry): LocalizedMediaEntry[] {
  const rest = entries.filter((e) => !sameSlot(e, entry.m, entry.l, entry.k));
  return [...rest, { ...entry, l: normalizeLocale(entry.l) }];
}

export function removeLocalizedMediaEntry(entries: LocalizedMediaEntry[], m: string, l: string, k: string): LocalizedMediaEntry[] {
  return entries.filter((e) => !sameSlot(e, m, l, k));
}

/**
 * Which replacement a visitor in (locale, market) sees for an original — the
 * SAME precedence the storefront applies: this market's entry beats the
 * every-market one; none ⇒ the original. `inherited` marks the every-market
 * answer seen from a specific market, so the editor can say where it came from.
 */
export function resolveLocalizedMedia(
  entries: LocalizedMediaEntry[],
  m: string,
  locale: string,
  marketNumeric: string,
): { entry: LocalizedMediaEntry; inherited: boolean } | null {
  const l = normalizeLocale(locale);
  if (marketNumeric) {
    const own = entries.find((e) => e.m === m && e.l === l && e.k === marketNumeric);
    if (own) return { entry: own, inherited: false };
  }
  const all = entries.find((e) => e.m === m && e.l === l && e.k === "");
  return all ? { entry: all, inherited: marketNumeric !== "" } : null;
}

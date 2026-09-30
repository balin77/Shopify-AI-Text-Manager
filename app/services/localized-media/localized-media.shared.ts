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
    if (!isShopifyCdnUrl(e.u) || typeof e.f !== "string") continue;
    out.push({
      o: e.o,
      m: e.m,
      l: normalizeLocale(e.l),
      k: e.k,
      u: e.u,
      f: e.f,
      a: e.a === "ai" ? "ai" : "manual",
      s: typeof e.s === "string" ? e.s : "",
      t: typeof e.t === "string" ? e.t : "",
    });
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

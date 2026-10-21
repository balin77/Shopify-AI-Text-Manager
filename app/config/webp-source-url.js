/**
 * Which URLs the WebP conversion may DOWNLOAD — one rule for the route that
 * queues a conversion and the worker that performs it.
 *
 * Plain JS with no imports, because both sides of the graph read it: the
 * route (`app/routes/api.convert-webp.tsx`, inside the React Router bundle)
 * and the worker (`webp-processor.service.js`, a root module outside it — the
 * same arrangement as `webp-tasks.js` beside it; the Dockerfile copies
 * `app/config`).
 *
 * Why it exists: the job input's `sourceUrl` comes from the client, and the
 * worker fetched it with a plain `fetch` that followed redirects. Any
 * authenticated shop could make the server fetch an internal address
 * (`*.railway.internal`, localhost, a cloud metadata endpoint) and read the
 * answer back as an "image" uploaded into its own product, or in the error
 * text of its task. A product image the app converts always lives on the
 * Shopify CDN, so that is the whole allowlist — the same hosts
 * `AIService.validateImageUrl` accepts for the same reason.
 *
 * The host check is an EXACT match, so an IP literal, a look-alike suffix
 * (`cdn.shopify.com.evil.example`) or a subdomain never passes; userinfo and an
 * explicit port are refused as well, since no CDN URL carries either.
 */

/** Hosts a conversion source may be downloaded from (exact match). */
export const WEBP_SOURCE_HOSTS = Object.freeze(["cdn.shopify.com", "cdn.shopifycdn.net"]);

/** Longest URL accepted — a CDN url is far shorter; this only bounds abuse. */
export const WEBP_SOURCE_URL_MAX_LENGTH = 2048;

/**
 * Parse `url` and answer whether the conversion may download it.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedWebpSourceUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > WEBP_SOURCE_URL_MAX_LENGTH) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port) return false;
  return WEBP_SOURCE_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * The host of a URL for an error message, never the URL itself: a refused
 * address may be an internal one, and the message lands in `Task.error`,
 * which the merchant's Tasks page renders.
 * @param {unknown} url
 * @returns {string}
 */
export function webpSourceHostForMessage(url) {
  try {
    return new URL(String(url)).hostname || "(no host)";
  } catch {
    return "(invalid url)";
  }
}

/**
 * Access-log URL hygiene for server.js's morgan line.
 *
 * `morgan("tiny")` prints the FULL request URL. Shopify packs credentials into
 * the query string of every embedded-app document request: `id_token` is a
 * session JWT (valid for about a minute, enough to act as the shop's user),
 * `hmac` and `session` sign the launch. They would sit in Railway's log
 * retention, in any log drain and in screenshots of either.
 *
 * The path and the NAMES of the parameters stay (they are what makes the line
 * useful for debugging: `shop`, `host`, `embedded`, `locale`); only the VALUE of
 * a sensitive parameter is replaced. A malformed query is handled as text, never
 * parsed with `URL`, so a hostile request cannot make the logger throw.
 *
 * Plain CommonJS and no imports on purpose: server.js loads it with `require`,
 * so the import order of the Sentry/adapter boot sequence is not touched.
 */

const SENSITIVE_PARAMS = new Set([
  "id_token",
  "hmac",
  "session",
  "token",
  "code",
  "state",
  "signature",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  // URL-VALUED params: the library's session-token bounce puts the WHOLE
  // original request in `shopify-reload` (url-encoded, so its `hmac`, `session`
  // and `id_token` are invisible to a top-level name check). The value goes as
  // one piece.
  "shopify-reload",
  "exitiframe",
  "return_to",
  "redirect_uri",
  "redirect_to",
]);

function decodeName(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** `/app?shop=x&id_token=eyJ…` -> `/app?shop=x&id_token=[redacted]` */
function redactUrl(url) {
  if (typeof url !== "string") return url;
  const hash = url.indexOf("#");
  const noHash = hash === -1 ? url : url.slice(0, hash);
  const q = noHash.indexOf("?");
  if (q === -1) return noHash;
  const path = noHash.slice(0, q);
  const query = noHash
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      if (!SENSITIVE_PARAMS.has(decodeName(name).toLowerCase())) return pair;
      return eq === -1 ? pair : `${name}=[redacted]`;
    })
    .join("&");
  return `${path}?${query}`;
}

/** morgan token function: `morgan.token("safe-url", safeUrlToken)`. */
function safeUrlToken(req) {
  return redactUrl(req.originalUrl || req.url);
}

/** morgan's "tiny" format with `:url` swapped for the redacted token. */
const ACCESS_LOG_FORMAT = ":method :safe-url :status :res[content-length] - :response-time ms";

module.exports = { redactUrl, safeUrlToken, ACCESS_LOG_FORMAT, SENSITIVE_PARAMS };

/**
 * Shared Sentry scrubbing + gate logic.
 *
 * Plain CommonJS (zero deps) ON PURPOSE: server.js (pre-build, require()) and
 * the TypeScript app code (sentry.server.ts / sentry.client.ts, import) must
 * use the EXACT SAME redaction. Duplicating it caused the review findings
 * B1/B2/R2/H2 — one module removes the drift and closes the startup window
 * where server.js sent unscrubbed events.
 *
 * Mirrors the "NIEMALS loggen" list from docs/LOGGING_GUIDE.md and additionally
 * strips Shopify embedded-app session material (id_token JWT, hmac, session,
 * shop) that @sentry/node's RequestData integration would otherwise attach via
 * event.request.url / query_string.
 */

// Keys whose values must never leave the server (case-insensitive substring).
const SENSITIVE_KEY =
  /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key|x-shopify|access[-_]?token|refresh[-_]?token|encryption|bearer|signature|hmac|\bjwt\b|id[-_]?token|session|email)/i;

// Value-level redaction — catches secrets that sit in free-text (error
// messages, response bodies, URLs) where there is no sensitive *key* to match.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SHOPIFY_TOKEN_RE = /\bshp(at|ca|ss|pa)_[A-Za-z0-9]+/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;
// Credentials embedded in a URI, e.g. postgres://user:pass@host (Prisma error
// messages leak the DATABASE_URL with the password — review B1).
const URI_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^:@\s/]+:[^@\s/]+@/gi;

function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  return input
    .replace(URI_CREDENTIALS_RE, '$1[redacted]@')
    .replace(JWT_RE, '[redacted-jwt]')
    .replace(SHOPIFY_TOKEN_RE, '[redacted-token]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(EMAIL_RE, '[redacted-email]');
}

/** Drop the query string + fragment from a URL — Shopify packs id_token/hmac there. */
function stripUrl(url) {
  if (typeof url !== 'string') return url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut) + '?[redacted]';
}

function scrubValue(value, depth) {
  depth = depth || 0;
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubValue(value[k], depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Scrub a Sentry breadcrumb. Console breadcrumbs are dropped entirely (server
 * console.* often carries connection strings / Shopify payloads and is pure
 * noise for the free tier anyway). URL-bearing breadcrumbs get their query
 * string stripped. Returns null to drop the breadcrumb.
 */
function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb) return breadcrumb;
  if (breadcrumb.category === 'console') return null;
  if (breadcrumb.data) {
    const d = breadcrumb.data;
    if (typeof d.url === 'string') d.url = stripUrl(d.url);
    if (typeof d.to === 'string') d.to = stripUrl(d.to);
    if (typeof d.from === 'string') d.from = stripUrl(d.from);
    breadcrumb.data = scrubValue(d);
  }
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactString(breadcrumb.message);
  }
  return breadcrumb;
}

/**
 * The single beforeSend body. Covers everything the key-based scrub missed in
 * the review (B1): request.url/query_string, exception values, message, and
 * any user PII that slipped past sendDefaultPii:false.
 */
function scrubEvent(event) {
  if (!event) return event;

  if (event.request) {
    const r = event.request;
    if (typeof r.url === 'string') r.url = stripUrl(r.url);
    if (r.query_string) r.query_string = '[redacted]';
    if (r.cookies) r.cookies = '[redacted]';
    if (r.headers) r.headers = scrubValue(r.headers);
    if (r.data) r.data = scrubValue(r.data);
  }

  if (typeof event.message === 'string') event.message = redactString(event.message);

  if (event.exception && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (ex && typeof ex.value === 'string') ex.value = redactString(ex.value);
    }
  }

  if (event.contexts) event.contexts = scrubValue(event.contexts);
  if (event.extra) event.extra = scrubValue(event.extra);
  if (event.tags) event.tags = scrubValue(event.tags);

  if (event.user) {
    delete event.user.email;
    delete event.user.ip_address;
    delete event.user.username;
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((b) => b != null);
  }

  return event;
}

/**
 * The single hard gate. Sentry is active ONLY in real production. Re-used by
 * server.js and the app modules so the rule cannot drift (review H2).
 */
function sentryEnabled() {
  return process.env.APP_ENV === 'production' && !!process.env.SENTRY_DSN;
}

module.exports = {
  redactString,
  stripUrl,
  scrubValue,
  scrubBreadcrumb,
  scrubEvent,
  sentryEnabled,
};

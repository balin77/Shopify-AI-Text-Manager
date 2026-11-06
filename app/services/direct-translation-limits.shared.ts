// Request caps for the direct-translation storefront proxy routes.
//
// Import-free on purpose: route files must not export non-route values that
// pull a `.server` module into the client bundle (React Router keeps every
// non-loader/action export of a route in the client build), so the caps live
// here and both the routes, `direct-translation.server.ts` and the tests read
// them from this one place.

/** Max candidate strings accepted per collect request (defense against abuse). */
export const MAX_CANDIDATES_PER_REQUEST = 100;

/** Longest candidate the storefront collector reports (`isCollectible` in direct-translation.js). */
export const MAX_RAW_CANDIDATE_CHARS = 1500;

/**
 * Hard cap on the collect-strings request body, enforced BEFORE it is parsed —
 * the route is reachable by any storefront visitor. Derived from what a
 * legitimate beacon can carry: MAX_CANDIDATES_PER_REQUEST candidates of up to
 * 1500 characters (the collector's own `isCollectible` limit) at up to 4 UTF-8
 * bytes each, plus per-item JSON framing and the locale. The storefront script
 * sends at most 50 items, so this leaves a 2x margin over a real payload.
 */
export const MAX_COLLECT_STRINGS_BODY_BYTES =
  MAX_CANDIDATES_PER_REQUEST * (MAX_RAW_CANDIDATE_CHARS * 4 + 64) + 4096;

/**
 * Hard cap on the direct-add request body, enforced BEFORE it is parsed. The
 * route is reachable by any storefront visitor and the token check needs the
 * parsed body, so without a cap an anonymous caller could make the server
 * buffer an arbitrarily large body. Derived from the field caps rather than a
 * round number: 1500 + 5000 characters at up to 4 UTF-8 bytes each (a Japanese
 * or emoji translation is 3-4 bytes per character) plus JSON framing and the
 * token. 16 KB would refuse a legitimate long CJK translation.
 */
export const MAX_DIRECT_ADD_BODY_BYTES = 32 * 1024;

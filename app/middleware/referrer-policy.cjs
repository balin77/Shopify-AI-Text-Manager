/**
 * Referrer-Policy per path (plain CJS so server.js can require it).
 *
 * /admin (the operator page, plus its data requests /admin.data) sends
 * `same-origin` only (not no-referrer: that makes browsers send `Origin: null` on a
 * native form POST, which the strict admin origin check refuses). server.js used to set strict-origin-when-cross-origin for
 * every response, and the React Router response then carried its own
 * `same-origin` for /admin, so the browser saw TWO Referrer-Policy headers.
 * Everything else (/app, the website) keeps the embedded-app value.
 * Matching mirrors isAdminPath in admin-auth.server.ts (case-insensitive,
 * trailing slashes ignored).
 */
const APP_REFERRER_POLICY = "strict-origin-when-cross-origin";

function isAdminRequestPath(pathname) {
  const p = String(pathname || "").toLowerCase().replace(/\/+$/, "");
  return p === "/admin" || p === "/admin.data";
}

/** The policy server.js sets itself, or null when the route sets its own. */
function serverReferrerPolicy(pathname) {
  return isAdminRequestPath(pathname) ? null : APP_REFERRER_POLICY;
}

module.exports = { serverReferrerPolicy, isAdminRequestPath, APP_REFERRER_POLICY };

// Content PAGE routes whose form posts (save, copy, translate) the content
// rate limiter covers. Lives in its own CommonJS module so server.js can
// require it and a unit test can exercise the matching. Mirrors
// CONTENT_EDITOR_ACTION_PAGES in app/services/editor/content-action-endpoint.shared.ts
// plus the pages that post their own forms (/app/menus, the bulk editor); a
// unit test fails when the two lists drift. Matched exactly or as a prefix on
// a path segment, never with `includes`.
const CONTENT_PAGE_PATHS = [
  '/app/products',
  '/app/collections',
  '/app/pages',
  '/app/blog',
  '/app/policies',
  '/app/metaobjects',
  '/app/cookie-banner',
  '/app/templates',
  '/app/delivery',
  '/app/selling-plans',
  '/app/system',
  '/app/online-store-extras',
  '/app/shop-metadata',
  '/app/theme-app-embeds',
  '/app/theme-section-groups',
  '/app/theme-settings',
  '/app/theme-standard',
  '/app/theme-static-sections',
  '/app/menus',
  '/app/bulk',
  '/app/content',
];

// React Router's single fetch posts a page action to `<path>.data`.
function isContentPagePath(reqPath) {
  let p = reqPath.endsWith('.data') ? reqPath.slice(0, -'.data'.length) : reqPath;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return CONTENT_PAGE_PATHS.some((base) => p === base || p.startsWith(base + '/'));
}

module.exports = { CONTENT_PAGE_PATHS, isContentPagePath };

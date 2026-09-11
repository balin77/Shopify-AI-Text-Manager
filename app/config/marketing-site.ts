/**
 * Facts about the public website that are not copy and not layout.
 *
 * One place, because three of them appear on several pages and one of them
 * (`SUPPORT_EMAIL`) is also published by `/privacy` — two spellings of a
 * support address is how a merchant ends up writing to a mailbox nobody reads.
 */

export const MARKETING_SITE = {
  /** Matches `companyName` in app/routes/privacy.tsx. */
  companyName: "Gubler - Multimedia und Print",
  appName: "ContentPilot AI",
  supportEmail: "gublerra@gmail.com",
  /**
   * The embedded app's own path. The site does NOT link to it — `/app` only
   * works from inside the Shopify admin — but the landing route still
   * redirects a Shopify-initiated request there, which is what keeps the
   * install flow working.
   */
  appPath: "/app",
  /**
   * The App Store listing — the canonical way to install a public app, and
   * therefore where every install button on this site goes. `/install` (the
   * app's own OAuth form) redirects here too; it stays in the tree as the
   * fallback for `null`, which is why the annotation is kept rather than let
   * TypeScript narrow this to a string literal.
   *
   * Deliberately BARE. The URL this was taken from carried `locale=de` plus a
   * `search_id` and three `surface_*` parameters — Shopify's attribution for
   * ONE merchant's search session, wrong for every other visitor. And the
   * locale is not ours to force: the App Store already renders in the
   * merchant's own account language, which is a better answer than the
   * language someone happened to pick on this site.
   */
  appStoreUrl: "https://apps.shopify.com/contentpilot-ai" as string | null,
} as const;

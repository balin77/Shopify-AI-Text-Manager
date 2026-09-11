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
   * The App Store listing, once it exists. While it is `null` every install
   * button points at this app's own `/install` form instead, which starts the
   * same OAuth flow — so the button is never a dead link to a listing that has
   * not been published yet. Setting it here switches every one of them over.
   */
  appStoreUrl: null as string | null,
} as const;

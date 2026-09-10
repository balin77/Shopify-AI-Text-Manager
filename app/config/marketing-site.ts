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
  /** Where "Open the app" goes. Inside the Shopify admin this is the app itself. */
  appPath: "/app",
  /**
   * The App Store listing, once it exists. `null` renders the install button as
   * the plain "open the app" link instead of a dead one — a button that goes
   * nowhere is worse than a button that is not there.
   */
  appStoreUrl: null as string | null,
} as const;

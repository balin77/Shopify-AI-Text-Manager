/**
 * Cookie-Banner rubric (Plan §7.5) — part of "Online Store", entitled on every
 * tier (same gate as onlineStoreExtras).
 *
 * Thin wrapper over the shared ThemeContent machinery: loader, route action and
 * page UI are identical to the other ThemeContent-backed rubrics (Templates,
 * System, OnlineStoreExtras, Selling-Plans), just with domain="customer_privacy".
 *
 * Why "customer_privacy" instead of "cookie_banner"? Brave Shields and the
 * EasyPrivacy filter list block any URL containing the substring
 * "cookie_banner" — the API call to /api/theme-content/cookie_banner/... was
 * silently dropped with net::ERR_BLOCKED_BY_CLIENT (blocked:other). Renaming
 * the data path to Shopify's own term ("Customer Privacy API") clears the
 * filter without changing user-facing labels or code-level identifiers.
 *
 * The unstable-API quirk (COOKIE_BANNER lives only in Shopify's `unstable`
 * TranslatableResourceType enum today) is contained entirely in the sync layer
 * (BackgroundSyncService.syncCookieBanner) — once content is in our themeContent
 * table the editor reads from there, identical to every other rubric. Saves go
 * through translationsRegister on the pinned stable API: the mutation is
 * resource-agnostic and accepts COOKIE_BANNER GIDs even though the matching
 * query enum is unstable. If the sync probe finds the resource unreachable on
 * this shop, the loader simply returns an empty group list and the editor
 * renders its standard empty state — no "Coming Soon" branch needed.
 */

import { useLoaderData } from "@remix-run/react";
import { COOKIE_BANNER_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("customer_privacy", "COOKIE_BANNER");
export const action = makeThemeContentRouteAction("customer_privacy");

export default function CookieBannerPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={COOKIE_BANNER_CONFIG}
      apiBasePath="/api/theme-content/customer_privacy"
      planContentType="onlineStoreExtras"
    />
  );
}

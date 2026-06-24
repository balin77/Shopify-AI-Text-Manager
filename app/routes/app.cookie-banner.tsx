/**
 * Cookie-Banner rubric (Plan §7.5) — part of "Online Store", entitled on every
 * tier (same gate as onlineStoreExtras).
 *
 * Thin wrapper over the shared ThemeContent machinery: loader, route action and
 * page UI are identical to the other ThemeContent-backed rubrics (Templates,
 * System, OnlineStoreExtras, Selling-Plans), just with domain="cookie_banner".
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

export const loader = makeThemeDomainLoader("cookie_banner", "COOKIE_BANNER");
export const action = makeThemeContentRouteAction("cookie_banner");

export default function CookieBannerPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={COOKIE_BANNER_CONFIG}
      apiBasePath="/api/theme-content/cookie_banner"
      planContentType="onlineStoreExtras"
    />
  );
}

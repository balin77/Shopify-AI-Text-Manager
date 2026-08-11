/**
 * Filter rubric — storefront filter labels. ThemeContent domain
 * "online_store_extras", restricted to the FILTER resource type. Shop-Metadaten
 * (SHOP resource type) lives in its own tab at app.shop-metadata.tsx but shares
 * this same domain + API.
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "react-router";
import { ONLINE_STORE_EXTRAS_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("online_store_extras", "ONLINE_STORE_EXTRAS", ["FILTER"]);
export const action = makeThemeContentRouteAction("online_store_extras");

export default function OnlineStoreExtrasPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={ONLINE_STORE_EXTRAS_CONFIG}
      apiBasePath="/api/theme-content/online_store_extras"
      planContentType="onlineStoreExtras"
    />
  );
}

/**
 * Online-Store-Extras rubric — Filter, Shop-Metadaten (and, where available,
 * Cookie-Banner). ThemeContent domain="online_store_extras".
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "@remix-run/react";
import { ONLINE_STORE_EXTRAS_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("online_store_extras", "ONLINE_STORE_EXTRAS");
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

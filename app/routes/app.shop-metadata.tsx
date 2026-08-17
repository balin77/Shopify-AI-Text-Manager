/**
 * Shop-Metadaten rubric — shop SEO metafields. ThemeContent domain
 * "online_store_extras", restricted to the SHOP resource type. Shares the same
 * domain, action and API as the Filter tab (app.online-store-extras.tsx); only
 * the loaded resource type differs.
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "react-router";
import { SHOP_METADATA_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("online_store_extras", "SHOP_METADATA", ["SHOP"]);
export const action = makeThemeContentRouteAction("online_store_extras");

export default function ShopMetadataPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={SHOP_METADATA_CONFIG}
      apiBasePath="/api/theme-content/online_store_extras"
      planContentType="onlineStoreExtras"
    />
  );
}

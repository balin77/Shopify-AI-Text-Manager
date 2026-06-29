/**
 * Delivery rubric — Versand & Zustellung (DELIVERY_METHOD_DEFINITION). Split out
 * of the System rubric so it can carry a lower (Basic+) entitlement: shipping
 * method names are checkout-facing and matter for a usable localized checkout.
 * ThemeContent domain="delivery".
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "@remix-run/react";
import { Banner } from "@shopify/polaris";
import { DELIVERY_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { useI18n } from "../contexts/I18nContext";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("delivery", "DELIVERY");
export const action = makeThemeContentRouteAction("delivery");

export default function DeliveryPage() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  return (
    <ThemeContentDomainPage
      data={data}
      config={DELIVERY_CONFIG}
      apiBasePath="/api/theme-content/delivery"
      planContentType="delivery"
      infoBanner={
        <Banner tone="info" title={t.content?.deliveryPackingSlipNoticeTitle || "Packing slip template"}>
          {t.content?.deliveryPackingSlipNotice ||
            'You can translate the packing slip template under "Notifications".'}
        </Banner>
      }
    />
  );
}

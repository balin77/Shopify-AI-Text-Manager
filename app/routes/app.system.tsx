/**
 * System rubric — Benachrichtigungen, Versand & Zustellung, Zahlung,
 * Lieferschein (EMAIL_TEMPLATE, DELIVERY_METHOD_DEFINITION, PAYMENT_GATEWAY,
 * PACKING_SLIP_TEMPLATE). ThemeContent domain="system".
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "@remix-run/react";
import { SYSTEM_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("system", "SYSTEM");
export const action = makeThemeContentRouteAction("system");

export default function SystemPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={SYSTEM_CONFIG}
      apiBasePath="/api/theme-content/system"
      planContentType="system"
    />
  );
}

/**
 * System rubric (Pro+) — Benachrichtigungen, Zahlung, Lieferschein
 * (EMAIL_TEMPLATE, PAYMENT_GATEWAY, PACKING_SLIP_TEMPLATE). ThemeContent
 * domain="system". Versand & Zustellung lives in its own Basic+ rubric
 * (app.delivery, domain="delivery").
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

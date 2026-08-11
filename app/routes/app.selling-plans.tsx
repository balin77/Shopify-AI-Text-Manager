/**
 * Selling-Plans rubric — Abo-Pläne & Abo-Gruppen (SELLING_PLAN,
 * SELLING_PLAN_GROUP). ThemeContent domain="selling_plans". Conditional: the
 * loader returns an empty group list on shops without subscriptions, so the
 * nav entry (Phase 3) can hide itself.
 *
 * Thin wrapper over the shared ThemeContent domain factories + page.
 */

import { useLoaderData } from "react-router";
import { SELLING_PLANS_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("selling_plans", "SELLING_PLANS");
export const action = makeThemeContentRouteAction("selling_plans");

export default function SellingPlansPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={SELLING_PLANS_CONFIG}
      apiBasePath="/api/theme-content/selling_plans"
      planContentType="sellingPlans"
    />
  );
}

/**
 * Theme rubric → "Vorlagen" tab (ONLINE_STORE_THEME_JSON_TEMPLATE).
 *
 * One of six Theme sub-tabs that all share the ThemeContent domain="theme" but
 * scope to a single Shopify resource type so each maps to a Translate & Adapt
 * category. The path stays /app/templates for backward compatibility; the tab
 * now shows only JSON templates rather than all theme content.
 *
 * Thin wrapper over the shared ThemeContent domain factories + page; the
 * resource-type scope is passed to the loader (nav), the route action (editor
 * saves) and the page (lazy-load fetches) so a key-pattern groupId can never
 * leak fields from a sibling tab.
 */

import { useLoaderData } from "@remix-run/react";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

const RESOURCE_TYPES = ["ONLINE_STORE_THEME_JSON_TEMPLATE"];

export const loader = makeThemeDomainLoader("theme", "THEME_TEMPLATES", RESOURCE_TYPES);
export const action = makeThemeContentRouteAction("theme", RESOURCE_TYPES);

export default function TemplatesPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={TEMPLATES_CONFIG}
      apiBasePath="/api/theme-content/theme"
      planContentType="templates"
      resourceTypes={RESOURCE_TYPES}
    />
  );
}

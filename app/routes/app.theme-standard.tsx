/**
 * Theme rubric → "Theme-Standardinhalte" tab (ONLINE_STORE_THEME_LOCALE_CONTENT,
 * plus any legacy ONLINE_STORE_THEME rows). The theme's locale-file strings —
 * buttons, labels, system messages — grouped by top-level prefix.
 *
 * One of six Theme sub-tabs sharing domain="theme", scoped by resource type.
 * See app.templates.tsx for the shared-factory pattern.
 */

import { useLoaderData } from "react-router";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

const RESOURCE_TYPES = ["ONLINE_STORE_THEME_LOCALE_CONTENT", "ONLINE_STORE_THEME"];

export const loader = makeThemeDomainLoader("theme", "THEME_STANDARD", RESOURCE_TYPES);
export const action = makeThemeContentRouteAction("theme", RESOURCE_TYPES);

export default function ThemeStandardPage() {
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

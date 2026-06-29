/**
 * Theme rubric → "Abschnittsgruppen" tab (ONLINE_STORE_THEME_SECTION_GROUP).
 * Section groups such as header/footer.
 *
 * One of six Theme sub-tabs sharing domain="theme", scoped by resource type.
 * See app.templates.tsx for the shared-factory pattern.
 */

import { useLoaderData } from "@remix-run/react";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

const RESOURCE_TYPES = ["ONLINE_STORE_THEME_SECTION_GROUP"];

export const loader = makeThemeDomainLoader("theme", "THEME_SECTION_GROUPS", RESOURCE_TYPES);
export const action = makeThemeContentRouteAction("theme", RESOURCE_TYPES);

export default function ThemeSectionGroupsPage() {
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

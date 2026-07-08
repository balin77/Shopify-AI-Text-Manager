/**
 * Theme rubric → "Statische Abschnitte" tab
 * (ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS). Shared/static sections defined in
 * the theme's settings data. Always shown in the nav (NOT conditional) so
 * merchants can discover/add static-section content even when none exists yet.
 *
 * One of six Theme sub-tabs sharing domain="theme", scoped by resource type.
 * See app.templates.tsx for the shared-factory pattern.
 */

import { useLoaderData } from "@remix-run/react";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

const RESOURCE_TYPES = ["ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS"];

export const loader = makeThemeDomainLoader("theme", "THEME_STATIC_SECTIONS", RESOURCE_TYPES);
export const action = makeThemeContentRouteAction("theme", RESOURCE_TYPES);

export default function ThemeStaticSectionsPage() {
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

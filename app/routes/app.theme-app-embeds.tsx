/**
 * Theme rubric → "App-Einbettungen" tab (ONLINE_STORE_THEME_APP_EMBED).
 * App-embed block content — mostly technical (CSS selectors / config); the
 * loader flags these groups `embedTechnical` so the page shows a warning that
 * translating them may break the embed. Conditional in the nav: hidden when
 * empty.
 *
 * One of six Theme sub-tabs sharing domain="theme", scoped by resource type.
 * See app.templates.tsx for the shared-factory pattern.
 */

import { useLoaderData } from "react-router";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

const RESOURCE_TYPES = ["ONLINE_STORE_THEME_APP_EMBED"];

export const loader = makeThemeDomainLoader("theme", "THEME_APP_EMBEDS", RESOURCE_TYPES);
export const action = makeThemeContentRouteAction("theme", RESOURCE_TYPES);

export default function ThemeAppEmbedsPage() {
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

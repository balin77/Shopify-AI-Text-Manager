/**
 * Theme Templates ("Vorlagen") — Theme rubric umbrella.
 *
 * Thin wrapper: loader + action come from the shared ThemeContent domain
 * factories (domain="theme"); the page UI is the shared ThemeContentDomainPage.
 * The same three pieces power the System / Online-Store-Extras / Selling-Plans
 * routes with a different domain.
 */

import { useLoaderData } from "@remix-run/react";
import { TEMPLATES_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";

export const loader = makeThemeDomainLoader("theme", "TEMPLATES");
export const action = makeThemeContentRouteAction("theme");

export default function TemplatesPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={TEMPLATES_CONFIG}
      apiBasePath="/api/templates"
      planContentType="templates"
    />
  );
}

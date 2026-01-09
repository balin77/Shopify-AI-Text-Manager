import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import type { Locale } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Load app language preference from database
  const { db } = await import("../db.server");
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  const appLanguage = (settings?.appLanguage || "de") as Locale;

  return json({ appLanguage });
};

export default function App() {
  const { appLanguage } = useLoaderData<typeof loader>();

  return (
    <AppProvider i18n={{}}>
      <I18nProvider locale={appLanguage}>
        <Outlet />
      </I18nProvider>
    </AppProvider>
  );
}

// Shopify app boundary error handler
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = boundary.headers;

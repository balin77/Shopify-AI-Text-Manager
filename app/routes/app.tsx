import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import { InfoBoxProvider } from "../contexts/InfoBoxContext";
import type { Locale } from "../i18n";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("🔍 [APP.TSX LOADER] Start - URL:", request.url);
  console.log("🔍 [APP.TSX LOADER] Method:", request.method);

  const headers = Object.fromEntries(request.headers.entries());
  console.log("🔍 [APP.TSX LOADER] Headers:", headers);

  // Check if this is a prefetch request - these don't have session tokens
  const isPrefetch = headers['sec-purpose'] === 'prefetch' || headers['purpose'] === 'prefetch';

  if (isPrefetch) {
    console.log("⚡ [APP.TSX LOADER] Prefetch request detected - returning default language");
    // Return default data for prefetch - no auth needed
    return json({
      appLanguage: "de" as Locale
    });
  }

  try {
    console.log("🔍 [APP.TSX LOADER] Authenticating...");
    const { session } = await authenticate.admin(request);
    console.log("✅ [APP.TSX LOADER] Authentication successful");
    console.log("✅ [APP.TSX LOADER] Shop:", session.shop);
    console.log("✅ [APP.TSX LOADER] Session ID:", session.id);

    // Load app language preference from database
    const { db } = await import("../db.server");
    console.log("🔍 [APP.TSX LOADER] Loading settings from DB...");
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    console.log("✅ [APP.TSX LOADER] Settings loaded:", settings ? "Found" : "Not found");

    const appLanguage = (settings?.appLanguage || "de") as Locale;
    console.log("✅ [APP.TSX LOADER] App language:", appLanguage);

    return json({
      appLanguage
    });
  } catch (error) {
    console.error("❌ [APP.TSX LOADER] Error:", error);
    console.error("❌ [APP.TSX LOADER] Error stack:", error instanceof Error ? error.stack : "No stack");
    throw error;
  }
};

export default function App() {
  const { appLanguage } = useLoaderData<typeof loader>();

  console.log("🎨 [APP.TSX] Rendering App component with language:", appLanguage);

  return (
    <AppProvider i18n={{}}>
      <I18nProvider locale={appLanguage}>
        <InfoBoxProvider>
          <Outlet />
        </InfoBoxProvider>
      </I18nProvider>
    </AppProvider>
  );
}

// Shopify app boundary error handler
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = boundary.headers;

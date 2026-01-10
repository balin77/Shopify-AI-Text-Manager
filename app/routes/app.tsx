import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { Suspense } from "react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import type { Locale } from "../i18n";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

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
      appLanguage: "de" as Locale,
      apiKey: process.env.SHOPIFY_API_KEY || ""
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
      appLanguage,
      apiKey: process.env.SHOPIFY_API_KEY || ""
    });
  } catch (error) {
    console.error("❌ [APP.TSX LOADER] Error:", error);
    console.error("❌ [APP.TSX LOADER] Error stack:", error instanceof Error ? error.stack : "No stack");
    throw error;
  }
};

export default function App() {
  const { appLanguage, apiKey } = useLoaderData<typeof loader>();

  console.log("🎨 [APP.TSX] Rendering App component with language:", appLanguage);
  console.log("🎨 [APP.TSX] API Key present:", apiKey ? "✅ Yes" : "❌ No");

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <AppProvider isEmbeddedApp apiKey={apiKey}>
        <I18nProvider locale={appLanguage}>
          <Outlet />
        </I18nProvider>
      </AppProvider>
    </Suspense>
  );
}

// Shopify app boundary error handler
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = boundary.headers;

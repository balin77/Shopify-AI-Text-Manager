import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import { InfoBoxProvider } from "../contexts/InfoBoxContext";
import { PlanProvider } from "../contexts/PlanContext";
import { NavigationHeightProvider } from "../contexts/NavigationHeightContext";
import { useEffect } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import type { Locale } from "../i18n";
import type { Plan } from "../config/plans";


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
      subscriptionPlan: "basic" as Plan,
      aiSettings: null,
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
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    console.log("🔍 [APP.TSX LOADER] Loading settings from DB...");
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    console.log("✅ [APP.TSX LOADER] Settings loaded:", settings ? "Found" : "Not found");

    const appLanguage = (settings?.appLanguage || "de") as Locale;
    const subscriptionPlan = (settings?.subscriptionPlan || "basic") as Plan;
    console.log("✅ [APP.TSX LOADER] App language:", appLanguage);
    console.log("✅ [APP.TSX LOADER] Subscription plan:", subscriptionPlan);

    // Load AI settings for global API key validation
    const aiSettings = await loadAISettingsForValidation(db, session.shop);

    return json({
      appLanguage,
      subscriptionPlan,
      aiSettings,
    });
  } catch (error) {
    console.error("❌ [APP.TSX LOADER] Error:", error);
    console.error("❌ [APP.TSX LOADER] Error stack:", error instanceof Error ? error.stack : "No stack");
    throw error;
  }
};

function AppContent() {
  const { aiSettings } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Check API key on mount and show warning in InfoBox if missing
  useEffect(() => {
    if (!aiSettings || !aiSettings.preferredProvider) return;

    // Check if preferred provider has an API key using boolean flags
    const provider = aiSettings.preferredProvider.toLowerCase();
    let hasApiKey = false;

    switch (provider) {
      case 'huggingface':
        hasApiKey = aiSettings.hasHuggingfaceApiKey;
        break;
      case 'gemini':
        hasApiKey = aiSettings.hasGeminiApiKey;
        break;
      case 'claude':
        hasApiKey = aiSettings.hasClaudeApiKey;
        break;
      case 'openai':
        hasApiKey = aiSettings.hasOpenaiApiKey;
        break;
      case 'grok':
        hasApiKey = aiSettings.hasGrokApiKey;
        break;
      case 'deepseek':
        hasApiKey = aiSettings.hasDeepseekApiKey;
        break;
    }

    if (!hasApiKey) {
      const providerName = getProviderDisplayName(aiSettings.preferredProvider as AIProvider);
      const message = t.settings?.preferredProviderNoKey?.replace("{provider}", providerName) ||
        `No ${providerName} API key. Please add in Settings.`;

      showInfoBox(message, "warning", t.settings?.noApiKeyConfigured || "No API Key");
    }
  }, [aiSettings, t, showInfoBox]);

  return <Outlet />;
}

export default function App() {
  const { appLanguage, subscriptionPlan } = useLoaderData<typeof loader>();

  return (
    <AppProvider i18n={{}}>
      <I18nProvider locale={appLanguage}>
        <PlanProvider plan={subscriptionPlan}>
          <InfoBoxProvider>
            <NavigationHeightProvider>
              <AppContent />
            </NavigationHeightProvider>
          </InfoBoxProvider>
        </PlanProvider>
      </I18nProvider>
    </AppProvider>
  );
}

// Shopify app boundary error handler
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = boundary.headers;

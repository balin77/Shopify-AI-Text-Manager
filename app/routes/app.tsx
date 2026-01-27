import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider, Page, Card, BlockStack, Text, Button } from "@shopify/polaris";
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
import { logger } from "~/utils/logger.server";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  logger.debug("[APP.TSX LOADER] Start", { context: "App", url: request.url, method: request.method });

  const headers = Object.fromEntries(request.headers.entries());

  // Check if this is a prefetch request - these don't have session tokens
  const isPrefetch = headers['sec-purpose'] === 'prefetch' || headers['purpose'] === 'prefetch';

  if (isPrefetch) {
    logger.debug("[APP.TSX LOADER] Prefetch request detected - returning default language", { context: "App" });
    // Return default data for prefetch - no auth needed
    return json({
      appLanguage: "de" as Locale,
      subscriptionPlan: "basic" as Plan,
      aiSettings: null,
    });
  }

  try {
    logger.debug("[APP.TSX LOADER] Authenticating...", { context: "App" });
    const { session } = await authenticate.admin(request);
    logger.debug("[APP.TSX LOADER] Authentication successful", { context: "App", shop: session.shop, sessionId: session.id });

    // Load app language preference from database
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    logger.debug("[APP.TSX LOADER] Loading settings from DB...", { context: "App" });
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    logger.debug("[APP.TSX LOADER] Settings loaded", { context: "App", found: !!settings });

    const appLanguage = (settings?.appLanguage || "de") as Locale;
    const subscriptionPlan = (settings?.subscriptionPlan || "basic") as Plan;
    logger.debug("[APP.TSX LOADER] App settings", { context: "App", appLanguage, subscriptionPlan });

    // Load AI settings for global API key validation
    const aiSettings = await loadAISettingsForValidation(db, session.shop);

    return json({
      appLanguage,
      subscriptionPlan,
      aiSettings,
    });
  } catch (error) {
    // Check if this is a redirect response (e.g., to /auth/login)
    // Redirects should be re-thrown, not caught as errors
    if (error instanceof Response) {
      const status = error.status;
      const location = error.headers.get('location');

      // Log redirect for debugging, but don't treat as error
      if (status >= 300 && status < 400) {
        logger.debug("[APP.TSX LOADER] Redirect detected", { context: "App", status, location });
        throw error; // Re-throw the redirect to let Remix handle it
      }
    }

    logger.error("[APP.TSX LOADER] Error", { context: "App", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });

    // Return default values instead of throwing to prevent blank page
    // This can happen during plan changes when auth session is temporarily invalid
    return json({
      appLanguage: "de" as Locale,
      subscriptionPlan: "basic" as Plan,
      aiSettings: null,
      loaderError: true,
    });
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
  const error = useRouteError();

  // Log the error for debugging - note: can't use server logger in client component

  // Try Shopify's boundary first, but provide fallback UI if it fails
  try {
    return boundary.error(error);
  } catch {
    // Fallback UI when Shopify boundary fails - using Polaris components
    return (
      <AppProvider i18n={{}}>
        <Page>
          <Card>
            <BlockStack gap="400" align="center">
              <Text as="h1" variant="headingLg">Ein Fehler ist aufgetreten</Text>
              <Text as="p" tone="subdued">
                Bitte laden Sie die Seite neu oder versuchen Sie es später erneut.
              </Text>
              <Button onClick={() => window.location.reload()}>
                Seite neu laden
              </Button>
            </BlockStack>
          </Card>
        </Page>
      </AppProvider>
    );
  }
}

export const headers = boundary.headers;

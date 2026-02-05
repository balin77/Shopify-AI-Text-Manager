import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider, Page, Card, BlockStack, Text, Button } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import "../styles/responsive.css";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import { InfoBoxProvider } from "../contexts/InfoBoxContext";
import { PlanProvider } from "../contexts/PlanContext";
import { NavigationHeightProvider } from "../contexts/NavigationHeightContext";
import { ItemSelectorProvider } from "../contexts/ItemSelectorContext";
import { useEffect, useMemo } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import type { Locale } from "../i18n";
import type { Plan } from "../config/plans";
import { logger } from "~/utils/logger.server";
import { de, en, es } from "../i18n";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  logger.debug("[APP.TSX LOADER] Start", { context: "App", url: request.url, method: request.method });

  const headers = Object.fromEntries(request.headers.entries());
  const url = new URL(request.url);

  // Check if this is a prefetch request - these don't have session tokens
  const isPrefetch = headers['sec-purpose'] === 'prefetch' || headers['purpose'] === 'prefetch';

  if (isPrefetch) {
    logger.debug("[APP.TSX LOADER] Prefetch request detected - returning default language", { context: "App" });
    // Return default data for prefetch - no auth needed
    return json({
      appLanguage: "en" as Locale,
      subscriptionPlan: "basic" as Plan,
      aiSettings: null,
    });
  }

  // Check if this is a browser reload (F5) - these lose session tokens in embedded apps
  const isBrowserReload = !url.searchParams.has('shop') && !url.searchParams.has('host');
  if (isBrowserReload) {
    logger.warn("[APP.TSX LOADER] Browser reload detected without shop params - this will cause auth issues in embedded apps", { context: "App" });
  }

  try {
    logger.debug("[APP.TSX LOADER] Authenticating...", { context: "App" });
    const { session } = await authenticate.admin(request);
    logger.debug("[APP.TSX LOADER] Authentication successful", { context: "App", shop: session.shop, sessionId: session.id });

    // Load app language preference from database
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    logger.debug("[APP.TSX LOADER] Loading settings from DB...", { context: "App" });

    // Run DB queries in parallel for better TTFB performance
    const [settings, aiSettings] = await Promise.all([
      db.aISettings.findUnique({
        where: { shop: session.shop },
        select: {
          appLanguage: true,
          subscriptionPlan: true,
        },
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    logger.debug("[APP.TSX LOADER] Settings loaded", { context: "App", found: !!settings });

    const appLanguage = (settings?.appLanguage || "en") as Locale;
    const subscriptionPlan = (settings?.subscriptionPlan || "basic") as Plan;
    logger.debug("[APP.TSX LOADER] App settings", { context: "App", appLanguage, subscriptionPlan });

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
      appLanguage: "en" as Locale,
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
              <ItemSelectorProvider>
                <AppContent />
              </ItemSelectorProvider>
            </NavigationHeightProvider>
          </InfoBoxProvider>
        </PlanProvider>
      </I18nProvider>
    </AppProvider>
  );
}

// Helper to check if error is a manifest mismatch (happens after deployments)
function isManifestMismatchError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('manifest') && error.message.includes('mismatch');
  }
  return false;
}

// Helper to safely reload with loop prevention and session preservation
function safeReload() {
  const RELOAD_KEY = 'manifest_reload_timestamp';
  const RELOAD_COUNT_KEY = 'manifest_reload_count';
  const lastReload = sessionStorage.getItem(RELOAD_KEY);
  const reloadCount = parseInt(sessionStorage.getItem(RELOAD_COUNT_KEY) || '0', 10);
  const now = Date.now();

  // Reset count if last reload was more than 30 seconds ago
  if (lastReload && now - parseInt(lastReload, 10) > 30000) {
    sessionStorage.setItem(RELOAD_COUNT_KEY, '0');
  }

  // Prevent reload loop: max 2 reloads within 30 seconds
  if (reloadCount >= 2) {
    console.warn('[APP.TSX] Reload loop detected (max attempts reached), showing error UI instead');
    return false;
  }

  sessionStorage.setItem(RELOAD_KEY, now.toString());
  sessionStorage.setItem(RELOAD_COUNT_KEY, (reloadCount + 1).toString());
  console.log('[APP.TSX] Performing cache-busted reload due to manifest mismatch (attempt ' + (reloadCount + 1) + ')');

  // Force a cache-busted reload by navigating to current URL with cache-busting param
  const url = new URL(window.location.href);
  url.searchParams.set('_reload', now.toString());

  // Preserve shop and host params to maintain Shopify session
  const currentUrl = new URL(window.location.href);
  if (!url.searchParams.has('shop') && currentUrl.searchParams.has('shop')) {
    url.searchParams.set('shop', currentUrl.searchParams.get('shop')!);
  }
  if (!url.searchParams.has('host') && currentUrl.searchParams.has('host')) {
    url.searchParams.set('host', currentUrl.searchParams.get('host')!);
  }

  window.location.href = url.toString();
  return true;
}

// Helper function to get translations based on browser language
function getBrowserLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const browserLang = navigator.language.split('-')[0];
  if (browserLang === 'de') return 'de';
  if (browserLang === 'es') return 'es';
  return 'en';
}

// Shopify app boundary error handler
export function ErrorBoundary() {
  // Always use 'en' as default to avoid hydration mismatch
  // The ErrorBoundary should show a consistent message across server/client
  const locale: Locale = 'en';
  const translations = { de, en, es };
  const t = translations[locale];

  // Get the error - useRouteError is safe to call in ErrorBoundary
  const error = useRouteError();

  // Log the error for debugging
  if (typeof window !== 'undefined') {
    console.error('[APP.TSX ErrorBoundary] Caught error:', error);
  }

  // Handle manifest version mismatch: automatic reload after deployment
  if (isManifestMismatchError(error)) {
    if (typeof window !== 'undefined') {
      console.log('[APP.TSX ErrorBoundary] Manifest mismatch detected - attempting automatic reload');
    }

    // Try automatic reload (with loop prevention) - only on client side
    if (typeof window !== 'undefined' && safeReload()) {
      // Show brief loading state while reload happens
      return (
        <AppProvider i18n={{}}>
          <Page>
            <Card>
              <BlockStack gap="400" align="center">
                <Text as="h1" variant="headingLg">{t.errors.updateDetected}</Text>
                <Text as="p" tone="subdued">
                  {t.errors.updateAutoReload}
                </Text>
              </BlockStack>
            </Card>
          </Page>
        </AppProvider>
      );
    }

    // If reload failed or was blocked due to loop prevention, show manual reload button
    return (
      <AppProvider i18n={{}}>
        <Page>
          <Card>
            <BlockStack gap="400" align="center">
              <Text as="h1" variant="headingLg">{t.errors.updateDetected}</Text>
              <Text as="p" tone="subdued">
                {t.errors.updateAvailable}
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    // Preserve shop and host params when reloading
                    const url = new URL(window.location.href);
                    url.searchParams.set('_reload', Date.now().toString());
                    window.location.href = url.toString();
                  }
                }}
              >
                {t.errors.reloadPage}
              </Button>
            </BlockStack>
          </Card>
        </Page>
      </AppProvider>
    );
  }

  // Try Shopify's boundary first
  return boundary.error(error);
}

export const headers = boundary.headers;

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
import { SeoSettingsProvider } from "../contexts/SeoSettingsContext";
import { NavigationHeightProvider } from "../contexts/NavigationHeightContext";
import { ItemSelectorProvider } from "../contexts/ItemSelectorContext";
import { TaskCountProvider } from "../contexts/TaskCountContext";
import { NavigationGuardProvider } from "../contexts/NavigationGuardContext";
import { useEffect } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import type { Locale } from "../i18n";
import type { Plan } from "../config/plans";
import { logger } from "~/utils/logger.server";
import { checkAndSyncSubscription } from "~/services/billing.server";
import { isProductionLocked } from "../utils/planUtils";
import { de, en, es } from "../i18n";

// Inline helper to build API-key presence flags from a single AISettings record.
type AiSettingsRow = {
  huggingfaceApiKey?: string | null;
  geminiApiKey?: string | null;
  claudeApiKey?: string | null;
  openaiApiKey?: string | null;
  grokApiKey?: string | null;
  deepseekApiKey?: string | null;
  preferredProvider?: string | null;
} | null | undefined;

function buildAiSettingsFlags(settings: AiSettingsRow, decryptApiKey: (v?: string | null) => string | null) {
  return {
    hasHuggingfaceApiKey: !!decryptApiKey(settings?.huggingfaceApiKey),
    hasGeminiApiKey: !!decryptApiKey(settings?.geminiApiKey),
    hasClaudeApiKey: !!decryptApiKey(settings?.claudeApiKey),
    hasOpenaiApiKey: !!decryptApiKey(settings?.openaiApiKey),
    hasGrokApiKey: !!decryptApiKey(settings?.grokApiKey),
    hasDeepseekApiKey: !!decryptApiKey(settings?.deepseekApiKey),
    preferredProvider: settings?.preferredProvider || null,
  };
}


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Check if this is a browser reload (F5) - these lose session tokens in embedded apps
  const isBrowserReload = !url.searchParams.has('shop') && !url.searchParams.has('host');
  if (isBrowserReload) {
    logger.warn("[APP.TSX LOADER] Browser reload detected without shop params", { context: "App" });
  }

  try {
    const { admin, session } = await authenticate.admin(request);

    // Sync subscription BEFORE reading plan so the DB value is always up-to-date
    // when returning from Shopify billing (app.tsx and child loaders run in parallel,
    // causing a race if we let the child route do the sync instead)
    if (url.searchParams.get('billing') === 'success') {
      try {
        await checkAndSyncSubscription(admin, session.shop);
      } catch (e) {
        logger.warn("[APP.TSX] Billing sync failed, plan may be stale", { context: "App", error: String(e) });
      }
    }

    // Load app language preference from database
    const { db } = await import("../db.server");
    const { decryptApiKey } = await import("../utils/encryption.server");

    // Single query for all needed AISettings fields — avoids two round-trips
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: {
        appLanguage: true,
        subscriptionPlan: true,
        huggingfaceApiKey: true,
        geminiApiKey: true,
        claudeApiKey: true,
        openaiApiKey: true,
        grokApiKey: true,
        deepseekApiKey: true,
        preferredProvider: true,
        seoTitleSuffixEnabled: true,
        seoTitleSuffix: true,
      },
    });

    const appLanguage = (settings?.appLanguage || "en") as Locale;
    const subscriptionPlan = (settings?.subscriptionPlan || "free") as Plan;

    // Build API-key presence flags from the single query result
    let aiSettings: ReturnType<typeof buildAiSettingsFlags>;
    try {
      aiSettings = buildAiSettingsFlags(settings, decryptApiKey);
    } catch {
      aiSettings = buildAiSettingsFlags(null, decryptApiKey);
    }

    const seoTitleSuffix = settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix
      ? settings.seoTitleSuffix
      : "";

    return json({
      appLanguage,
      subscriptionPlan,
      aiSettings,
      seoTitleSuffix,
      newFeaturesEnabled: !isProductionLocked(),
    });
  } catch (error) {
    // Check if this is a redirect response (e.g., to /auth/login)
    // Redirects should be re-thrown, not caught as errors
    if (error instanceof Response) {
      const status = error.status;

      // Redirects are normal auth flow, not errors
      if (status >= 300 && status < 400) {
        throw error; // Re-throw the redirect to let Remix handle it
      }
    }

    logger.error("[APP.TSX LOADER] Error", { context: "App", error: error instanceof Error ? error.message : String(error) });

    // Return default values instead of throwing to prevent blank page
    // This can happen during plan changes when auth session is temporarily invalid
    return json({
      appLanguage: "en" as Locale,
      subscriptionPlan: "free" as Plan,
      aiSettings: null,
      seoTitleSuffix: "",
      newFeaturesEnabled: !isProductionLocked(),
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

  return (
    <AppErrorBoundary>
      <Outlet />
    </AppErrorBoundary>
  );
}

export default function App() {
  const { appLanguage, subscriptionPlan, seoTitleSuffix, newFeaturesEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider i18n={{}}>
      <I18nProvider locale={appLanguage}>
        <PlanProvider plan={subscriptionPlan} newFeaturesEnabled={newFeaturesEnabled}>
          <SeoSettingsProvider seoTitleSuffix={seoTitleSuffix ?? ""}>
          <InfoBoxProvider>
            <NavigationGuardProvider>
            <TaskCountProvider>
            <NavigationHeightProvider>
              <ItemSelectorProvider>
                <AppContent />
              </ItemSelectorProvider>
            </NavigationHeightProvider>
            </TaskCountProvider>
            </NavigationGuardProvider>
          </InfoBoxProvider>
          </SeoSettingsProvider>
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

// Helper to check if error is a "Failed to fetch" (session token expiry / network loss)
function isFailedToFetchError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message === 'Failed to fetch';
  }
  if (error instanceof Response) {
    return false;
  }
  // React Router may wrap the error
  if (typeof error === 'object' && error !== null) {
    const inner = (error as any).error ?? (error as any).data;
    if (inner instanceof Error) {
      return inner.message === 'Failed to fetch';
    }
  }
  return false;
}

// Helper to safely reload with loop prevention and session preservation.
// Uses URL params instead of sessionStorage to work in Incognito mode.
function safeReload() {
  const now = Date.now();
  const url = new URL(window.location.href);

  // Check previous reload attempts from URL params (survives the reload cycle)
  const lastReloadParam = url.searchParams.get('_reload');
  const reloadCountParam = parseInt(url.searchParams.get('_rc') || '0', 10);

  // Reset count if last reload was more than 30 seconds ago
  const effectiveCount = (lastReloadParam && now - parseInt(lastReloadParam, 10) < 30000)
    ? reloadCountParam
    : 0;

  // Prevent reload loop: max 2 reloads within 30 seconds
  if (effectiveCount >= 2) {
    return false;
  }

  // Set reload tracking params
  url.searchParams.set('_reload', now.toString());
  url.searchParams.set('_rc', (effectiveCount + 1).toString());

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

  // Handle "Failed to fetch" — typically caused by expired App Bridge session token
  // after the app has been idle for a while. Auto-reload lets App Bridge re-authenticate.
  if (isFailedToFetchError(error)) {
    if (typeof window !== 'undefined' && safeReload()) {
      return (
        <AppProvider i18n={{}}>
          <Page>
            <Card>
              <BlockStack gap="400" align="center">
                <Text as="h1" variant="headingLg">{t.errors.sessionError}</Text>
                <Text as="p" tone="subdued">
                  {t.errors.sessionErrorDescription}
                </Text>
              </BlockStack>
            </Card>
          </Page>
        </AppProvider>
      );
    }

    // Reload loop prevention triggered — show manual reload button
    return (
      <AppProvider i18n={{}}>
        <Page>
          <Card>
            <BlockStack gap="400" align="center">
              <Text as="h1" variant="headingLg">{t.errors.sessionError}</Text>
              <Text as="p" tone="subdued">
                {t.errors.sessionErrorDescription}
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  if (typeof window !== 'undefined') {
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

import { resolveApiVersionString } from "../utils/api-version";
import { data as json, type LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider, Page, Card, BlockStack, Text, Button } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import "../styles/responsive.css";
import { authenticate } from "../shopify.server";
import { I18nProvider } from "../contexts/I18nContext";
import { InfoBoxProvider } from "../contexts/InfoBoxContext";
import { ConfirmProvider } from "../contexts/ConfirmContext";
import { PlanProvider } from "../contexts/PlanContext";
import { SeoSettingsProvider } from "../contexts/SeoSettingsContext";
import { NavigationHeightProvider } from "../contexts/NavigationHeightContext";
import { ItemSelectorProvider } from "../contexts/ItemSelectorContext";
import { TaskCountProvider } from "../contexts/TaskCountContext";
import { AltTextOpsProvider } from "../contexts/AltTextOpsContext";
import { SidebarPanelProvider } from "../contexts/SidebarPanelContext";
import { useEffect, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { InitialSyncBanner } from "../components/InitialSyncBanner";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getProviderDisplayName, type AIProvider } from "../utils/api-key-validation";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import type { Locale } from "../i18n";
import { resolveMerchantLocale } from "../utils/locale.server";
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
        seoLimits: true,
        extensionSetupHintShownAt: true,
      },
    });

    // R4-UX1: respect an explicit stored choice; otherwise fall back to the
    // merchant's Shopify admin locale instead of forcing English. (A row is
    // only created once the merchant visits Settings, so the common
    // fresh-install path used to be permanently English here.)
    const appLanguage: Locale = settings?.appLanguage
      ? (settings.appLanguage as Locale)
      : resolveMerchantLocale(request);
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
    // Sparse merchant overrides for SEO limits (Pro+). null = defaults.
    const seoLimits = (settings?.seoLimits ?? null) as Record<string, number> | null;

    // First-run hint: a shop that just reached Pro/Max still has to enable the
    // ContentPilot theme app extension in their theme editor for the variant
    // gallery to render on the storefront. We surface this once (one-shot
    // marker below), and only while the feature is actually unlocked — same
    // gate as `showImageManagerTab` in app.settings.tsx.
    const extensionSetupHint =
      !isProductionLocked() &&
      (subscriptionPlan === "pro" || subscriptionPlan === "max") &&
      !settings?.extensionSetupHintShownAt;

    // Seed the initial-sync banner from the DB so it renders immediately on
    // any full document load (reopen / hard reload) without waiting for the
    // first client poll — the poll then keeps it fresh.
    const installState = await db.shopInstallState.findUnique({
      where: { shop: session.shop },
      select: {
        initialSyncCompletedAt: true,
        initialSyncPhase: true,
        initialSyncPercent: true,
        initialSyncStats: true,
        initialSyncError: true,
      },
    });
    const initialSync = {
      needsSetup: !installState?.initialSyncCompletedAt,
      phase: installState?.initialSyncPhase ?? null,
      percent: installState?.initialSyncPercent ?? 0,
      stats: (installState?.initialSyncStats ?? null) as Record<string, number> | null,
      error: installState?.initialSyncError ?? null,
    };

    // Presence of conditional content types (drives nav hiding of entitled-but-
    // empty entries, e.g. the Theme App-Einbettungen tab which many shops lack).
    // Cheap indexed count on (shop, domain).
    // NOTE: Statische Abschnitte is intentionally NOT conditional — it is always
    // shown so merchants can discover/add static-section content. Abo-Pläne is
    // likewise always shown now (gated via canAccessContentType, not hidden when
    // empty), so merchants on Pro/Max can reach the page and use its reload-all
    // button to discover newly-created selling plans.
    const themeAppEmbedRows = await db.themeContent.count({
      where: { shop: session.shop, domain: "theme", resourceType: "ONLINE_STORE_THEME_APP_EMBED" },
    });
    const conditionalContent = {
      themeAppEmbeds: themeAppEmbedRows > 0,
    };

    // Published locale count for the navigation's language gate (a section like
    // the hreflang audit is greyed out on a single-language shop, mobile drawer
    // included — the drawer is reachable from every page, so the count has to
    // live in the shell loader, not in a section route).
    //
    // Served from the 60s shop-locales cache the content loaders use anyway.
    // NOT wrapped in a catch: the cache swallows every failure itself and
    // resolves with `[]` — the one error it does propagate is the 401 Response
    // it re-throws for re-authentication, which must reach this loader's own
    // error path instead of being silently turned into a number. An empty list
    // therefore yields 0, which means "unknown" (a shop always has at least its
    // primary locale) and the nav reads it as multi-language, so a lookup
    // hiccup can never grey out a section the merchant can actually use.
    const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
    const localeCount = (await getCachedShopLocales(admin, session.shop)).filter(
      (l) => l.published !== false,
    ).length;

    return json({
      appLanguage,
      subscriptionPlan,
      aiSettings,
      seoTitleSuffix,
      seoLimits,
      localeCount,
      newFeaturesEnabled: !isProductionLocked(),
      initialSync,
      extensionSetupHint,
      conditionalContent,
      // PLAN_CONTENT_CREATION §1.4b — the client needs to know which Shopify
      // API this deployment speaks, because `sources[]` (and therefore the
      // collection rule editor) only exists from 2026-07. A deploy constant,
      // not a per-shop value, but the client has no other way to see it.
      shopifyApiVersion: resolveApiVersionString(),
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
      appLanguage: resolveMerchantLocale(request),
      subscriptionPlan: "free" as Plan,
      aiSettings: null,
      seoTitleSuffix: "",
      seoLimits: null as Record<string, number> | null,
      // 0 = unknown → the nav's language gate stays off (see the success path).
      localeCount: 0,
      newFeaturesEnabled: !isProductionLocked(),
      initialSync: null,
      extensionSetupHint: false,
      conditionalContent: { themeAppEmbeds: true },
      loaderError: true,
    });
  }
};

function AppContent() {
  const { aiSettings, extensionSetupHint } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { showInfoBox, infoBox, dismissByKey } = useInfoBox();
  const hintFetcher = useFetcher();
  const extensionHintRequested = useRef(false);
  const extensionHintPersisted = useRef(false);

  // First-run nudge: a shop that just reached Pro/Max still has to enable the
  // ContentPilot theme app extension for the variant gallery to appear on the
  // storefront. Surface it once, non-blocking, with a deep-link into the
  // Image-Manager settings tab where the actual theme-editor buttons live.
  // Merchants who don't want it can just dismiss. Message string is computed
  // here so the persist effect below can match it against the active infobox.
  const extensionHintMessage =
    t.settings?.extensionSetupHintMessage ||
    "You're on Pro/Max — to show variant image galleries on your storefront, the ContentPilot theme extension still needs to be enabled in your theme editor. This is optional.";

  useEffect(() => {
    if (!extensionSetupHint || extensionHintRequested.current) return;
    extensionHintRequested.current = true;

    showInfoBox(
      extensionHintMessage,
      // 'warning' (not 'info') so the hint persists until dismissed instead of
      // auto-hiding after 5s — it carries an actionable deep-link.
      "warning",
      t.settings?.extensionSetupHintTitle || "Set up the theme extension",
      {
        url: "/app/settings?tab=imagemanager",
        label: t.settings?.extensionSetupHintAction || "Set it up",
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionSetupHint]);

  // Persist the one-shot marker only once the hint is ACTUALLY the active
  // infobox — showInfoBox queues it behind any message already showing, so
  // persisting on the request alone would mean "attempted once", not "shown
  // once": a merchant leaving before a queued hint surfaces would burn it
  // unseen. Watching infoBox keeps the real guarantee. (Residual: two tabs /
  // a hard reload before this POST commits can show it 2×; accepted for an
  // optional nudge — it is self-limiting once the marker lands.)
  useEffect(() => {
    if (!extensionSetupHint || extensionHintPersisted.current) return;
    if (infoBox?.message !== extensionHintMessage) return;
    extensionHintPersisted.current = true;
    hintFetcher.submit(null, { method: "post", action: "/api/extension-setup-hint" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoBox, extensionSetupHint]);

  // Check API key on mount and show warning in InfoBox if missing.
  // After a successful save in the Settings tab the loader re-runs and
  // `aiSettings` updates; this effect must therefore also *clear* any
  // warning it previously showed when the underlying condition is gone
  // (the early returns alone don't remove the entry from the message
  // bell). Both warnings carry a stable dedupeKey for that.
  useEffect(() => {
    if (!aiSettings) return;

    const hasAnyKey =
      aiSettings.hasHuggingfaceApiKey ||
      aiSettings.hasGeminiApiKey ||
      aiSettings.hasClaudeApiKey ||
      aiSettings.hasOpenaiApiKey ||
      aiSettings.hasGrokApiKey ||
      aiSettings.hasDeepseekApiKey;

    // Does the preferred provider (if one is selected) have a key?
    let hasPreferredKey = false;
    switch (aiSettings.preferredProvider?.toLowerCase()) {
      case 'huggingface': hasPreferredKey = aiSettings.hasHuggingfaceApiKey; break;
      case 'gemini': hasPreferredKey = aiSettings.hasGeminiApiKey; break;
      case 'claude': hasPreferredKey = aiSettings.hasClaudeApiKey; break;
      case 'openai': hasPreferredKey = aiSettings.hasOpenaiApiKey; break;
      case 'grok': hasPreferredKey = aiSettings.hasGrokApiKey; break;
      case 'deepseek': hasPreferredKey = aiSettings.hasDeepseekApiKey; break;
    }

    const NO_KEY_AT_ALL = "missing-api-key:any";
    const NO_PREFERRED_KEY = "missing-api-key:preferred";

    // Nothing to warn about: the selected provider has a key. (When no
    // provider is selected we still warn iff there is no key at all.)
    if (aiSettings.preferredProvider && hasPreferredKey) {
      dismissByKey(NO_KEY_AT_ALL);
      dismissByKey(NO_PREFERRED_KEY);
      return;
    }
    if (!aiSettings.preferredProvider && hasAnyKey) {
      dismissByKey(NO_KEY_AT_ALL);
      dismissByKey(NO_PREFERRED_KEY);
      return;
    }

    const link = {
      url: "/app/settings?tab=ai",
      label: t.settings?.manageAiKeys || "Go to Settings",
    };

    if (!hasAnyKey) {
      // No key anywhere — the merchant must set one up first.
      // Clear the more specific warning if it was previously shown.
      dismissByKey(NO_PREFERRED_KEY);
      showInfoBox(
        t.settings?.noApiKeyAtAllDescription ||
          "To use AI features, you first need to add an API key for an AI provider.",
        "warning",
        t.settings?.noApiKeyAtAll || "No AI API key set up yet",
        link,
        NO_KEY_AT_ALL,
      );
    } else {
      // Keys exist, just not for the preferred provider.
      dismissByKey(NO_KEY_AT_ALL);
      const providerName = getProviderDisplayName(aiSettings.preferredProvider as AIProvider);
      const message = t.settings?.preferredProviderNoKey?.replace("{provider}", providerName) ||
        `No ${providerName} API key. Please add in Settings.`;
      showInfoBox(message, "warning", t.settings?.noApiKeyConfigured || "No API Key", link, NO_PREFERRED_KEY);
    }
  }, [aiSettings, t, showInfoBox, dismissByKey]);

  return (
    <AppErrorBoundary>
      <InitialSyncBanner />
      {/* Persistent navigation: mounted once per app lifecycle here in the
          layout route so it survives sibling navigation instead of being
          remounted on every sub-page. Only the <Outlet /> content swaps.
          ContentTypeNavigation returns null on non-content pages. */}
      <div
        className="app-shell"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "var(--app-shell-height)",
          // Keep the app clear of the bar the Shopify mobile app draws across
          // the bottom (see --app-bottom-inset). Shrinking the SHELL rather
          // than padding the scrolled content is what makes this work for the
          // fixed-frame routes too: the editor and the .app-page-content pages
          // scroll INSIDE a frame, so the frame itself has to end above the
          // bar — trailing padding on the page content would never reach them.
          // The reserve is its own variable so a route that already ends clear
          // of the bar can opt out (see .app-shell:has(.seo-layout)).
          paddingBottom: "var(--app-shell-bottom-reserve, var(--app-bottom-inset))",
          boxSizing: "border-box",
        }}
      >
        <MainNavigation />
        <ContentTypeNavigation />
        {/* Fills the space below the (in-flow) nav bars. overflowY:auto makes
            this the scroll container, so document-flow routes (settings/tasks)
            scroll here while the nav stays pinned above, and fixed-frame editor
            routes (height:100%) fit exactly without a stray document scroll. */}
        <main style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Outlet />
        </main>
      </div>
    </AppErrorBoundary>
  );
}

export default function App() {
  const { appLanguage, subscriptionPlan, seoTitleSuffix, seoLimits, newFeaturesEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider i18n={{}}>
      <I18nProvider locale={appLanguage}>
        <PlanProvider plan={subscriptionPlan} newFeaturesEnabled={newFeaturesEnabled}>
          <SeoSettingsProvider seoTitleSuffix={seoTitleSuffix ?? ""} seoLimits={seoLimits ?? null}>
          <InfoBoxProvider>
            <TaskCountProvider>
            <NavigationHeightProvider>
              <ItemSelectorProvider>
                <SidebarPanelProvider>
                <AltTextOpsProvider>
                  <ConfirmProvider>
                    <AppContent />
                  </ConfirmProvider>
                </AltTextOpsProvider>
                </SidebarPanelProvider>
              </ItemSelectorProvider>
            </NavigationHeightProvider>
            </TaskCountProvider>
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

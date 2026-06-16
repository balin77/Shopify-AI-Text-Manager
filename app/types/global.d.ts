/**
 * Global type declarations for the Shopify app
 */

// Shopify App Bridge global interface
interface Window {
  shopify?: {
    navigate: (path: string) => void;
    idToken?: string;
    /**
     * Native App Bridge Save Bar API. Controls the `ui-save-bar` web component
     * rendered above the embedded app. Required for "Built for Shopify".
     * See https://shopify.dev/docs/api/app-bridge-library/apis/save-bar
     */
    saveBar?: {
      show: (id: string) => Promise<void> | void;
      hide: (id: string) => Promise<void> | void;
      leaveConfirmation: () => Promise<void>;
    };
    [key: string]: any;
  };
  /**
   * Public runtime config injected by root.tsx. Only populated in real
   * production (APP_ENV === "production" + SENTRY_DSN set). Never contains
   * secrets.
   */
  ENV?: {
    SENTRY_DSN?: string;
    SENTRY_CLIENT_SAMPLE_RATE?: string;
    SENTRY_TRACES_SAMPLE_RATE?: string;
    SENTRY_ENVIRONMENT?: string;
    SENTRY_RELEASE?: string;
  };
}

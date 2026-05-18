/**
 * Global type declarations for the Shopify app
 */

// Shopify App Bridge global interface
interface Window {
  shopify?: {
    navigate: (path: string) => void;
    idToken?: string;
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

/**
 * Sentry — browser-side error tracking.
 *
 * The APP_ENV === "production" gate is enforced upstream: root.tsx only writes
 * SENTRY_DSN into window.ENV in real production. So in dev/staging
 * window.ENV.SENTRY_DSN is simply absent and initSentryClient() is a no-op.
 *
 * Browser errors are captured in full (the user's goal: find merchant errors),
 * but the known Shopify Admin iframe / preload noise is hard-filtered so it
 * does not consume the shared free-tier quota. The filter strings are kept in
 * sync with the console-noise suppression in entry.client.tsx.
 */

import * as Sentry from '@sentry/react';
import { scrubEvent, scrubBreadcrumb } from '~/utils/sentry-scrub.cjs';

let initialized = false;

/**
 * Known third-party / Shopify Admin noise that must never reach Sentry.
 * Mirrors the suppression list in app/entry.client.tsx.
 */
const IGNORE_ERRORS = [
  'preloaded using link preload but not used',
  'CriticalApps',
  'deprecated parameters for the initialization',
  // App Bridge iframe navigation aborts — expected, not bugs.
  'ResizeObserver loop',
  'Non-Error promise rejection captured',
];

export function initSentryClient(): void {
  if (initialized) return;
  const env = typeof window !== 'undefined' ? window.ENV : undefined;
  if (!env?.SENTRY_DSN) return; // not real production → no-op
  initialized = true;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.SENTRY_RELEASE || undefined,
    // Full capture by default; tune down via SENTRY_CLIENT_SAMPLE_RATE if volume grows.
    sampleRate: Number(env.SENTRY_CLIENT_SAMPLE_RATE || '1.0'),
    // No performance tracing / no Session Replay on the free plan (env-tunable).
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || '0'),
    sendDefaultPii: false,
    ignoreErrors: IGNORE_ERRORS,
    denyUrls: [/cdn\.shopify\.com/i, /app-bridge\.js/i],
    // Review B2: the client previously had NO scrubbing at all. Use the exact
    // same shared redaction as the server — the embedded-app URL carries
    // id_token/hmac/shop, and console breadcrumbs leak the same.
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

/** Re-export so error boundaries can report without importing the SDK directly. */
export { Sentry };

/**
 * Sentry — server-side error tracking.
 *
 * Hard preconditions (see docs/plan): Sentry only initializes and captures when
 *   process.env.APP_ENV === "production"  AND  process.env.SENTRY_DSN is set.
 * Otherwise every function here is a complete no-op — the dev/staging
 * environment (same code, APP_ENV !== "production") produces zero events even
 * if a DSN is accidentally present.
 *
 * Free-tier strategy: no tracing/replay by default (env-tunable), and expected
 * 4xx SafeErrors are filtered out — they are normal user behaviour, not bugs,
 * and would burn the shared 5k/month quota instantly.
 *
 * Scale-up = env vars only, no code change:
 *   SENTRY_TRACES_SAMPLE_RATE, SENTRY_ENVIRONMENT, SENTRY_RELEASE
 */

import * as Sentry from '@sentry/node';

let initialized = false;

/**
 * Duck-typed check for a SafeError with a 4xx status. We intentionally do NOT
 * import SafeError from error-handler.ts: error-handler.ts calls
 * captureServerError() from this module, so importing back would create a
 * circular dependency. A structural check is robust and avoids it.
 */
function isExpected4xx(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'SafeError' &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
    (error as { statusCode: number }).statusCode < 500
  );
}

/**
 * The single source of truth for whether Sentry is active.
 * Shared conceptually with the client path (root.tsx only emits the DSN to
 * window.ENV under the same condition).
 */
export function sentryEnabled(): boolean {
  return process.env.APP_ENV === 'production' && !!process.env.SENTRY_DSN;
}

/** Keys whose values must never leave the server (case-insensitive substring match). */
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|api[-_]?key|x-shopify|email|access[-_]?token|refresh[-_]?token|encryption)/i;

/**
 * Recursively redact anything that looks sensitive. Mirrors the "NIEMALS
 * loggen" list from docs/LOGGING_GUIDE.md so Sentry never receives tokens,
 * cookies, Shopify headers, emails, etc.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Initialize the Sentry Node SDK. Safe to call multiple times (idempotent);
 * a no-op unless sentryEnabled().
 */
export function initSentryServer(): void {
  if (initialized || !sentryEnabled()) return;
  initialized = true;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Default 0 → no performance/tracing volume on the free plan. Env-tunable.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        if (event.request.headers) {
          event.request.headers = scrub(event.request.headers) as Record<string, string>;
        }
        if (event.request.data) {
          event.request.data = scrub(event.request.data);
        }
        if (event.request.cookies) {
          event.request.cookies = '[redacted]' as unknown as Record<string, string>;
        }
      }
      if (event.contexts) {
        event.contexts = scrub(event.contexts) as typeof event.contexts;
      }
      if (event.extra) {
        event.extra = scrub(event.extra) as typeof event.extra;
      }
      return event;
    },
  });
}

/**
 * Report an unexpected server error to Sentry.
 *
 * No-op unless sentryEnabled(). Expected 4xx SafeErrors (validation, auth,
 * notFound, rateLimit — statusCode < 500) are intentionally skipped: they are
 * normal user behaviour, not bugs, and must not consume the error quota.
 */
export function captureServerError(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryEnabled()) return;

  if (isExpected4xx(error)) return;

  const shop =
    context && typeof context['shop'] === 'string' ? (context['shop'] as string) : undefined;

  Sentry.withScope((scope) => {
    if (shop) {
      scope.setTag('shop', shop);
    }
    if (context) {
      scope.setContext('app', scrub(context) as Record<string, unknown>);
    }
    if (error instanceof Error) {
      Sentry.captureException(error);
    } else {
      Sentry.captureMessage(typeof error === 'string' ? error : 'Non-Error thrown', 'error');
    }
  });
}

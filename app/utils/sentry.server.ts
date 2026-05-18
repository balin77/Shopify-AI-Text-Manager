/**
 * Sentry — server-side error tracking.
 *
 * Hard preconditions: Sentry only initializes and captures when
 *   process.env.APP_ENV === "production"  AND  process.env.SENTRY_DSN is set.
 * Otherwise every function here is a complete no-op — the dev/staging
 * environment (same code, APP_ENV !== "production") produces zero events even
 * if a DSN is accidentally present.
 *
 * Free-tier strategy (DELIBERATE — kept regardless of review pressure):
 *  - no tracing/replay by default (env-tunable)
 *  - expected 4xx SafeErrors are filtered out (normal user behaviour, not bugs)
 *  - noisy Console/Http breadcrumbs dropped (also shrinks every payload)
 *
 * Scrubbing (review B1/B2/H3/H6) and the gate (review H2) live in the shared
 * CommonJS module sentry-scrub.cjs so server.js (pre-build, require) and this
 * module use byte-identical redaction — no drift, no unscrubbed startup window.
 */

import * as Sentry from '@sentry/node';
import {
  sentryEnabled as sharedSentryEnabled,
  scrubEvent,
  scrubBreadcrumb,
  scrubValue,
} from '~/utils/sentry-scrub.cjs';

let initialized = false;

/**
 * Duck-typed check for a SafeError with a 4xx status. We intentionally do NOT
 * import SafeError from error-handler.ts: error-handler.ts calls
 * captureServerError() from this module, so importing back would create a
 * circular dependency. A structural check is robust and avoids it.
 *
 * REVIEW R3 — DELIBERATE DECISION, DO NOT "FIX":
 * The reviewer suggested also skipping generic Errors whose message gets
 * heuristically categorized to a 4xx by error-handler.ts. We intentionally do
 * NOT do that. categorizeError() is a fuzzy string match — a real bug whose
 * message merely contains "invalid"/"not found" would then be silently
 * dropped, directly defeating the stated goal "User-Fehler schnell
 * identifizieren". Only an *explicit* SafeError with statusCode < 500 is a
 * truly expected outcome. The (small) extra quota cost of occasionally
 * reporting a heuristic-4xx generic Error is the accepted price for not
 * blinding ourselves to genuine bugs.
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

/** Single source of truth for whether Sentry is active (shared with server.js). */
export function sentryEnabled(): boolean {
  return sharedSentryEnabled();
}

/**
 * Initialize the Sentry Node SDK. Idempotent and a no-op unless
 * sentryEnabled(). If server.js already created a client (it initializes early
 * to catch build-load failures, with the SAME shared beforeSend), we adopt it
 * instead of calling Sentry.init() a second time — review R2: a double init in
 * v8 creates two clients/integration sets.
 */
export function initSentryServer(): void {
  if (initialized || !sentryEnabled()) return;
  initialized = true;

  // R2: server.js may have initialized first (same scrub) — don't double-init.
  if (Sentry.getClient()) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Default 0 → no performance/tracing volume on the free plan. Env-tunable.
    // NOTE (review R4): with tracesSampleRate>0 the SDK still works for error
    // capture, but full OTel auto-instrumentation needs `node --import` (see
    // .env.production.template). Error tracking — our only goal here — does not.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
    sendDefaultPii: false,
    // Drop, in order:
    //  - OnUncaughtException (R1): its fatal handler would exit the process
    //    despite server.js's own non-exiting handler.
    //  - Console (B2): console.* breadcrumbs are pure PII/noise on free tier.
    //  - LocalVariables/LocalVariablesAsync (RISIKO): attaches local variable
    //    VALUES (decrypted keys/tokens/PII at crash time) to stack frames.
    //    Disabling is also payload-shrinking → free-tier friendly. scrubEvent
    //    additionally scrubs frame.vars as defense-in-depth.
    integrations: (defaults) =>
      defaults.filter(
        (i) =>
          i.name !== 'OnUncaughtException' &&
          i.name !== 'Console' &&
          i.name !== 'LocalVariables' &&
          i.name !== 'LocalVariablesAsync',
      ),
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

/**
 * Report an unexpected server error to Sentry.
 *
 * No-op unless sentryEnabled(). Expected 4xx SafeErrors (validation, auth,
 * notFound, rateLimit — statusCode < 500) are intentionally skipped: they are
 * normal user behaviour, not bugs, and must not consume the error quota.
 * (See the R3 note on isExpected4xx for why the filter is intentionally tight.)
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
      // Pre-scrub here too; beforeSend is the authoritative second pass.
      scope.setContext('app', scrubValue(context) as Record<string, unknown>);
    }
    if (error instanceof Error) {
      Sentry.captureException(error);
    } else {
      // Goes through beforeSend → scrubEvent, so a PII-bearing string throw is
      // redacted before transport (review H6).
      Sentry.captureMessage(typeof error === 'string' ? error : 'Non-Error thrown', 'error');
    }
  });
}

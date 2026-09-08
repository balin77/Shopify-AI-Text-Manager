import { PassThrough } from "stream";
import type { EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import { addDocumentResponseHeaders } from "./shopify.server";
import { syncScheduler } from "./services/sync-scheduler.service";
import { ShopReaperService } from "../src/services/shop-reaper.service";
import { GscAutoSyncService } from "./services/seo/gsc-auto-sync.service";
import { LlmsAutoRefreshService } from "./services/seo/llms-auto-refresh.service";
import { IndexNowAutoSubmitService } from "./services/seo/index-now-auto-submit.service";
import { SeoAuditAutoRunService } from "./services/seo/audit-auto-run.service";
import { SeoCrawlAutoRunService } from "./services/seo/crawl-auto-run.service";
import { logger } from "./utils/logger.server";
import { initSentryServer, captureServerError } from "./utils/sentry.server";

// No-op unless APP_ENV === "production" && SENTRY_DSN set. Initialized once.
initSentryServer();

const ABORT_DELAY = 5000;

/**
 * Flatten an unknown throw into fields winston can actually print.
 *
 * The console transport ends with `JSON.stringify(meta)`, and an `Error`'s
 * `message`/`stack` are NON-ENUMERABLE — so `logger.error(msg, { error })`
 * serialises to `{"error":{}}`. Seven days of production logs carried 62 of
 * those: an error reported, at error level, with its content removed. Anything
 * logging a caught value here goes through this.
 */
function describeError(error: unknown): Record<string, unknown> {
  // This runs inside handlers react-router calls WITHOUT a guard of their own
  // (`catch (e) { handleError(e); return new Response(null, { status: 500 }) }`),
  // and inside React's render callbacks. A throw in here would therefore turn a
  // handled 500 into an unhandled rejection — i.e. the logger would break the
  // very path it exists to report on. `JSON.stringify` throws on a BigInt and
  // on a circular object, and `String(x)` throws for a null-prototype object or
  // a throwing `toString`, so the whole body is guarded.
  try {
    if (error instanceof Response) {
      return { error: `Response ${error.status} ${error.statusText}`.trim() };
    }
    if (error instanceof Error) {
      return {
        error: error.message || error.name,
        errorName: error.name,
        stack: error.stack,
        // An Error cause keeps its own stack; anything else is stringified.
        ...(error.cause instanceof Error
          ? { cause: error.cause.message, causeStack: error.cause.stack }
          : error.cause !== undefined
            ? { cause: String(error.cause) }
            : {}),
      };
    }
    if (typeof error === "string") return { error };
    // `JSON.stringify` returns undefined (not a string) for undefined, a
    // function and a symbol, which is what the fallback is for.
    return { error: JSON.stringify(error) ?? String(error) };
  } catch {
    return { error: "<unserialisable error>" };
  }
}

/**
 * Errors already logged and already sent to Sentry by a render callback.
 *
 * `onShellError` reports and then `reject()`s, and react-router catches that
 * rejection and hands it straight to `handleError` — so one broken shell was
 * reported TWICE, and up to four times when react-router's second (error-page)
 * render also failed.
 *
 * Keyed by error AND request, not by error alone: an app that throws a shared,
 * module-scope error object would otherwise be reported once and then silently
 * suppressed on every future request, for the lifetime of the process. A mark
 * only suppresses the SECOND report of the SAME throw within the SAME request.
 * WeakMap on both sides, so neither an error nor a request is kept alive.
 */
const reportedFor = new WeakMap<object, WeakSet<Request>>();

function markReported(error: unknown, request: Request): void {
  if (error === null || typeof error !== "object") return;
  let seen = reportedFor.get(error);
  if (!seen) {
    seen = new WeakSet<Request>();
    reportedFor.set(error, seen);
  }
  seen.add(request);
}

function wasReported(error: unknown, request: Request): boolean {
  if (error === null || typeof error !== "object") return false;
  return reportedFor.get(error)?.has(request) ?? false;
}

/**
 * True when the client hung up mid-response rather than anything failing here.
 *
 * React registers its OWN `'close'` handler on the destination inside `pipe()`
 * and aborts the render with this exact message when the consumer goes away
 * (react-dom 18.3.1; the string is identical in the minified production build).
 * That is what most of the scanner traffic does — read the headers of a 404,
 * drop the connection — and it is the real source of the
 * `Post-shell render error {"error":{}}` pairs in the production logs, NOT the
 * dangling abort timer that also existed. Matching on a message is coupled to
 * the React version; if it ever stops matching, the entry is logged at error
 * level again, which is noisy but not wrong.
 */
const CLIENT_HANGUP_MESSAGES = new Set([
  "The destination stream closed early.",
  "The destination stream errored while writing data.",
]);

/** "404 Not Found", or just "404" when the framework left the text empty. */
function describeStatus(error: { status: number; statusText: string }): string {
  return error.statusText ? `${error.status} ${error.statusText}` : String(error.status);
}

function isClientHangup(error: unknown, request: Request): boolean {
  if (request.signal.aborted) return true;
  return error instanceof Error && CLIENT_HANGUP_MESSAGES.has(error.message);
}

/**
 * React Router's server-side error hook (`ServerEntryModule.handleError`).
 *
 * Without it the framework falls back to a bare `console.error(error)` for
 * every error it handles, including the routing 404. That is what filled the
 * production logs: a public app gets a constant stream of WordPress/credential
 * scanners (`POST /blog/wp-json/batch/v1`, `POST /login`, `/wp/v2/...`), each
 * one printing "Error: No route matches URL" plus a seven-frame react-router
 * stack that says nothing about this app. Real errors were buried in it.
 *
 * So: an aborted request is not an error (the client hung up — React Router's
 * own default skips these too), and an expected route response is not an error
 * either. 4xx `ErrorResponse`s are logged once at warn WITHOUT a stack; 5xx and
 * genuine throws keep the full stack and go to Sentry.
 */
export function handleError(
  error: unknown,
  { request }: { request: Request },
): void {
  // The client went away mid-flight. Nothing failed on our side.
  if (request.signal.aborted) return;

  // A shell error is reported by `onShellError` and then re-thrown, and
  // react-router hands that same object here. Report it once.
  if (wasReported(error, request)) return;

  const url = new URL(request.url);
  const base = { context: "EntryServer", method: request.method, pathname: url.pathname };

  if (isRouteErrorResponse(error)) {
    // The ORIGINAL throw — the thing carrying a stack and a route id — sits in
    // a field react-router marks `private`; `data` is usually just the rendered
    // message. Its own default handler reaches for the same field behind a
    // `@ts-expect-error`, so read it structurally rather than widen the type.
    const original = (error as unknown as { error?: unknown }).error ?? error.data;

    if (error.status < 500) {
      // Routine traffic, not a fault: 404 for a path we do not serve. One line,
      // no stack, never sent to Sentry — it is the same event a few thousand
      // times a week and the quota is finite.
      //
      // But NOT every 4xx here is traffic. A 405 ("Route X does not have an
      // action, but you are trying to submit to it") and a 400 ("serverAction()
      // on a route that does not have a server action") are bugs in THIS app,
      // and the route id is the entire diagnosis — so anything that is not a
      // plain 404 carries its message through.
      logger.warn(`Unhandled route request (${describeStatus(error)})`, {
        ...base,
        ...(error.status === 404 ? {} : describeError(original)),
      });
      markReported(error, request);
      return;
    }

    const described = describeError(original);
    logger.error(`Route error response (${error.status})`, { ...base, ...described });
    // `captureServerError` falls back to a bare "Non-Error thrown" message for
    // anything that is not an Error, which would drop the status and the body.
    // A resource route's ErrorResponse often carries a plain string, so give
    // Sentry something that still names what happened. The text comes from
    // `described` and never from `String(original)`: `original` is whatever a
    // route threw, and stringifying a null-prototype object (or one with a
    // throwing `toString`) raises — here, OUTSIDE describeError's guard, which
    // would turn a handled 500 into an unhandled rejection. `described.error`
    // is always a string, worst case "<unserialisable error>".
    captureServerError(
      original instanceof Error
        ? original
        : new Error(`Route error ${describeStatus(error)}: ${described.error}`),
      { ...base, phase: "route-response" },
    );
    markReported(error, request);
    return;
  }

  logger.error("Unhandled server error", { ...base, ...describeError(error) });
  captureServerError(error, { ...base, phase: "request" });
  markReported(error, request);
}

// R4-C1: stop the producers we own (sync scheduler + shop reaper) on
// shutdown, but DO NOT call process.exit() here. server.js's
// gracefulShutdown() is the single shutdown coordinator: it closes the HTTP
// server, stops the cleanup services, DRAINS the AI queue (~8s) and
// $disconnect()s Prisma, then exits (with a 10s force-exit safety net).
// A process.exit(0) in this listener fired in the same signal tick and
// killed the process before that drain/disconnect could finish, silently
// voiding the queue-drain / refund / recovery guarantees.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received - stopping sync schedulers (exit owned by server.js)', { context: 'EntryServer' });
  syncScheduler.stopAll();
  ShopReaperService.getInstance().stop();
  GscAutoSyncService.getInstance().stop();
  LlmsAutoRefreshService.getInstance().stop();
  IndexNowAutoSubmitService.getInstance().stop();
  SeoAuditAutoRunService.getInstance().stop();
  SeoCrawlAutoRunService.getInstance().stop();
});

process.on('SIGINT', () => {
  logger.info('SIGINT received - stopping sync schedulers (exit owned by server.js)', { context: 'EntryServer' });
  syncScheduler.stopAll();
  ShopReaperService.getInstance().stop();
  GscAutoSyncService.getInstance().stop();
  LlmsAutoRefreshService.getInstance().stop();
  IndexNowAutoSubmitService.getInstance().stop();
  SeoAuditAutoRunService.getInstance().stop();
  SeoCrawlAutoRunService.getInstance().stop();
});

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  const url = new URL(request.url);
  logger.debug('Incoming request', {
    context: 'EntryServer',
    method: request.method,
    pathname: url.pathname,
    statusCode: responseStatusCode,
    headers: Object.fromEntries(request.headers.entries())
  });

  addDocumentResponseHeaders(request, responseHeaders);

  // Security headers
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "SAMEORIGIN");
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    responseHeaders.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAbortTimer = () => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
        abortTimer = undefined;
      }
    };
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        onShellReady() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          logger.debug('Shell ready, sending response', {
            context: 'EntryServer',
            statusCode: responseStatusCode
          });

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          // 'close' fires both when React has finished writing and when the
          // stream is destroyed because the client hung up. Either way the
          // render is over and the deadline has nothing left to guard.
          body.on("close", clearAbortTimer);

          pipe(body);
        },
        onShellError(error: unknown) {
          clearAbortTimer();
          // React calls `onError` for EVERY error it renders through and only
          // then `onShellError` for the one that sank the shell, and
          // react-router catches the rejection below and hands the SAME object
          // to `handleError`. So one broken shell passed three reporters. The
          // first one to see it reports it; the rest recognise the mark. This
          // branch normally does nothing but reject.
          if (!wasReported(error, request)) {
            logger.error('Shell error', {
              context: 'EntryServer',
              pathname: url.pathname,
              ...describeError(error),
            });
            captureServerError(error, { context: 'EntryServer', phase: 'shell', pathname: url.pathname });
            markReported(error, request);
          }
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;

          // Most of what reached this callback in production was a scanner
          // reading the headers of a 404 and dropping the connection: React
          // then aborts the render itself and reports it here. Nothing failed,
          // so it is a warn, it carries no stack, and it never reaches Sentry.
          if (isClientHangup(error, request)) {
            logger.warn('Render aborted (client disconnected)', {
              context: 'EntryServer',
              pathname: url.pathname,
              postShell: shellRendered,
              // No stack — but name the reason, so a misfire of the
              // message-matching above is diagnosable instead of silent.
              reason: error instanceof Error ? error.message : undefined,
            });
            markReported(error, request);
            return;
          }

          // react-router reports a loader throw through `handleError` and THEN
          // renders; `boundary.error` re-throws anything that is not an
          // ErrorResponse, so the same object arrives here a second time — and
          // react-router re-renders once more after a shell failure, which is a
          // third and fourth pass. Whoever saw it first owns the report.
          if (wasReported(error, request)) return;

          // One line per error, not two. This used to log 'Render error' and
          // then 'Post-shell render error' for the same throw, which is why the
          // production logs showed the pair 31 times each; `shellRendered` is
          // now a field rather than a second message.
          logger.error('Render error', {
            context: 'EntryServer',
            pathname: url.pathname,
            postShell: shellRendered,
            ...describeError(error),
          });
          captureServerError(error, {
            context: 'EntryServer',
            phase: shellRendered ? 'post-shell-render' : 'render',
            pathname: url.pathname,
          });
          // This callback runs FIRST for a shell failure, so claiming the error
          // here is what keeps `onShellError` and `handleError` quiet.
          markReported(error, request);
        },
      }
    );

    // The render deadline. It MUST be cleared: left dangling it kept a timer
    // and its closure alive for five seconds past EVERY request, including the
    // ones that had long since finished. (It did not, on its own, produce the
    // `{}` errors in the logs — `abort()` on a completed render iterates an
    // empty task list and calls nothing. Those come from React's own
    // destination-'close' handler; see isClientHangup.)
    //
    // Clearing it on the body's 'close' is safe in both directions: React ends
    // the stream when it is done, and if the client hangs up first React
    // installs its own 'close'→abort handler inside `pipe()`, so a stalled
    // render is still torn down without this timer.
    abortTimer = setTimeout(abort, ABORT_DELAY);
  });
}

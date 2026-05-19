import { PassThrough } from "stream";
import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToPipeableStream } from "react-dom/server";
import { addDocumentResponseHeaders } from "./shopify.server";
import { syncScheduler } from "./services/sync-scheduler.service";
import { ShopReaperService } from "../src/services/shop-reaper.service";
import { logger } from "./utils/logger.server";
import { initSentryServer, captureServerError } from "./utils/sentry.server";

// No-op unless APP_ENV === "production" && SENTRY_DSN set. Initialized once.
initSentryServer();

const ABORT_DELAY = 5000;

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
});

process.on('SIGINT', () => {
  logger.info('SIGINT received - stopping sync schedulers (exit owned by server.js)', { context: 'EntryServer' });
  syncScheduler.stopAll();
  ShopReaperService.getInstance().stop();
});

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
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
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
        abortDelay={ABORT_DELAY}
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

          pipe(body);
        },
        onShellError(error: unknown) {
          logger.error('Shell error', { context: 'EntryServer', error });
          captureServerError(error, { context: 'EntryServer', phase: 'shell', pathname: url.pathname });
          reject(error);
        },
        onError(error: unknown) {
          logger.error('Render error', { context: 'EntryServer', error });
          responseStatusCode = 500;
          if (shellRendered) {
            logger.error('Post-shell render error', { context: 'EntryServer', error });
          }
          captureServerError(error, { context: 'EntryServer', phase: 'render', pathname: url.pathname });
        },
      }
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

import { PassThrough } from "stream";
import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToPipeableStream } from "react-dom/server";
import { addDocumentResponseHeaders } from "./shopify.server";
import { syncScheduler } from "./services/sync-scheduler.service";
import { logger } from "./utils/logger.server";

const ABORT_DELAY = 5000;

// Graceful shutdown handlers for sync scheduler
process.on('SIGTERM', () => {
  logger.info('SIGTERM received - stopping all sync schedulers', { context: 'EntryServer' });
  syncScheduler.stopAll();
  logger.info('All sync schedulers stopped', { context: 'EntryServer' });
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received - stopping all sync schedulers', { context: 'EntryServer' });
  syncScheduler.stopAll();
  logger.info('All sync schedulers stopped', { context: 'EntryServer' });
  process.exit(0);
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
          reject(error);
        },
        onError(error: unknown) {
          logger.error('Render error', { context: 'EntryServer', error });
          responseStatusCode = 500;
          if (shellRendered) {
            logger.error('Post-shell render error', { context: 'EntryServer', error });
          }
        },
      }
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

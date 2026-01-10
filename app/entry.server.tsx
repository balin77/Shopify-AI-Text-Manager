import { PassThrough } from "stream";
import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToPipeableStream } from "react-dom/server";
import { addDocumentResponseHeaders } from "./shopify.server";

const ABORT_DELAY = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  const url = new URL(request.url);
  console.log(`📥 [ENTRY.SERVER] Request: ${request.method} ${url.pathname}`);
  console.log(`🔍 [ENTRY.SERVER] Status Code: ${responseStatusCode}`);
  console.log(`🔍 [ENTRY.SERVER] Headers:`, Object.fromEntries(request.headers.entries()));

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

          console.log(`✅ [ENTRY.SERVER] Shell ready, sending response with status ${responseStatusCode}`);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          console.error("❌ [ENTRY.SERVER] Shell error:", error);
          reject(error);
        },
        onError(error: unknown) {
          console.error("❌ [ENTRY.SERVER] Render error:", error);
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        },
      }
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

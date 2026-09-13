/**
 * The tail of app.tsx's ErrorBoundary: what `boundary.error` from
 * `@shopify/shopify-app-react-router` renders for a thrown route response —
 * recognised by SHAPE instead of by class name — and `boundary.error` itself
 * for everything else.
 *
 * The library tests `error.constructor.name === 'ErrorResponseImpl'`. That holds
 * on the server, where react-router is loaded unbundled, and FAILS in the
 * browser, where Vite minifies the class (the client bundle reads
 * `Ge=class{constructor(e,t,r,a=!1){this.status=e,this.statusText=t||"",...`).
 * So for every Response an `/app` loader throws — the 400 for a tampered `host`
 * parameter, a 5xx, the 200 App Bridge bounce — the server rendered app.tsx's
 * boundary, while the client saw `boundary.error` re-throw, fell through to
 * root.tsx's boundary and rendered a different tree: a hydration mismatch
 * (#418) and a page that swapped itself out after load.
 *
 * `isRouteErrorResponse` is react-router's own structural check (status,
 * statusText, internal, data) and accepts the real decoded instances on both
 * hydration and client navigation. The markup is the library's, byte for byte,
 * so the server and the client produce one tree.
 *
 * The order lives HERE, not in app.tsx, so that it is tested: the structural
 * check has to run before `boundary.error`, which re-throws what it does not
 * recognise.
 */
import { useEffect } from "react";
import { isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Sentry } from "~/utils/sentry.client";

export function routeErrorResponseBoundary(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />;
  }
  return boundary.error(error);
}

/**
 * Report a 5xx route response to Sentry. Nothing else does: react-router never
 * hands a thrown Response to `handleError` on the server, and root.tsx's
 * boundary — which reported 5xx on the client — only ever saw these through the
 * broken re-throw above. A 4xx is traffic, not a fault, and is not reported.
 *
 * Wrapped in an `Error` whose message names the status, the way
 * entry.server.tsx does it: handed the plain response object, Sentry titles
 * every event "Object captured as exception with keys: …" and groups all 5xx
 * into one issue with no status in sight. `Sentry` is `undefined` on the server
 * (a `*.client` module), so this is a no-op there.
 */
export function reportRouteErrorResponse(error: unknown): void {
  if (!isRouteErrorResponse(error) || error.status < 500) return;
  const status = error.statusText ? `${error.status} ${error.statusText}` : String(error.status);
  const body = typeof error.data === "string" ? error.data.slice(0, 200) : "";
  Sentry?.captureException(new Error(body ? `Route error ${status}: ${body}` : `Route error ${status}`));
}

/**
 * `reportRouteErrorResponse` from an effect, ONCE per error object. The
 * boundary re-renders on every router state change while it is on screen, so a
 * report in the render body fired again for each link the merchant clicked on
 * a 5xx page. Effects also never run during the server render.
 */
export function useReportRouteErrorResponse(error: unknown): void {
  useEffect(() => {
    reportRouteErrorResponse(error);
  }, [error]);
}

import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const authResult = await authenticate.admin(request);

    // If we have a redirect, return it
    if ('redirect' in authResult && authResult.redirect) {
      return authResult.redirect;
    }

    // If we have a session, redirect to the app.
    //
    // IMPORTANT: Always forward `shop` and `host` query params to /app.
    //
    // Why this matters:
    // When a user opens the Shopify Admin URL directly in a fresh browser
    // (e.g. https://admin.shopify.com/store/.../apps/contentpilot/app/products),
    // the embedded app has no session yet and triggers the OAuth flow.
    // After OAuth completes, this redirect must include `shop` and `host` so
    // that authenticate.admin() on the next request can look up the offline
    // session in the database.
    //
    // Without these params, the SDK cannot identify the shop and the request
    // fails — because session cookies are blocked in cross-origin iframes by
    // modern browsers (Chrome, Safari ITP), so the SDK cannot fall back to a
    // cookie-based session lookup. The result is a 404 shown to the user.
    // With these params, the SDK finds the session by shop name in the DB
    // and the app loads correctly on first visit, not just after a reload.
    if ('session' in authResult && authResult.session) {
      const url = new URL(request.url);
      const shop = url.searchParams.get('shop') || authResult.session.shop;
      const host = url.searchParams.get('host') || '';
      const redirectUrl = host
        ? `/app?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}`
        : `/app?shop=${encodeURIComponent(shop)}`;

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl,
        },
      });
    }

    // This shouldn't happen, but just in case
    logger.warn("[AUTH.$] No session and no redirect - returning OK", { context: "Auth" });
    return new Response("OK", { status: 200 });
  } catch (error) {
    logger.error("[AUTH.$] Error", { context: "Auth", error: error instanceof Error ? error.message : String(error), ...(process.env.NODE_ENV !== 'production' && { stack: error instanceof Error ? error.stack : undefined }) });
    throw error;
  }
};

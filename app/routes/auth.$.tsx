import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  logger.debug("[AUTH.$] Request received", { context: "Auth", url: request.url, method: request.method });

  try {
    logger.debug("[AUTH.$] Authenticating...", { context: "Auth" });
    const authResult = await authenticate.admin(request);

    // If we have a redirect, return it
    if ('redirect' in authResult && authResult.redirect) {
      const redirect = authResult.redirect;
      if (redirect instanceof Response && 'headers' in redirect) {
        logger.debug("[AUTH.$] Redirect response", { context: "Auth", location: redirect.headers.get("Location") });
      }
      return redirect;
    }

    // If we have a session, redirect to the app
    if ('session' in authResult && authResult.session) {
      const session = authResult.session;
      logger.debug("[AUTH.$] Session found, redirecting to /app", { context: "Auth", shop: session.shop, sessionId: session.id });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/app`,
        },
      });
    }

    // This shouldn't happen, but just in case
    logger.warn("[AUTH.$] No session and no redirect - returning OK", { context: "Auth" });
    return new Response("OK", { status: 200 });
  } catch (error) {
    logger.error("[AUTH.$] Error", { context: "Auth", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  }
};

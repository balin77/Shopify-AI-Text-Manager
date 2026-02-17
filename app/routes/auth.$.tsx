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

    // If we have a session, redirect to the app
    if ('session' in authResult && authResult.session) {
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
    logger.error("[AUTH.$] Error", { context: "Auth", error: error instanceof Error ? error.message : String(error), ...(process.env.NODE_ENV !== 'production' && { stack: error instanceof Error ? error.stack : undefined }) });
    throw error;
  }
};

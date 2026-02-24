/**
 * API endpoint to clear sessions from database
 * Use this after updating scopes to force re-authentication
 */

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate the request - only logged-in shop admins can clear sessions
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    // Delete all sessions for this shop
    const result = await db.session.deleteMany({
      where: { shop }
    });

    logger.info('[CLEAR-SESSION] Deleted sessions', {
      shop,
      count: result.count
    });

    return json({
      success: true,
      message: `Deleted ${result.count} session(s) for shop ${shop}`,
      count: result.count
    });
  } catch (error) {
    logger.error('[CLEAR-SESSION] Error deleting sessions', {
      error: error instanceof Error ? error.message : String(error)
    });

    return json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete sessions"
    }, { status: 500 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ message: "Use POST to clear sessions." });
};

/**
 * API endpoint to clear sessions from database
 * Use this after updating scopes to force re-authentication
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const shop = formData.get("shop") as string;

    if (!shop) {
      return json({ error: "Shop parameter required" }, { status: 400 });
    }

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

export const loader = async () => {
  return json({
    message: "Use POST to clear sessions. Include 'shop' parameter.",
    example: "curl -X POST /api/clear-session -d 'shop=your-shop.myshopify.com'"
  });
};

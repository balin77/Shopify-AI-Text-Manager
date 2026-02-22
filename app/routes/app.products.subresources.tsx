/**
 * Resource Route for Product Sub-Resources (Options + Metafields)
 *
 * This route handles all sub-resource operations:
 * - Loading translations from Shopify
 * - Saving primary locale values
 * - Saving foreign locale translations
 * - AI translations
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Load AI settings
  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  // Use unified action handler (same as main products route)
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: PRODUCTS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

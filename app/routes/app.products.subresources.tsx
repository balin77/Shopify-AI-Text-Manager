/**
 * Resource Route for Product Sub-Resources (Options + Metafields)
 *
 * This route handles all sub-resource operations:
 * - Loading translations from Shopify
 * - Saving primary locale values
 * - Saving foreign locale translations
 * - AI translations
 */

import { type ActionFunctionArgs, json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return handleUnifiedContentActions(request, admin.graphql);
};

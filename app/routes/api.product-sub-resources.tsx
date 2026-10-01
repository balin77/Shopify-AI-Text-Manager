/**
 * The product editor's option / option-value / metafield translations, as
 * JSON.
 *
 * `useProductSubResources` sends these requests with a plain `fetch` rather
 * than its fetcher -- several translates can run at once and each needs its
 * own lifecycle (see `runIndividualTranslate`). It used to post them to
 * `/app/products`, which is a PAGE route: React Router answers a plain POST
 * there with the rendered HTML document, not with the action's JSON. The
 * action ran and wrote everything, but `resp.json()` failed, and since the
 * hook learned to report a failed translate, every successful one showed
 * "translation failed" next to the task's own success message.
 *
 * A resource route (no default export) returns the action's data as JSON.
 * It is the SAME handler the page route calls, with the same config, so the
 * plan, managed-AI and resource checks are the ones `/app/products` applies;
 * only the actions this hook sends by `fetch` are let through, so this does
 * not become a second door to the rest of the product editor's actions.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";
import { getFormString } from "~/utils/form-data.utils";

const SUB_RESOURCE_FETCH_ACTIONS: ReadonlySet<string> = new Set([
  "translateSubResources",
  "translateSubResourceToAllLocales",
  "saveSubResourceTranslations",
]);

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  if (!SUB_RESOURCE_FETCH_ACTIONS.has(getFormString(formData, "action"))) {
    return json({ success: false, error: "Unsupported action" }, { status: 400 });
  }

  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

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

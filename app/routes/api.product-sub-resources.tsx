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

import { makeContentRouteAction } from "~/utils/content-route-action.server";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";

const SUB_RESOURCE_FETCH_ACTIONS: ReadonlySet<string> = new Set([
  "translateSubResources",
  "translateSubResourceToAllLocales",
  "saveSubResourceTranslations",
]);

// Products are in every plan, so the gate is a formality today; it is passed
// anyway so a plan matrix change cannot silently open this door.
export const action = makeContentRouteAction({
  config: PRODUCTS_CONFIG,
  planContentType: "products",
  allowedActions: SUB_RESOURCE_FETCH_ACTIONS,
});

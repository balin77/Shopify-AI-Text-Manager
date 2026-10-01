/**
 * The route action every content editor page shares.
 *
 * Products, collections, pages, blogs, policies, metaobjects and the product
 * sub-resource route each carried the same fifteen lines (authenticate, read
 * the form, load the AI settings, hand over to `handleUnifiedContentActions`)
 * and none of them asked the PLAN: `PlanAccessGate` hides a page the plan does
 * not include, but every action is directly POST-reachable, so a Free shop
 * could still run `updateContent` / `translateAll` on pages, articles or
 * policies. The gate lives here once, next to the boilerplate it guards.
 *
 * The plan is read from `AISettings.subscriptionPlan` — the very column the
 * shell loader (app.tsx) syncs from billing / the dev override and feeds to
 * `PlanProvider`, i.e. what `PlanAccessGate` judges on. Server and UI therefore
 * cannot disagree. A missing row is "free", as everywhere else.
 */

import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { getFormString } from "./form-data.utils";
import { canAccessContentType } from "./planUtils";
import type { ContentType, Plan } from "../config/plans";

/**
 * 403 for a plan that lacks the content type, or null when it is allowed.
 * `actionType` echoes what was posted so the editor lands the refusal on the
 * control that fired it, like the managed-AI refusals do.
 */
export function planGateRefusal(
  plan: string | null | undefined,
  contentType: ContentType,
  formData: FormData,
) {
  if (canAccessContentType((plan || "free") as Plan, contentType)) return null;
  return json(
    { success: false, error: "gated", actionType: getFormString(formData, "action") },
    { status: 403 },
  );
}

export interface ContentRouteActionOptions {
  /** The page's `*_CONFIG` from content-fields.config. */
  config: Parameters<typeof handleUnifiedContentActions>[0]["contentConfig"];
  /** The `contentType` the page's `PlanAccessGate` uses. */
  planContentType?: ContentType;
  /** Refuse any other `action` with 400 (routes that serve a fixed subset). */
  allowedActions?: ReadonlySet<string> | readonly string[];
}

export function makeContentRouteAction({ config, planContentType, allowedActions }: ContentRouteActionOptions) {
  const allowed = allowedActions ? new Set<string>(allowedActions) : null;

  return async (args: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(args.request);
    const formData = await args.request.formData();

    if (allowed && !allowed.has(getFormString(formData, "action"))) {
      return json({ success: false, error: "Unsupported action" }, { status: 400 });
    }

    const { db } = await import("../db.server");
    // One query serves both the gate and the handler.
    const [aiSettings, aiInstructions] = await Promise.all([
      db.aISettings.findUnique({ where: { shop: session.shop } }),
      db.aIInstructions.findUnique({ where: { shop: session.shop } }),
    ]);

    if (planContentType) {
      const refusal = planGateRefusal(aiSettings?.subscriptionPlan, planContentType, formData);
      if (refusal) return refusal;
    }

    return handleUnifiedContentActions({
      admin,
      session,
      formData,
      contentConfig: config,
      db,
      aiSettings,
      aiInstructions,
    });
  };
}

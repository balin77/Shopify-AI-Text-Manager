/**
 * PLAN_CONTENT_CREATION §1.9 / §2.5f — "create like this one".
 *
 * The most common real create is not the blank form, it is "the same as that,
 * but different". For products and collections Shopify does the whole job in
 * one call — variants, options, media and metafields for a product; the
 * publications too for a collection — none of which the create modal knows how
 * to carry. For pages, articles and blogs there is no duplicate mutation, so
 * those are prefilled client-side from the cache and go through the ordinary
 * create path; nothing new is needed server-side for them.
 *
 * ── The part that is NOT like the create path ────────────────────────────────
 * Both duplicate mutations are ASYNCHRONOUS. They answer with a job, and the
 * new object may not be queryable yet — sometimes not even its id. The create
 * flow's promise ("here is your item, it is selected") therefore cannot be
 * kept, and pretending otherwise would produce exactly the failure §1.6 exists
 * to avoid: an item that looks missing, a second click, a duplicate of the
 * duplicate.
 *
 * So this handler reports honestly: `pending: true` plus whatever id Shopify
 * did hand back. The client says "being created" and offers a reload, rather
 * than selecting something that is not there.
 *
 * Duplicates are created as DRAFT (§2.3) — a copy of a live product going live
 * on its own is the one outcome nobody wants.
 */

import { data as json } from "react-router";
import type { ContentActionHandlerContext } from "./alt-text.action";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import { DUPLICATE_COLLECTION, DUPLICATE_PRODUCT } from "~/graphql/content.mutations";
import { isValidShopifyGID } from "~/utils/validation";
import { canAccessContentType, getMaxForResource, isAtLimit, type Plan } from "~/utils/planUtils";
import type { ContentType } from "~/types/content-editor.types";
import { createSpecFor } from "~/config/create-fields.config";

type GraphQLResponse = { data?: any; errors?: Array<{ message: string }> };

function userErrorText(errors: Array<{ field?: string[] | null; message: string }> | undefined): string {
  if (!errors?.length) return "";
  return errors.map((e) => `${e.field?.join(".") ?? ""}: ${e.message}`.trim()).join("; ");
}

/** Only these two have a server-side duplicate; the rest prefill the form. */
const SERVER_DUPLICABLE = new Set(["product", "collection"]);

export async function handleDuplicateContent(ctx: ContentActionHandlerContext, formData: FormData) {
  const { admin, session, db } = ctx;

  const resource = getFormString(formData, "resource");
  const sourceId = getFormString(formData, "sourceId");
  const newTitle = (getFormString(formData, "newTitle") || "").trim();

  if (!SERVER_DUPLICABLE.has(resource)) {
    return json({ success: false, error: `No server-side duplicate for ${resource || "(missing)"}` }, { status: 400 });
  }
  if (!sourceId || !isValidShopifyGID(sourceId)) {
    return json({ success: false, error: "Invalid or missing source id" }, { status: 400 });
  }
  if (!newTitle) {
    return json({ success: false, errorCode: "validation", error: "A title for the copy is required." }, { status: 400 });
  }

  const spec = createSpecFor(resource);
  if (!spec) {
    return json({ success: false, error: `Unknown resource: ${resource}` }, { status: 400 });
  }

  // A duplicate is a create. Both plan gates apply exactly as they do there —
  // otherwise "copy" would be the way around a limit.
  const plan = (ctx.aiSettings?.subscriptionPlan || "free") as Plan;
  if (!canAccessContentType(plan, spec.planContentType as ContentType)) {
    return json(
      { success: false, errorCode: "planContentType", error: `Your plan does not include ${spec.planContentType}.` },
      { status: 403 },
    );
  }
  if (spec.limitResource) {
    const current =
      spec.limitResource === "products"
        ? await db.product.count({ where: { shop: session.shop } })
        : await db.collection.count({ where: { shop: session.shop } });
    if (isAtLimit(plan, spec.limitResource, current)) {
      return json(
        {
          success: false,
          errorCode: "planLimit",
          limitResource: spec.limitResource,
          max: getMaxForResource(plan, spec.limitResource),
          current,
          error: `Plan limit reached for ${spec.limitResource}.`,
        },
        { status: 403 },
      );
    }
  }

  try {
    const graphql = (query: string, variables: Record<string, unknown>) =>
      admin.graphql(query, { variables }).then((r) => r.json() as Promise<GraphQLResponse>);

    if (resource === "product") {
      const response = await graphql(DUPLICATE_PRODUCT, {
        productId: sourceId,
        newTitle,
        // §2.3 — never live by accident, least of all a copy of a live product.
        newStatus: "DRAFT",
        includeImages: true,
      });
      const payload = response.data?.productDuplicate;
      const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
      const newProduct = payload?.newProduct;
      const operation = payload?.productDuplicateOperation;

      // Neither an id NOR a running operation means nothing started.
      if (!newProduct?.id && !operation?.id) {
        return json({ success: false, error: errorText || "Shopify did not start the duplication." }, { status: 400 });
      }

      const done = operation?.status === "COMPLETE";
      return json({
        actionType: "duplicateContent" as const,
        success: true as const,
        resource,
        id: newProduct?.id ?? null,
        title: newProduct?.title ?? newTitle,
        handle: newProduct?.handle ?? null,
        // The honest bit: the copy may still be assembling. The client must
        // not select it and call it done.
        pending: !done,
        operationId: operation?.id ?? null,
      });
    }

    // Collection. `copyPublications` came out of the Phase-0 measurement
    // (§1.2a) and settles the §2.3 "active but invisible" trap for the copy in
    // the same call.
    const response = await graphql(DUPLICATE_COLLECTION, {
      input: { collectionId: sourceId, newTitle, copyPublications: true },
    });
    const payload = response.data?.collectionDuplicate;
    const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
    const collection = payload?.collection;
    const job = payload?.job;

    if (!collection?.id && !job?.id) {
      return json({ success: false, error: errorText || "Shopify did not start the duplication." }, { status: 400 });
    }

    logger.info("[DuplicateContent] Started", {
      context: "DuplicateContent",
      shop: session.shop,
      resource,
      sourceId,
      newId: collection?.id ?? null,
      jobDone: job?.done ?? null,
    });

    return json({
      actionType: "duplicateContent" as const,
      success: true as const,
      resource,
      id: collection?.id ?? null,
      title: collection?.title ?? newTitle,
      handle: collection?.handle ?? null,
      pending: job ? job.done !== true : false,
      operationId: job?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[DuplicateContent] Failed", { context: "DuplicateContent", shop: session.shop, resource, sourceId, error: message });
    return json({ success: false, error: message }, { status: 500 });
  }
}

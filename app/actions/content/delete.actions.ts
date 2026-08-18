/**
 * `deleteContent` — the app's first content delete.
 *
 * Until this existed, an object created here (or anywhere) could only be
 * removed in the Shopify admin, which is what PLAN_CONTENT_CREATION §0.1
 * records and §1.8 works around. It is deliberately ONE write path with TWO
 * entrances:
 *
 *   - the delete button on the item list, for any selected item
 *   - the "undo" button on the post-create box (§1.8), which is the same
 *     delete narrowed to the id this session just created
 *
 * A second, undo-only delete path would have been the easier commit and the
 * worse codebase: two places that must both get the echo rule and the
 * polymorphic cleanup right, and only one of them exercised often enough to
 * notice when it does not.
 *
 * THE ECHO RULE, in the direction that matters here: the local cache is purged
 * only after Shopify hands the deleted id back. Purging first would leave the
 * app blind to an object that still exists in the shop, and the next full sync
 * would quietly resurrect it — the merchant having been told it was gone. The
 * reverse mistake (Shopify deleted it, the cache still has it) self-heals.
 */

import { data as json } from "react-router";
import type { ContentActionHandlerContext } from "./alt-text.action";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import {
  DELETE_ARTICLE,
  DELETE_BLOG,
  DELETE_COLLECTION,
  DELETE_METAOBJECT,
  DELETE_PAGE,
  DELETE_PRODUCT,
} from "~/graphql/content.mutations";
import { purgeContentFromCache, type DeletableResource } from "~/services/content-delete.server";
import { GID_TYPE_BY_RESOURCE, isGidOfResource } from "~/config/create-fields.config";
import { isValidShopifyGID } from "~/utils/validation";

const DELETABLE: DeletableResource[] = ["product", "collection", "page", "article", "blog", "metaobject"];

type GraphQLResponse = { data?: any; errors?: Array<{ message: string }> };

function userErrorText(errors: Array<{ field?: string[] | null; message: string }> | undefined): string {
  if (!errors?.length) return "";
  return errors.map((e) => `${e.field?.join(".") ?? ""}: ${e.message}`.trim()).join("; ");
}

/** Per type: the mutation, its variables, and where the deleted id comes back. */
function deletePlan(resource: DeletableResource, gid: string): {
  mutation: string;
  variables: Record<string, unknown>;
  read: (data: any) => { deletedId?: string | null; userErrors?: Array<{ field?: string[] | null; message: string }> };
} {
  switch (resource) {
    case "product":
      return {
        mutation: DELETE_PRODUCT,
        variables: { input: { id: gid } },
        read: (d) => ({ deletedId: d?.productDelete?.deletedProductId, userErrors: d?.productDelete?.userErrors }),
      };
    case "collection":
      return {
        mutation: DELETE_COLLECTION,
        variables: { input: { id: gid } },
        read: (d) => ({ deletedId: d?.collectionDelete?.deletedCollectionId, userErrors: d?.collectionDelete?.userErrors }),
      };
    case "page":
      return {
        mutation: DELETE_PAGE,
        variables: { id: gid },
        read: (d) => ({ deletedId: d?.pageDelete?.deletedPageId, userErrors: d?.pageDelete?.userErrors }),
      };
    case "article":
      return {
        mutation: DELETE_ARTICLE,
        variables: { id: gid },
        read: (d) => ({ deletedId: d?.articleDelete?.deletedArticleId, userErrors: d?.articleDelete?.userErrors }),
      };
    case "blog":
      return {
        mutation: DELETE_BLOG,
        variables: { id: gid },
        read: (d) => ({ deletedId: d?.blogDelete?.deletedBlogId, userErrors: d?.blogDelete?.userErrors }),
      };
    case "metaobject":
      return {
        mutation: DELETE_METAOBJECT,
        variables: { id: gid },
        read: (d) => ({ deletedId: d?.metaobjectDelete?.deletedId, userErrors: d?.metaobjectDelete?.userErrors }),
      };
  }
}

export async function handleDeleteContent(ctx: ContentActionHandlerContext, formData: FormData) {
  const { admin, session, db } = ctx;

  const resource = getFormString(formData, "resource") as DeletableResource | "";
  const gid = getFormString(formData, "resourceId") || ctx.itemId;

  if (!resource || !DELETABLE.includes(resource)) {
    return json({ success: false, error: `Cannot delete resource type: ${resource || "(missing)"}` }, { status: 400 });
  }
  if (!gid || !isValidShopifyGID(gid)) {
    return json({ success: false, error: "Invalid or missing resource id" }, { status: 400 });
  }

  // The client must name the resource type AND the id, and the two have to
  // agree. A page id sent as a product delete would otherwise reach
  // productDelete, which is the kind of mismatch a destructive path should
  // refuse rather than forward.
  const expectedGidType = GID_TYPE_BY_RESOURCE[resource];
  if (!isGidOfResource(gid, resource)) {
    return json(
      { success: false, error: `Id ${gid} is not a ${expectedGidType}` },
      { status: 400 },
    );
  }

  // A metaobject entry that a product still uses as an option value is the one
  // delete in this app whose blast radius reaches OTHER objects: depending on
  // what PLAN_METAOBJECTS_EDITOR V5 measures, Shopify either refuses it, drops
  // the option value (taking its variants, and their stock and prices, with it)
  // or leaves a dead reference. Until that is measured the UI assumes the worst
  // and so does this: the entry is only deletable when the usage is KNOWN and
  // zero. "Unknown" is refused as firmly as "in use" -- a delete whose
  // consequences nobody can name is exactly what the rule is for.
  //
  // The card disables the button for the same reason; this is not a duplicate
  // of that check but its only real one, because `deleteContent` takes a direct
  // POST and a client-side lock is not a lock.
  if (resource === "metaobject") {
    const { countLinkedOptionUsage } = await import("~/services/metaobject-usage.server");
    const usage = (await countLinkedOptionUsage(db, session.shop, [gid]))[gid];
    if (!usage || !usage.known) {
      return json(
        {
          success: false,
          errorKey: "metaobjectDeleteUsageUnknown" as const,
          error:
            "We cannot tell whether this entry is used as a product option value — sync your products and try again.",
        },
        { status: 409 },
      );
    }
    if (usage.products > 0) {
      return json(
        {
          success: false,
          errorKey: "metaobjectDeleteInUse" as const,
          usageProducts: usage.products,
          error: `${usage.products} product(s) still use this entry as an option value. Remove it there first.`,
        },
        { status: 409 },
      );
    }
  }

  try {
    const plan = deletePlan(resource, gid);
    const response = (await admin
      .graphql(plan.mutation, { variables: plan.variables })
      .then((r) => r.json())) as GraphQLResponse;

    const { deletedId, userErrors } = plan.read(response.data);
    const errorText =
      userErrorText(userErrors) || response.errors?.map((e) => e.message).join("; ") || "";

    // THE echo. Not `userErrors.length === 0` — Shopify can accept the call and
    // remove nothing, which is the same silent-no-op class as
    // translationsRemove (see the invariants in CLAUDE.md).
    if (!deletedId) {
      logger.warn("[DeleteContent] Shopify did not confirm the delete", {
        context: "DeleteContent",
        shop: session.shop,
        resource,
        gid,
        errorText,
      });
      return json(
        {
          success: false,
          error: errorText || "Shopify did not confirm the deletion — nothing was removed locally.",
        },
        { status: 400 },
      );
    }

    // Only now. See the header: purging first would make the app blind to an
    // object the shop still has.
    const { counts } = await purgeContentFromCache(db, session.shop, resource, gid);

    logger.info("[DeleteContent] Deleted", { context: "DeleteContent", shop: session.shop, resource, gid, counts });

    return json({
      actionType: "deleteContent" as const,
      success: true as const,
      resource,
      id: gid,
      /** Articles removed along with a deleted blog — the UI reports it. */
      cascadedArticles: resource === "blog" ? counts.article ?? 0 : 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[DeleteContent] Failed", { context: "DeleteContent", shop: session.shop, resource, gid, error: message });
    return json({ success: false, error: message }, { status: 500 });
  }
}

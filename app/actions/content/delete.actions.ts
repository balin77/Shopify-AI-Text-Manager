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
  DELETE_METAOBJECT_DEFINITION,
  DELETE_PAGE,
  DELETE_PRODUCT,
} from "~/graphql/content.mutations";
import { purgeContentFromCache, type DeletableResource } from "~/services/content-delete.server";
import { GID_TYPE_BY_RESOURCE, isGidOfResource, planContentTypeForDelete } from "~/config/create-fields.config";
import { canAccessContentType, type Plan } from "~/utils/planUtils";
import type { ContentType } from "~/config/plans";
import { isValidShopifyGID } from "~/utils/validation";

const DELETABLE: DeletableResource[] = [
  "product",
  "collection",
  "page",
  "article",
  "blog",
  "metaobject",
  "metaobjectDefinition",
];

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
    case "metaobjectDefinition":
      // The most destructive call in this codebase: the TYPE goes, and every
      // entry of it goes with it. Shopify does not ask about the entries, so
      // the confirmation in front of this one names how many there are.
      return {
        mutation: DELETE_METAOBJECT_DEFINITION,
        variables: { id: gid },
        read: (d) => ({
          deletedId: d?.metaobjectDefinitionDelete?.deletedId,
          userErrors: d?.metaobjectDefinitionDelete?.userErrors,
        }),
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

  // The PLAN gate, server-side. `handleUnifiedContentActions` applies none, and
  // this action is directly POST-reachable — the same class as the `/api/ai`
  // handlers, except that this one is now the most destructive thing the app
  // can do. The create path has gated on exactly this since it shipped.
  const plan = (ctx.aiSettings?.subscriptionPlan || "free") as Plan;
  const planContentType = planContentTypeForDelete(resource);
  if (!canAccessContentType(plan, planContentType as ContentType)) {
    return json(
      { success: false, errorCode: "planContentType", error: `Your plan does not include ${planContentType}.` },
      { status: 403 },
    );
  }

  // MEASURED (PLAN_METAOBJECTS_EDITOR V5, 2026-08-19, live shop): Shopify
  // REFUSES to delete a metaobject "while it is referenced by another
  // resource". That is the best of the three outcomes the plan named -- no
  // option value disappears, no variant is destroyed, and the platform itself
  // is the guard. So this check is no longer the thing standing between a
  // merchant and lost variants; it is a courtesy that names the reason in the
  // app's own words before Shopify says it in its own.
  //
  // Which is why "unknown" is no longer refused. It used to be, on the
  // assumption that a delete whose consequences nobody can name is unsafe --
  // true while V5 was open, and a dead end afterwards: a shop whose products
  // are not cached could never delete an entry, however often it synced. A
  // KNOWN usage still stops here, because the message is better than Shopify's.
  if (resource === "metaobject") {
    // Shopify is asked FIRST, because Shopify is what refuses. `referencedBy`
    // counts every metafield reference, which is exactly the rule the platform
    // applies (V5); the cache counts option VALUES only and can therefore read
    // zero where the delete is still declined. The live answer wins wherever
    // there is one — "the cache is a guess, Shopify is the truth" — and a
    // failed query falls back to the cache rather than to an assumption.
    //
    // One call, for the ONE entry being deleted. The connection has no count
    // field, so this pages; the card's list keeps reading the cache for its
    // per-row display.
    const { countLinkedOptionUsage, liveMetaobjectUsage } = await import(
      "~/services/metaobject-usage.server"
    );
    const live = await liveMetaobjectUsage(admin, gid);
    const cached = live.known ? null : (await countLinkedOptionUsage(db, session.shop, [gid]))[gid];
    // ANY reference blocks, not just a product one: that is the rule Shopify
    // applies, and counting products alone would let the delete through into a
    // raw platform refusal for an entry some collection or metafield holds.
    // The product count is for the SENTENCE, which is a different job.
    const knownInUse = live.known ? live.references > 0 : !!cached?.known && cached.products > 0;
    const products = live.known ? live.products : cached?.known ? cached.products : 0;

    if (knownInUse) {
      return json(
        {
          success: false,
          // The client phrases it: `useUnifiedContentEditor` resolves an
          // errorKey against `t.content`, so the sentence exists in all three
          // languages instead of being an English string from the server.
          // `error` stays as the fallback for a client that has neither.
          errorKey: "metaobjectDeleteInUse" as const,
          usageProducts: products,
          usageAtLeast: live.known && live.atLeast,
          error:
            products > 0
              ? `${products}${live.known && live.atLeast ? "+" : ""} product(s) still reference this entry. Remove them there first.`
              : "Something in your shop still references this entry, so Shopify will not delete it.",
        },
        { status: 409 },
      );
    }
  }

  // A DEFINITION delete takes every entry of the type with it, so the same
  // question the per-entry path asks has to be asked for all of them: is any
  // of these still an option value on a product? The per-entry path refuses a
  // KNOWN usage because the message is better than Shopify's, and there is no
  // reading under which that matters less when the count is sixty instead of
  // one. Unknown does NOT refuse, exactly as there — a shop with no cached
  // products would otherwise be locked out for good.
  if (resource === "metaobjectDefinition") {
    const definition = await db.metaobjectDefinition.findFirst({
      where: { shop: session.shop, id: gid },
      select: { type: true },
    });
    if (definition) {
      const entries = await db.metaobject.findMany({
        where: { shop: session.shop, type: definition.type },
        select: { id: true },
      });
      if (entries.length > 0) {
        const { countLinkedOptionUsage } = await import("~/services/metaobject-usage.server");
        const usage = await countLinkedOptionUsage(
          db,
          session.shop,
          entries.map((e) => e.id),
        );
        // The cache only, and deliberately: `liveMetaobjectUsage` is one paged
        // query PER ENTRY, which for a type with hundreds of them is a sweep
        // nobody should pay for behind a button. A cached zero is not proof,
        // which is why Shopify's own refusal still travels back verbatim.
        const used = Object.values(usage).flatMap((u) => (u.known && u.products > 0 ? [u] : []));
        const products = used.reduce((sum, u) => sum + u.products, 0);
        if (used.length > 0) {
          return json(
            {
              success: false,
              errorKey: "metaobjectDefinitionInUse" as const,
              usageEntries: used.length,
              usageProducts: products,
              error: `${used.length} entr(ies) of this type are still used as product option values (${products} product references). Remove them there first.`,
            },
            { status: 409 },
          );
        }
      }
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
    //
    // And it can no longer report the DELETE as failed. The purge is
    // bookkeeping AFTER an irreversible act: if it throws, the object is gone
    // from the shop either way, and answering "could not delete" sent the
    // merchant into a retry that then said "Shopify did not confirm the
    // deletion -- nothing was removed locally" about a thing that no longer
    // existed. The stale cache self-heals on the next sync; a false failure
    // does not.
    let counts: Record<string, number> = {};
    let purgeError: string | null = null;
    try {
      ({ counts } = await purgeContentFromCache(db, session.shop, resource, gid));
    } catch (error) {
      purgeError = error instanceof Error ? error.message : String(error);
      logger.error("[DeleteContent] Deleted on Shopify, cache purge failed", {
        context: "DeleteContent",
        shop: session.shop,
        resource,
        gid,
        error: purgeError,
      });
    }

    logger.info("[DeleteContent] Deleted", { context: "DeleteContent", shop: session.shop, resource, gid, counts });

    return json({
      actionType: "deleteContent" as const,
      success: true as const,
      resource,
      id: gid,
      /** Articles removed along with a deleted blog — the UI reports it. */
      cascadedArticles: resource === "blog" ? counts.article ?? 0 : 0,
      /**
       * Entries removed along with a deleted metaobject TYPE.
       *
       * From the CACHE, so it is what this app had, not what Shopify removed:
       * the mutation reports only the definition's id. The confirmation in
       * front of the delete says the same thing in the same words, so the
       * number the merchant agreed to is the number they are told about.
       */
      cascadedEntries: resource === "metaobjectDefinition" ? counts.metaobject ?? 0 : 0,
      /** The object IS gone; only this app's copy of it may still linger. */
      cachePurgeFailed: purgeError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[DeleteContent] Failed", { context: "DeleteContent", shop: session.shop, resource, gid, error: message });
    return json({ success: false, error: message }, { status: 500 });
  }
}

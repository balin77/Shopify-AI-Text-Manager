/**
 * Cache purge for a deleted content object — PLAN_CONTENT_CREATION §1.8 + the
 * general delete.
 *
 * ONE place that knows what does NOT cascade, because two of the three things
 * that need removing have no foreign key at all:
 *
 *   - `ContentTranslation` is polymorphic (`resourceId` points at one of
 *     several parent tables), so no FK and no ON DELETE CASCADE is expressible.
 *     The existing per-type helpers already handle this.
 *   - `SeoKeywordAssignment` is polymorphic for the same reason and was
 *     handled NOWHERE: before this module, deleting a product (from the
 *     Shopify webhook, from a sync reconcile) left its keyword assignment
 *     behind forever, pointing at a GID that no longer exists. That is a
 *     pre-existing orphan, not a new one — which is exactly why the cleanup
 *     belongs in a shared helper rather than in the new delete action.
 *
 * Everything owned by a Product (`ProductImage`, `ProductOption`,
 * `ProductMetafield`, `ProductVariant`, `ProductCollection`) DOES cascade and
 * must not be deleted explicitly.
 *
 * Every delete here is `deleteMany`, never `delete`: a row that is already
 * gone is a successful no-op, and the caller may well be retrying.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import type { DeletableResource } from "~/config/create-fields.config";
import { flattenMenuItems } from "~/services/menu-translations.shared";
import { MENU_LINK_RESOURCE_TYPE } from "~/services/menu-translations.server";

export type { DeletableResource } from "~/config/create-fields.config";

export interface PurgeResult {
  /** Rows removed per table — logged, and useful when a purge looks wrong. */
  counts: Record<string, number>;
}

/**
 * Remove every LOCAL trace of a resource.
 *
 * Call this ONLY after Shopify confirmed the delete by echoing the id back.
 * Purging first would leave the app blind to an object that still exists in
 * the shop, and the next sync would resurrect it as if nothing happened —
 * silently disagreeing with what the merchant was told.
 */
export async function purgeContentFromCache(
  db: PrismaClient,
  shop: string,
  resource: DeletableResource,
  gid: string,
): Promise<PurgeResult> {
  const counts: Record<string, number> = {};

  await db.$transaction(async (tx) => {
    // Polymorphic and FK-less — both tables key off the GID directly.
    counts.contentTranslation = (
      await tx.contentTranslation.deleteMany({ where: { shop, resourceId: gid } })
    ).count;
    counts.seoKeywordAssignment = (
      await tx.seoKeywordAssignment.deleteMany({ where: { shop, resourceId: gid } })
    ).count;

    switch (resource) {
      case "product":
        // ProductImage / Option / Metafield / Variant / ProductCollection all
        // cascade through this row — deleting them here would be redundant.
        counts.product = (await tx.product.deleteMany({ where: { shop, id: gid } })).count;
        break;

      case "collection":
        counts.collection = (await tx.collection.deleteMany({ where: { shop, id: gid } })).count;
        // Memberships point AT this collection without a foreign key (the
        // collection cache is plan-capped, so a membership can name a
        // collection this shop never cached — see the schema comment).
        counts.productCollection = (
          await tx.productCollection.deleteMany({ where: { shop, collectionId: gid } })
        ).count;
        break;

      case "page":
        counts.page = (await tx.page.deleteMany({ where: { shop, id: gid } })).count;
        break;

      case "article":
        counts.article = (await tx.article.deleteMany({ where: { shop, id: gid } })).count;
        break;

      case "blog":
        // Blogs have no Prisma model (Phase 0, step 4 — the loader fetches
        // them live). Their ARTICLES do, and Shopify deletes those along with
        // the blog, so the cached articles have to go too or the blog tab
        // would list posts that no longer exist anywhere.
        {
          const articles = await tx.article.findMany({ where: { shop, blogId: gid }, select: { id: true } });
          const ids = articles.map((a) => a.id);
          if (ids.length > 0) {
            counts.articleTranslations = (
              await tx.contentTranslation.deleteMany({ where: { shop, resourceId: { in: ids } } })
            ).count;
            counts.articleKeywords = (
              await tx.seoKeywordAssignment.deleteMany({ where: { shop, resourceId: { in: ids } } })
            ).count;
          }
          counts.article = (await tx.article.deleteMany({ where: { shop, blogId: gid } })).count;
        }
        break;

      case "menu":
        // The two lines above cleaned up rows keyed by the MENU's own GID, and
        // a menu has none of those: its translations live on its ITEMS, each
        // under `gid://shopify/Link/<the MenuItem's number>`. Nothing in the
        // schema connects those to the menu, so they have to be collected from
        // the cached tree BEFORE the row goes — a delete-first order would
        // strand every one of them, the same trap `MetaobjectTranslation`
        // presented for a definition.
        {
          const row = await tx.menu.findFirst({ where: { shop, id: gid }, select: { items: true } });
          // The SAME walker `refreshMenuCache` uses to collect a tree's Link
          // ids — not a second one written next to it. Two walkers over one
          // JSON shape that must agree is how the external-video parser drifted
          // into three copies, and the failure here is asymmetric: the purge
          // would miss rows the sync still counts as live.
          const linkIds = row
            ? flattenMenuItems(row.items).flatMap((i) => (i.linkId ? [i.linkId] : []))
            : [];
          if (linkIds.length > 0) {
            counts.menuLinkTranslations = (
              await tx.contentTranslation.deleteMany({
                // Scoped by resourceType, exactly like the sync's own bulk
                // delete of these rows. Only menu items carry a Link GID
                // today, so this changes no result — it is a belt on a
                // destructive deleteMany whose one sibling already wears it.
                where: { shop, resourceType: MENU_LINK_RESOURCE_TYPE, resourceId: { in: linkIds } },
              })
            ).count;
          }
          counts.menu = (await tx.menu.deleteMany({ where: { shop, id: gid } })).count;
        }
        break;

      case "metaobject":
        counts.metaobject = (await tx.metaobject.deleteMany({ where: { shop, id: gid } })).count;
        counts.metaobjectTranslation = (
          await tx.metaobjectTranslation.deleteMany({ where: { shop, metaobjectId: gid } })
        ).count;
        break;

      case "metaobjectDefinition": {
        // The definition takes its ENTRIES with it on Shopify's side, so the
        // cache has to follow -- otherwise the page keeps listing entries of a
        // type that no longer exists and every save against them fails.
        //
        // Both deletes go by TYPE, in one indexed statement each:
        // `MetaobjectTranslation` carries `type` with an index of its own, so
        // reading every entry id first and passing them as an unbounded `in`
        // was the biggest statement in this module for the largest types --
        // and this whole block runs inside one interactive transaction.
        const definition = await tx.metaobjectDefinition.findFirst({
          where: { shop, id: gid },
          select: { type: true },
        });
        if (definition) {
          counts.metaobjectTranslation = (
            await tx.metaobjectTranslation.deleteMany({ where: { shop, type: definition.type } })
          ).count;
          counts.metaobject = (
            await tx.metaobject.deleteMany({ where: { shop, type: definition.type } })
          ).count;
        } else {
          // No cached definition means no way to name the type, so the entries
          // cannot be found. Reported rather than passed over in silence: a
          // partial purge that says nothing looks exactly like a complete one.
          counts.metaobjectEntriesUnreachable = 1;
        }
        counts.metaobjectDefinition = (
          await tx.metaobjectDefinition.deleteMany({ where: { shop, id: gid } })
        ).count;
        break;
      }
    }
  });

  logger.info("[ContentDelete] Cache purged", { context: "ContentDelete", shop, resource, gid, counts });
  return { counts };
}

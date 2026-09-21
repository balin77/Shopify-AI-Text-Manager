/**
 * May the automatic re-translation rewrite THIS locale's URL handle — and if it
 * does, where does the old foreign URL go?
 *
 * `AISettings.autoTranslateHandles` (Settings → KI-Anweisungen → Übersetzungen,
 * under the auto-translation it belongs to) is the merchant's opt-in, and the
 * pure classifier reads it as "may a handle move at all"
 * (stale-translations.shared.ts). This module answers the other half — "may
 * THIS URL move" — which is not decidable from a key and a value:
 *
 *   A handle is a URL. Rewriting one moves a storefront page, and the address
 *   it moved away from answers nothing afterwards. `decideTranslatedHandleRedirect`
 *   (seo/handle-redirect.shared.ts) is this app's one answer to that, with five
 *   documented refusals; what this module does is assemble the facts it needs
 *   out of the caches and hand back a context the repair can act on.
 *
 * Two rules make the feature safe, and both are structural rather than a
 * discipline:
 *
 *  - **No context ⇒ no handle.** The repair DECLINES a handle entry this module
 *    cannot answer for, so it is never written. That covers every reason at
 *    once: an unsupported resource type, a merchant who switched shop-wide
 *    redirects off, a locale that holds no handle translation yet, a path that
 *    is still somebody's live address, an article under a blog with a
 *    translated handle, a lookup that failed. A silently broken foreign link is
 *    the one outcome this feature may not produce, so "we could not establish
 *    the redirect" and "we do not touch the handle" are the same sentence.
 *  - **REFRESH, never CREATE.** A locale with no handle translation is served
 *    under the PRIMARY slug — live, canonical, and unbroken. Giving it a URL of
 *    its own would be a change nobody asked for, in every published language at
 *    once, on a text edit made for some other reason. `previousTranslatedHandle`
 *    is therefore required, which is the same thing the redirect decision's
 *    rule 1 says from the other side.
 *
 * What it does NOT do is guarantee the row lands: `applyTranslatedHandleRedirect`
 * runs AFTER the register, because the two orders are not symmetric. Register
 * first and a failed redirect leaves the old foreign URL dead while the page is
 * reachable at its new address; redirect first and a failed register leaves a
 * 301 shadowing the page's OWN live URL, i.e. the resource unreachable. The
 * first is the recoverable one and the same residual every other redirect call
 * site in this app carries ("never fails the write it accompanies").
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";
import type { ShopifyGraphQLClient } from "../sync-types";
import {
  redirectResourceFor,
  translatedHandleRedirectBlocker,
  wasEverLive,
  type RedirectableResource,
} from "../seo/handle-redirect.shared";

/**
 * Everything `decideTranslatedHandleRedirect` needs about the OLD state, for
 * one (resource, locale). The new handle is the only thing missing, and it does
 * not exist until the AI has answered.
 */
export interface TranslatedHandleContext {
  resource: RedirectableResource;
  /** The handle translation this locale held BEFORE the repair — captured here,
   *  i.e. before the write, which is the rule the whole redirect feature turns
   *  on (a capture placed after reads its own write). */
  previousTranslatedHandle: string;
  primaryHandle: string;
  otherLocaleHandles: string[];
  previousHandleTakenElsewhere: boolean;
  previouslyLive: boolean | null;
  blogHandle: string | null;
  blogHandleTranslatedInLocale: boolean;
}

/**
 * Resolve the context for one (resource, locale), or `null` when this handle
 * must not move. Injected into the repair so a test can answer without a shop,
 * and so the repair keeps no content vocabulary of its own.
 */
export type HandleRedirectResolver = (
  ref: { resourceId: string; resourceType: string },
  locale: string,
) => Promise<TranslatedHandleContext | null>;

interface ResolverDeps {
  db: PrismaClient;
  shop: string;
  /** For the one fact no cache holds: a blog's own handle. */
  client: ShopifyGraphQLClient;
}

/** The handle translations of one resource, global layer, keyed by locale. */
type HandleRows = Map<string, string>;

/**
 * Builds the resolver the repair uses.
 *
 * Everything it looks up is MEMOISED per resource for the life of one repair:
 * the repair asks once per (resource, locale), so a shop with eight published
 * languages would otherwise pay eight identical scans — and one of them
 * (`handleTakenByOtherResource`) is an unindexed scan of the shop's rows for
 * that type. The cache is per resolver instance, i.e. per repair run, so it can
 * never outlive the write it was captured for.
 */
export function makeHandleRedirectResolver(deps: ResolverDeps): HandleRedirectResolver {
  const handleRowsByResource = new Map<string, Promise<HandleRows>>();
  const stateByResource = new Map<string, Promise<ResourceHandleState | null>>();
  const blogHandles = new Map<string, Promise<string | null>>();
  let wanted: Promise<boolean> | null = null;

  const rowsFor = (resourceId: string): Promise<HandleRows> => {
    let cached = handleRowsByResource.get(resourceId);
    if (!cached) {
      cached = loadHandleRows(deps, resourceId);
      handleRowsByResource.set(resourceId, cached);
    }
    return cached;
  };

  const blogHandleFor = (blogId: string): Promise<string | null> => {
    let cached = blogHandles.get(blogId);
    if (!cached) {
      cached = loadBlogHandle(deps, blogId);
      blogHandles.set(blogId, cached);
    }
    return cached;
  };

  return async (ref, locale) => {
    try {
      const resource = redirectResourceFor(ref.resourceType, ref.resourceId);
      // Policies, metaobjects, theme content, sub-resources: no handle-derived
      // storefront URL, so no `handle` key either. Refusing costs nothing.
      if (!resource) return null;
      // A BLOG carries its ARTICLES' URLs with it, and Shopify redirects have
      // no wildcards — `applyTranslatedHandleRedirect` covers the blog's own
      // index page and reports the rest as `blogArticlesUncovered`, which the
      // merchant reads on a save they made. Here nobody is watching, so that
      // note has no reader and the option would break every article URL under
      // the blog in silence. The blog's handle is left to a deliberate edit.
      if (resource === "blog") return null;

      // The shop's own "redirect when a handle changes" switch. Off means the
      // merchant does not want redirect rows — and an UNATTENDED handle rewrite
      // without one is exactly the silently broken link this module exists to
      // prevent, so it takes the handle with it rather than writing without a
      // redirect.
      wanted ??= loadRedirectPreference(deps);
      if (!(await wanted)) return null;

      const rows = await rowsFor(ref.resourceId);
      const previousTranslatedHandle = (rows.get(locale) ?? "").trim();
      // REFRESH, never CREATE — see the header. Bails before the remaining
      // lookups, which is also what keeps a shop that translates no handles at
      // all from paying for this at all.
      if (!previousTranslatedHandle) return null;

      let state = stateByResource.get(ref.resourceId);
      if (!state) {
        state = loadResourceState(deps, resource, ref.resourceId, blogHandleFor);
        stateByResource.set(ref.resourceId, state);
      }
      const resolved = await state;
      if (!resolved?.handle) return null;

      let blogHandle: string | null = null;
      let blogHandleTranslatedInLocale = false;
      if (resource === "article") {
        blogHandle = resolved.blogHandle ?? null;
        if (resolved.blogId) {
          // Two translatable segments in one path: which spelling the
          // storefront serves for the outer one is unmeasured, so the blocker
          // below refuses the whole thing rather than guessing.
          const blogRows = await rowsFor(resolved.blogId);
          blogHandleTranslatedInLocale = !!blogRows.get(locale)?.trim();
        }
      }

      const { handleTakenByOtherResource } = await import("../seo/handle-redirect.server");
      const previousHandleTakenElsewhere = await handleTakenByOtherResource(
        deps.db as never,
        deps.shop,
        resource,
        previousTranslatedHandle,
        ref.resourceId,
      );

      const context: TranslatedHandleContext = {
        resource,
        previousTranslatedHandle,
        primaryHandle: resolved.handle,
        otherLocaleHandles: [...rows.entries()]
          .filter(([rowLocale]) => rowLocale !== locale)
          .map(([, value]) => value),
        previousHandleTakenElsewhere,
        previouslyLive: wasEverLive(resource, resolved.state),
        blogHandle,
        blogHandleTranslatedInLocale,
      };

      // The refusals that do not need the new handle, asked BEFORE the AI
      // request rather than after it: a handle this would refuse must be left
      // alone, not translated and then written without a redirect.
      const blocked = translatedHandleRedirectBlocker({ ...context, marketId: "", wanted: true });
      if (blocked) {
        logger.info("[HandleRetranslation] Handle left alone — no redirect possible", {
          context: "HandleRetranslation",
          shop: deps.shop,
          resourceId: ref.resourceId,
          locale,
          reason: blocked,
        });
        return null;
      }
      return context;
    } catch (error: unknown) {
      // A failed lookup is not evidence that the move is safe. Same direction as
      // `handleTakenByOtherResource`: not moving a slug costs nothing.
      logger.warn("[HandleRetranslation] Could not establish the redirect — handle left alone", {
        context: "HandleRetranslation",
        shop: deps.shop,
        resourceId: ref.resourceId,
        locale,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}

async function loadRedirectPreference(deps: ResolverDeps): Promise<boolean> {
  try {
    const row = await deps.db.aISettings.findUnique({
      where: { shop: deps.shop },
      select: { seoAutoHandleRedirect: true },
    });
    // The column's own default is ON, and a row that predates it is not an
    // opt-out anybody chose.
    return row?.seoAutoHandleRedirect !== false;
  } catch {
    // Unlike the bulk editor's copy of this read, a failure here resolves to
    // OFF: there the answer only decides whether a redirect accompanies a write
    // the merchant asked for, here it decides whether an unattended process may
    // move a URL at all.
    return false;
  }
}

async function loadHandleRows(deps: ResolverDeps, resourceId: string): Promise<HandleRows> {
  const rows = await deps.db.contentTranslation.findMany({
    where: { shop: deps.shop, resourceId, key: "handle", marketId: "" },
    select: { locale: true, value: true },
  });
  const out: HandleRows = new Map();
  for (const row of rows) if (row.value) out.set(row.locale, row.value);
  return out;
}

interface ResourceHandleState {
  handle: string | null;
  state: { status?: string | null; isPublished?: boolean | null; attributesKnown?: boolean };
  blogId?: string | null;
  blogHandle?: string | null;
}

/**
 * The resource's own PRIMARY handle plus what says whether its URL was
 * reachable — the same per-type shape the bulk editor's redirect capture uses,
 * because the two answer the same question off the same cache columns.
 */
async function loadResourceState(
  deps: ResolverDeps,
  resource: RedirectableResource,
  resourceId: string,
  blogHandleFor: (blogId: string) => Promise<string | null>,
): Promise<ResourceHandleState | null> {
  const where = { shop_id: { shop: deps.shop, id: resourceId } };
  switch (resource) {
    case "product": {
      const row = await deps.db.product.findUnique({ where, select: { handle: true, status: true } });
      return { handle: row?.handle ?? null, state: { status: row?.status ?? null } };
    }
    case "page": {
      const row = await deps.db.page.findUnique({
        where,
        select: { handle: true, isPublished: true, attributesSyncedAt: true },
      });
      return {
        handle: row?.handle ?? null,
        state: { isPublished: row?.isPublished ?? null, attributesKnown: !!row?.attributesSyncedAt },
      };
    }
    case "article": {
      const row = await deps.db.article.findUnique({
        where,
        select: { handle: true, isPublished: true, attributesSyncedAt: true, blogId: true },
      });
      if (!row) return null;
      return {
        handle: row.handle ?? null,
        state: { isPublished: row.isPublished ?? null, attributesKnown: !!row.attributesSyncedAt },
        blogId: row.blogId ?? null,
        // No blog handle ⇒ the article's path is not derivable at all, which
        // the blocker turns into `missingBlogHandle`.
        blogHandle: row.blogId ? await blogHandleFor(row.blogId) : null,
      };
    }
    case "collection": {
      const row = await deps.db.collection.findUnique({ where, select: { handle: true } });
      // Visibility lives in publications — no scope, genuinely unknown, which
      // the decision reads as "proceed".
      return { handle: row?.handle ?? null, state: {} };
    }
    case "blog":
      // Unreachable: a blog's handle is refused by the caller, because its
      // ARTICLES' URLs move with it and Shopify redirects have no wildcards.
      // Kept so the switch stays exhaustive over `RedirectableResource`.
      return null;
  }
}

async function loadBlogHandle(deps: ResolverDeps, blogId: string): Promise<string | null> {
  try {
    const response = await deps.client.graphql(
      `#graphql
        query repairBlogHandleForRedirect($id: ID!) { blog(id: $id) { handle } }`,
      { variables: { id: blogId } },
    );
    const body = (await response.json()) as { data?: { blog?: { handle?: string | null } | null } };
    return body?.data?.blog?.handle ?? null;
  } catch {
    return null;
  }
}

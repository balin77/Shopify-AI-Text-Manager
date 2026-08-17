/**
 * Applies the handle-redirect decision (PLAN §Phase 3.3 / §A1).
 *
 * The decision itself is pure and lives in `handle-redirect.shared.ts`; this
 * is only the part that talks to Shopify, so the interesting rules stay
 * testable without a shop.
 *
 * ── Never fails the save it accompanies ─────────────────────────────────────
 * A redirect is a courtesy attached to a content update that has ALREADY
 * happened. If creating it fails, the handle is changed either way — turning
 * that into an error would tell the merchant their edit did not go through
 * when it did, and invite them to make it again. So every failure comes back
 * as a NOTE. The same reasoning as the create path's "created, but a later
 * step failed" branch.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "~/utils/logger.server";
import { createRedirect, deleteRedirect, listRedirects, updateRedirect } from "./redirects.service";
import {
  decideHandleRedirect,
  decideTranslatedHandleRedirect,
  type HandleRedirectRequest,
  type RedirectableResource,
  type TranslatedHandleRedirectRequest,
} from "./handle-redirect.shared";

/**
 * What the merchant should be told, as a CODE — never as a sentence. This app
 * ships in three languages and the client owns all three; a server-built
 * English string would arrive untranslated in the German and Spanish UIs.
 * `fromPath` is the one variable those sentences need.
 */
export type HandleRedirectNoteCode =
  | "created"
  | "notConfirmed"
  | "failed"
  | "missingBlogHandle"
  /** The blog's own URL was redirected; its ARTICLES' URLs were not. */
  | "blogArticlesUncovered"
  /** The new URL had a redirect sitting on it, which had to be removed. */
  | "shadowRemoved"
  /** Foreign locales only: the article sits under a blog whose OWN handle is
   *  translated, so its path has two translatable segments and this app does
   *  not know which spelling the storefront serves. */
  | "localeBlogHandleUnknown";

export interface HandleRedirectResult {
  created: boolean;
  /** Set only when something is worth telling the merchant. */
  noteCode?: HandleRedirectNoteCode;
  /** The old storefront path the note talks about. */
  fromPath?: string;
  /** Why nothing happened — for logs and tests, not for the UI. */
  skippedReason?: string;
}

/** Shopify matches redirect paths case-insensitively and slash-normalized, and
 *  so does this app's own chain derivation (`redirect-chains.ts`). */
function samePath(a: string | null | undefined, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();
  return !!a && norm(a) === norm(b);
}

/**
 * The redirects that touch either end of this rename. Shopify's `urlRedirects`
 * query takes a search term, so this is two small lookups rather than a walk of
 * the shop's whole redirect list — which on a large shop is thousands of rows
 * and would make every handle edit expensive.
 *
 * The term is a SEARCH, not an exact match, so the results are filtered by
 * `samePath` at every use site; a near-miss must never be repointed.
 */
async function findRedirects(
  admin: AdminApiContext,
  paths: string[],
): Promise<Array<{ id: string; path: string; target: string }>> {
  const seen = new Map<string, { id: string; path: string; target: string }>();
  // FIELDED terms, not free text. The two halves of the diff need different
  // things — repointing looks up by TARGET, the create/update and the shadow
  // check by PATH — and a bare term is not documented to search both. A query
  // that quietly matched only `path` would make the chain repointing a no-op
  // in production while every unit test still passed, which is the worst way
  // for this to fail.
  const terms = paths.flatMap((path) => [`path:${path}`, `target:${path}`]);
  for (const query of terms) {
    const { redirects } = await listRedirects(admin, { first: 50, query });
    for (const redirect of redirects) seen.set(redirect.id, redirect);
  }
  return [...seen.values()];
}

/**
 * Applies ONE path→path redirect as a DIFF over the shop's existing ones.
 *
 * Split out from `applyHandleRedirect` because a second caller needs exactly
 * this and nothing above it: when a BLOG is renamed, every article under it
 * moves too, and each needs its own redirect from a pair of paths that no
 * handle comparison would produce (the article's own handle did not change —
 * the segment above it did).
 *
 * Returns `null` on success, or a short reason for the log.
 */
export async function applyRedirectPair(
  admin: AdminApiContext,
  shop: string,
  fromPath: string,
  toPath: string,
): Promise<{ ok: boolean; shadowRemoved: boolean; reason?: string }> {
  // ── Never manufacture a chain or a loop ──────────────────────────────────
  // Renaming a→b→c would otherwise leave `/a→/b` AND `/b→/c`: a chain this
  // app's OWN crawler reports as a finding. Renaming a→b→a would leave
  // `/a→/b` and `/b→/a`: a two-member cycle that `redirect-chains.ts`
  // explicitly refuses to auto-fix, because there is no end target to pick.
  // Both are avoided by repointing what already exists instead of adding to
  // it — the redirects are looked up by PATH, so this costs one small query,
  // not a sweep of the shop's redirect list.
  const existing = await findRedirects(admin, [fromPath, toPath]);

  // Anything that pointed AT the old path now points at the new one. This is
  // the a→b→c case: `/a→/b` becomes `/a→/c`.
  const stale = existing.filter((r) => samePath(r.target, fromPath) && !samePath(r.path, toPath));
  for (const redirect of stale) {
    const repointed = await updateRedirect(admin, redirect.id, { path: redirect.path, target: toPath });
    if (!repointed.redirect?.id) {
      logger.warn("[HandleRedirect] Could not repoint an older redirect", {
        context: "HandleRedirect", shop, path: redirect.path, to: toPath,
      });
    }
  }

  // A redirect sitting ON the new path has to go, and not only because
  // `/a→/b` plus `/b→/a` is a cycle: the new path is a LIVE page again, and
  // Shopify serves the redirect in preference to it. Leaving the row would
  // make the very object the merchant just renamed unreachable at its own
  // URL. This is the rename-back case (a→b, then b→a).
  //
  // It is deleted whatever its target was, including a redirect the merchant
  // set up themselves: a redirect on a live path is not a redirect the shop
  // can keep. But it is THEIR row, so it is reported and logged with both
  // halves, never removed in silence.
  let shadowRemoved = false;
  for (const shadowing of existing.filter((r) => samePath(r.path, toPath))) {
    const removed = await deleteRedirect(admin, shadowing.id);
    if (!removed.deletedId) {
      logger.warn("[HandleRedirect] A redirect still shadows the new URL", {
        context: "HandleRedirect", shop, path: shadowing.path, target: shadowing.target,
      });
      continue;
    }
    shadowRemoved = true;
    logger.info("[HandleRedirect] Removed a redirect that shadowed the new URL", {
      context: "HandleRedirect", shop, path: shadowing.path, target: shadowing.target,
    });
  }

  // Shopify rejects a second redirect on the same path, so an existing one
  // for `fromPath` is UPDATED rather than re-created.
  const onSamePath = existing.find((r) => samePath(r.path, fromPath));
  const result = onSamePath
    ? await updateRedirect(admin, onSamePath.id, { path: fromPath, target: toPath })
    : await createRedirect(admin, { path: fromPath, target: toPath });

  // Echo, same rule as everywhere else: userErrors alone is not the answer.
  if (!result.redirect?.id) {
    const detail = result.userErrors?.map((e) => e.message).join("; ") || "no redirect returned";
    logger.warn("[HandleRedirect] Shopify did not confirm the redirect", {
      context: "HandleRedirect", shop, from: fromPath, to: toPath, detail,
    });
    return { ok: false, shadowRemoved, reason: "notConfirmed" };
  }

  logger.info("[HandleRedirect] Created", {
    context: "HandleRedirect",
    shop,
    from: fromPath,
    to: toPath,
    reused: !!onSamePath,
    repointed: stale.length,
    shadowRemoved,
  });
  return { ok: true, shadowRemoved };
}

/**
 * Does another resource of the same type already serve this handle as its
 * PRIMARY one?
 *
 * Only the foreign path needs this, and the reason is worth keeping in view:
 * Shopify enforces primary-handle uniqueness, so a handle a merchant renames
 * AWAY from is free by construction — which is why `applyHandleRedirect` needs
 * no collision check at all. A TRANSLATED handle carries no such guarantee, so
 * `/products/kiste` can be product A's old Spanish URL and product B's live
 * primary URL at the same time. Redirecting it would 301 product B's own
 * address, in every locale, permanently.
 *
 * `handle` is not indexed (only `shop` is), so this is one scan of the shop's
 * rows for that type. It runs ONLY where a redirect would otherwise be created
 * — a real foreign rename — never on the fill-an-empty-translation path.
 *
 * Errs toward "taken" on any failure: not creating a redirect costs a link, and
 * creating a wrong one costs a live product page.
 */
export async function handleTakenByOtherResource(
  db: {
    product: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    collection: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    page: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    article: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  },
  shop: string,
  resource: RedirectableResource,
  handle: string,
  selfId: string,
): Promise<boolean> {
  // A blog's index path (`/blogs/<handle>`) shares its prefix with article
  // paths but never collides with one — an article path always has a second
  // segment. There is no Blog cache model to query anyway.
  const model =
    resource === "product" ? db.product
    : resource === "collection" ? db.collection
    : resource === "page" ? db.page
    : resource === "article" ? db.article
    : null;
  if (!model) return false;
  try {
    const row = await model.findFirst({
      where: { shop, handle, id: { not: selfId } },
      select: { id: true },
    });
    return !!row;
  } catch (error) {
    logger.warn("[HandleRedirect] Could not check the old handle for a collision — refusing the redirect", {
      context: "HandleRedirect", shop, resource, error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * The foreign-locale twin. Same Shopify work, a different decision — the rules
 * that make a translated handle's redirect safe live in
 * `decideTranslatedHandleRedirect`, and everything below the decision is shared
 * with the primary path (repoint the chain, clear a shadowing row, echo-check).
 *
 * The row it writes is UNPREFIXED on purpose: measured, one row serves every
 * locale. That reach has two accepted costs, both stated here because neither
 * is visible from the call site:
 *
 *  - It also answers the PRIMARY-locale path carrying the old translated slug.
 *    Whether Shopify serves a translated handle without a prefix is NOT
 *    measured (the probe answered the prefixed direction), so this is an
 *    assumption: if that path 404s the row is harmless, and if it serves, the
 *    row sends it where the translated URL now lives. The decision's rule 2 is
 *    what keeps that path from being someone ELSE's live address.
 *  - `applyRedirectPair` deletes a redirect sitting on the TARGET path, because
 *    Shopify serves a redirect in preference to a live page. On this path that
 *    row may be one an earlier PRIMARY rename created, so a merchant who
 *    recycles an old primary handle as a translated one can lose it. There is
 *    no way to keep both: one path holds one redirect. The single editor
 *    reports `shadowRemoved`; the bulk path cannot, and does not claim to.
 *
 * A renamed blog handle carries its articles' foreign URLs with it and Shopify
 * redirects have no wildcards, so that case reports `blogArticlesUncovered`
 * exactly as the primary one does. Unlike the primary one it does NOT sweep the
 * articles afterwards: each article's foreign URL depends on its own
 * translation, and the blog-handle case is precisely the one the decision
 * refuses to guess at.
 */
export async function applyTranslatedHandleRedirect(
  admin: AdminApiContext,
  shop: string,
  request: TranslatedHandleRedirectRequest,
): Promise<HandleRedirectResult> {
  const decision = decideTranslatedHandleRedirect(request);

  if (!decision.redirect) {
    // Both mean the article's old URL is NOT covered, and the merchant would
    // otherwise assume it is — but they are different facts, so they get
    // different sentences: one blog is unknown, the other is known and has two
    // possible spellings.
    if (decision.reason === "missingBlogHandle" || decision.reason === "localeBlogHandleUnknown") {
      return { created: false, skippedReason: decision.reason, noteCode: decision.reason };
    }
    return { created: false, skippedReason: decision.reason };
  }

  const okCode: HandleRedirectNoteCode =
    request.resource === "blog" ? "blogArticlesUncovered" : "created";

  try {
    const outcome = await applyRedirectPair(admin, shop, decision.fromPath, decision.toPath);
    if (!outcome.ok) {
      return {
        created: false,
        skippedReason: outcome.reason ?? "notConfirmed",
        noteCode: "notConfirmed",
        fromPath: decision.fromPath,
      };
    }
    return {
      created: true,
      noteCode: outcome.shadowRemoved && okCode === "created" ? "shadowRemoved" : okCode,
      fromPath: decision.fromPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[HandleRedirect] Failed on a translated handle", {
      context: "HandleRedirect", shop, resource: request.resource, error: message,
    });
    return { created: false, skippedReason: "error", noteCode: "failed", fromPath: decision.fromPath };
  }
}

export async function applyHandleRedirect(
  admin: AdminApiContext,
  shop: string,
  request: HandleRedirectRequest,
): Promise<HandleRedirectResult> {
  const decision = decideHandleRedirect(request);

  if (!decision.redirect) {
    // Most reasons are entirely routine (not wanted, unchanged, a draft whose
    // URL was never reachable) and deserve no noise. One is worth surfacing:
    // an article whose blog handle we do not know CANNOT get a redirect, and
    // the merchant would otherwise assume the old URL is covered when it is
    // not.
    if (decision.reason === "missingBlogHandle") {
      return { created: false, skippedReason: decision.reason, noteCode: "missingBlogHandle" };
    }
    return { created: false, skippedReason: decision.reason };
  }

  const okCode: HandleRedirectNoteCode =
    request.resource === "blog" ? "blogArticlesUncovered" : "created";

  try {
    const outcome = await applyRedirectPair(admin, shop, decision.fromPath, decision.toPath);
    if (!outcome.ok) {
      return {
        created: false,
        skippedReason: outcome.reason ?? "notConfirmed",
        noteCode: "notConfirmed",
        fromPath: decision.fromPath,
      };
    }
    // Removing someone's redirect outranks the good news — the blog case
    // aside, which is a warning of its own and already the stronger claim.
    return {
      created: true,
      noteCode: outcome.shadowRemoved && okCode === "created" ? "shadowRemoved" : okCode,
      fromPath: decision.fromPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[HandleRedirect] Failed", { context: "HandleRedirect", shop, error: message });
    return { created: false, skippedReason: "error", noteCode: "failed", fromPath: decision.fromPath };
  }
}

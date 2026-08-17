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
import { decideHandleRedirect, type HandleRedirectRequest } from "./handle-redirect.shared";

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
  | "blogArticlesUncovered";

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
  for (const path of paths) {
    const { redirects } = await listRedirects(admin, { first: 50, query: path });
    for (const redirect of redirects) seen.set(redirect.id, redirect);
  }
  return [...seen.values()];
}

export async function applyHandleRedirect(
  admin: AdminApiContext,
  shop: string,
  request: HandleRedirectRequest,
): Promise<HandleRedirectResult> {
  const decision = decideHandleRedirect(request);

  if (!decision.redirect) {
    // Most reasons are entirely routine (not wanted, unchanged) and deserve no
    // noise. One is worth surfacing: an article whose blog handle we do not
    // know CANNOT get a redirect, and the merchant would otherwise assume the
    // old URL is covered when it is not.
    if (decision.reason === "missingBlogHandle") {
      return { created: false, skippedReason: decision.reason, noteCode: "missingBlogHandle" };
    }
    return { created: false, skippedReason: decision.reason };
  }

  const okCode: HandleRedirectNoteCode =
    request.resource === "blog" ? "blogArticlesUncovered" : "created";

  try {
    // ── Never manufacture a chain or a loop ────────────────────────────────
    // Renaming a→b→c would otherwise leave `/a→/b` AND `/b→/c`: a chain this
    // app's OWN crawler reports as a finding. Renaming a→b→a would leave
    // `/a→/b` and `/b→/a`: a two-member cycle that `redirect-chains.ts`
    // explicitly refuses to auto-fix, because there is no end target to pick.
    // Both are avoided by repointing what already exists instead of adding to
    // it — the redirects are looked up by PATH, so this costs one small query,
    // not a sweep of the shop's redirect list.
    const existing = await findRedirects(admin, [decision.fromPath, decision.toPath]);

    // Anything that pointed AT the old path now points at the new one. This is
    // the a→b→c case: `/a→/b` becomes `/a→/c`.
    const stale = existing.filter(
      (r) => samePath(r.target, decision.fromPath) && !samePath(r.path, decision.toPath),
    );
    for (const redirect of stale) {
      const repointed = await updateRedirect(admin, redirect.id, { path: redirect.path, target: decision.toPath });
      if (!repointed.redirect?.id) {
        logger.warn("[HandleRedirect] Could not repoint an older redirect", {
          context: "HandleRedirect", shop, path: redirect.path, to: decision.toPath,
        });
      }
    }

    // A redirect sitting ON the new path has to go, and not only because
    // `/a→/b` plus `/b→/a` is a cycle: the new path is a LIVE page again, and
    // Shopify serves the redirect in preference to it. Leaving the row would
    // make the very object the merchant just renamed unreachable at its own
    // URL. This is the rename-back case (a→b, then b→a).
    for (const shadowing of existing.filter((r) => samePath(r.path, decision.toPath))) {
      const removed = await deleteRedirect(admin, shadowing.id);
      if (!removed.deletedId) {
        logger.warn("[HandleRedirect] A redirect still shadows the new URL", {
          context: "HandleRedirect", shop, path: shadowing.path, target: shadowing.target,
        });
      }
    }

    // Shopify rejects a second redirect on the same path, so an existing one
    // for `fromPath` is UPDATED rather than re-created.
    const onSamePath = existing.find((r) => samePath(r.path, decision.fromPath));
    const result = onSamePath
      ? await updateRedirect(admin, onSamePath.id, { path: decision.fromPath, target: decision.toPath })
      : await createRedirect(admin, { path: decision.fromPath, target: decision.toPath });

    // Echo, same rule as everywhere else: userErrors alone is not the answer.
    if (!result.redirect?.id) {
      const detail = result.userErrors?.map((e) => e.message).join("; ") || "no redirect returned";
      logger.warn("[HandleRedirect] Shopify did not confirm the redirect", {
        context: "HandleRedirect",
        shop,
        from: decision.fromPath,
        to: decision.toPath,
        detail,
      });
      return { created: false, skippedReason: "notConfirmed", noteCode: "notConfirmed", fromPath: decision.fromPath };
    }

    logger.info("[HandleRedirect] Created", {
      context: "HandleRedirect",
      shop,
      from: decision.fromPath,
      to: decision.toPath,
      reused: !!onSamePath,
      repointed: stale.length,
    });
    return { created: true, noteCode: okCode, fromPath: decision.fromPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[HandleRedirect] Failed", { context: "HandleRedirect", shop, error: message });
    return { created: false, skippedReason: "error", noteCode: "failed", fromPath: decision.fromPath };
  }
}

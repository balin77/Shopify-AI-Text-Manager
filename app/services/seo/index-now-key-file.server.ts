/**
 * IndexNow key file at the storefront ROOT, via a Shopify URL redirect.
 *
 * Why this exists — measured 2026-08-15 on a live shop, not assumed: serving
 * the key from the app proxy works as delivery (HTTP 200, no redirect, content
 * matches, host matches the primary domain) but every submission comes back
 *
 *   422 InvalidRequestParameters
 *   "One or more URLs are not related to your site verified through the
 *    keylocation parameter."
 *
 * A non-root `keyLocation` only verifies its OWN sub-path, so a `/products/…`
 * URL is unrelated to a key under `/apps/contentpilot/…`. Shopify lets no app
 * put a file at the storefront root — but it does let one create a URL
 * redirect, and a redirect target may be a path on the same shop. So:
 *
 *   https://<host>/<key>.txt   →(301)→   /apps/contentpilot/indexnow-key
 *
 * The whole chain stays on ONE host (no cdn.shopify.com hop, which would leave
 * the declared host and is exactly what an ownership check objects to), the app
 * proxy keeps doing the actual serving, and `keyLocation` finally names a root
 * path.
 *
 * MEASURED on a live shop 2026-08-15: `/<key>.txt` → 301 (same host) →
 * `/apps/contentpilot/indexnow-key` → 200 with the key, and the submission
 * answered **202 Accepted**. The engine follows the same-host 301, so this
 * arrangement is the working one — re-run the IndexNow probe before changing
 * either half.
 *
 * Uses `write_online_store_navigation`, which the app already declares.
 *
 * ── Echo rule ───────────────────────────────────────────────────────────────
 * Same discipline as every other write in this app: the redirect id is only
 * stored after Shopify ECHOES the created/updated redirect back with the path
 * and target we asked for, and the local id is only cleared once a delete is
 * confirmed. `userErrors: []` alone is never treated as success.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";
import { KEY_PROXY_PATH } from "./index-now.service";

interface GraphqlCapableAdmin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql: (query: string, options?: any) => Promise<{ json: () => Promise<any> }>;
}

const REDIRECT_CREATE = `#graphql
  mutation indexNowRedirectCreate($input: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $input) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`;

const REDIRECT_UPDATE = `#graphql
  mutation indexNowRedirectUpdate($id: ID!, $input: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $input) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`;

const REDIRECT_DELETE = `#graphql
  mutation indexNowRedirectDelete($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedRedirectId
      userErrors { field message }
    }
  }
`;

const REDIRECT_BY_PATH = `#graphql
  query indexNowRedirectByPath($query: String!) {
    urlRedirects(first: 5, query: $query) {
      edges { node { id path target } }
    }
  }
`;

/** The storefront path the key is served from: `/<key>.txt`. */
export function keyFilePath(key: string): string {
  return `/${key}.txt`;
}

interface RedirectEcho {
  id: string;
  path: string;
  target: string;
}

/** Shopify echoed a redirect that actually matches what we asked for. */
function echoMatches(echo: RedirectEcho | null | undefined, path: string, target: string): boolean {
  return !!echo?.id && echo.path === path && echo.target === target;
}

function userErrorText(errors: Array<{ message?: string }> | undefined): string {
  return (errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
}

export interface EnsureRedirectResult {
  ok: boolean;
  redirectId: string | null;
  error?: string;
}

/**
 * Make `https://<host>/<key>.txt` resolve to the app-proxy key route, and
 * persist the redirect's id. Idempotent: safe to call on every section visit.
 *
 * Order of attempts:
 *   1. A stored id → update it in place (repairs a target someone edited, and
 *      confirms the redirect still exists).
 *   2. Create it.
 *   3. "Path has already been taken" → adopt the existing redirect for that
 *      path and point it at us, instead of failing forever on a leftover from
 *      an earlier install.
 */
export async function ensureKeyRedirect(
  admin: GraphqlCapableAdmin,
  db: PrismaClient,
  shop: string,
  config: { key: string; keyRedirectId: string | null },
): Promise<EnsureRedirectResult> {
  const path = keyFilePath(config.key);
  const target = KEY_PROXY_PATH;

  const store = async (id: string): Promise<EnsureRedirectResult> => {
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { keyRedirectId: id } });
    return { ok: true, redirectId: id };
  };

  try {
    if (config.keyRedirectId) {
      const res = await admin.graphql(REDIRECT_UPDATE, {
        variables: { id: config.keyRedirectId, input: { path, target } },
      });
      const body = await res.json();
      const echo = body?.data?.urlRedirectUpdate?.urlRedirect as RedirectEcho | undefined;
      if (echoMatches(echo, path, target)) return await store(echo!.id);
      // Deleted in the admin, or otherwise unusable — fall through and recreate.
      logger.warn(`[IndexNow] Stored key redirect for ${shop} could not be updated, recreating`, {
        errors: userErrorText(body?.data?.urlRedirectUpdate?.userErrors),
      });
    }

    const res = await admin.graphql(REDIRECT_CREATE, { variables: { input: { path, target } } });
    const body = await res.json();
    const echo = body?.data?.urlRedirectCreate?.urlRedirect as RedirectEcho | undefined;
    if (echoMatches(echo, path, target)) return await store(echo!.id);

    const errors = body?.data?.urlRedirectCreate?.userErrors as Array<{ message?: string }> | undefined;
    const errorText = userErrorText(errors);

    // A redirect already occupies that path (leftover from an earlier install,
    // or a merchant's own). Adopt it rather than failing on every attempt.
    const existing = await findRedirectByPath(admin, path);
    if (existing) {
      if (existing.target === target) return await store(existing.id);
      const upd = await admin.graphql(REDIRECT_UPDATE, {
        variables: { id: existing.id, input: { path, target } },
      });
      const updBody = await upd.json();
      const updEcho = updBody?.data?.urlRedirectUpdate?.urlRedirect as RedirectEcho | undefined;
      if (echoMatches(updEcho, path, target)) return await store(updEcho!.id);
      return {
        ok: false,
        redirectId: null,
        error: userErrorText(updBody?.data?.urlRedirectUpdate?.userErrors) || errorText || "update failed",
      };
    }

    logger.warn(`[IndexNow] Could not create the key redirect for ${shop}`, { errors: errorText });
    return { ok: false, redirectId: null, error: errorText || "create failed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[IndexNow] Key redirect call failed for ${shop}`, { error: message });
    return { ok: false, redirectId: null, error: message };
  }
}

async function findRedirectByPath(
  admin: GraphqlCapableAdmin,
  path: string,
): Promise<RedirectEcho | null> {
  try {
    const res = await admin.graphql(REDIRECT_BY_PATH, { variables: { query: `path:${path}` } });
    const body = await res.json();
    const nodes: RedirectEcho[] = (body?.data?.urlRedirects?.edges ?? [])
      .map((e: { node?: RedirectEcho }) => e?.node)
      .filter(Boolean);
    // The search is fuzzy — only an EXACT path match is ours to touch.
    return nodes.find((n) => n.path === path) ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove the redirect when IndexNow is switched off, so disabling the feature
 * doesn't leave a redirect behind in the merchant's admin. The local id is
 * cleared only once Shopify CONFIRMS the deletion (echo rule) — otherwise we
 * would forget about a redirect that still exists and could never clean it up.
 */
export async function removeKeyRedirect(
  admin: GraphqlCapableAdmin,
  db: PrismaClient,
  shop: string,
  redirectId: string | null,
): Promise<boolean> {
  if (!redirectId) return true;
  try {
    const res = await admin.graphql(REDIRECT_DELETE, { variables: { id: redirectId } });
    const body = await res.json();
    const deleted = body?.data?.urlRedirectDelete?.deletedRedirectId;
    if (deleted !== redirectId) {
      logger.warn(`[IndexNow] Key redirect for ${shop} was not confirmed deleted - keeping the id`, {
        errors: userErrorText(body?.data?.urlRedirectDelete?.userErrors),
      });
      return false;
    }
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { keyRedirectId: null } });
    return true;
  } catch (err) {
    logger.warn(`[IndexNow] Key redirect delete failed for ${shop}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

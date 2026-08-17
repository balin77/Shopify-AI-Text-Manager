/**
 * Google OAuth callback (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * Lives OUTSIDE the app.* tree (not in the Shopify admin iframe / App Bridge):
 * Google redirects the TOP window here with ?code&state. We verify the signed
 * state (CSRF + carries shop/host), exchange the code, pick a verified GSC
 * property, store the encrypted connection, then bounce back into the embedded
 * app's Search Console section.
 *
 * The `connect` link in the section is opened with target="_top", so this top-
 * level navigation and the bounce-back are correct for the embedded app.
 */

import { redirect, type LoaderFunctionArgs } from "react-router";
import { logger } from "~/utils/logger.server";
import {
  consumeOAuthState,
  exchangeCodeForTokens,
  listSites,
  pickProperty,
  saveGscConnection,
  updateGscProperty,
  getGscConnection,
  emailFromIdToken,
} from "../services/google-search-console.server";

function appReturn(shop: string, host: string, status: string): string {
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const params = new URLSearchParams({ shop });
  if (host) params.set("host", host);
  params.set("gsc", status);
  return `${appUrl}/app/seo/search-console?${params.toString()}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // consumeOAuthState (not verifyOAuthState) so a second callback replaying
  // the same state — the request retried, the tab duplicated, or an attacker
  // who observed the redirect — is rejected instead of re-running connect.
  const verified = state ? consumeOAuthState(state) : null;
  if (!verified) {
    // No trustworthy shop/host to bounce back to — fail safe to login. Also
    // reached on a replayed state (nonce already consumed).
    logger.warn("[GSC callback] invalid, missing, or already-used OAuth state");
    return redirect("/auth/login");
  }
  const { shop, host, customDomain } = verified;

  if (oauthError || !code) {
    logger.warn("[GSC callback] OAuth denied/aborted", { context: "GSC", error: oauthError || "no_code" });
    return redirect(appReturn(shop, host, "denied"));
  }

  try {
    const { db } = await import("../db.server");
    const tokens = await exchangeCodeForTokens(code);
    const sites = await listSites(tokens.accessToken);
    if (sites.length === 0) {
      return redirect(appReturn(shop, host, "no_sites"));
    }
    // customDomain travels in the signed OAuth state (captured when the flow
    // started, see app.seo.search-console.tsx) so a custom-domain store still
    // matches its verified property here. `property` is null when NEITHER the
    // shop domain nor the custom domain matches any verified site — pickProperty
    // deliberately refuses to guess sites[0] in that case (see its doc comment).
    const property = pickProperty(sites, shop, customDomain);
    const email = emailFromIdToken(tokens.idToken);
    // Empty-string sentinel: propertyUrl is a required (non-nullable) column,
    // so "no property picked yet" is represented as "" rather than a schema
    // migration. The Search Console section renders a property picker whenever
    // it reads back an empty propertyUrl.
    const propertyToStore = property ?? "";

    if (tokens.refreshToken) {
      await saveGscConnection(db, shop, { propertyUrl: propertyToStore, refreshToken: tokens.refreshToken, email });
    } else if (await getGscConnection(db, shop)) {
      // Google omits the refresh_token when the user already granted consent and
      // no new one was minted — keep the stored token, just refresh property/email.
      await updateGscProperty(db, shop, propertyToStore, email);
    } else {
      // No refresh token and no prior connection → cannot persist; ask to retry.
      return redirect(appReturn(shop, host, "no_refresh_token"));
    }

    return redirect(appReturn(shop, host, property ? "connected" : "select_property"));
  } catch (e) {
    logger.error("[GSC callback] connection failed", {
      context: "GSC",
      error: e instanceof Error ? e.message : String(e),
    });
    return redirect(appReturn(shop, host, "error"));
  }
};

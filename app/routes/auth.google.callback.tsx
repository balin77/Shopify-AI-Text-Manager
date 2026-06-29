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

import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/utils/logger.server";
import {
  verifyOAuthState,
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

  const verified = state ? verifyOAuthState(state) : null;
  if (!verified) {
    // No trustworthy shop/host to bounce back to — fail safe to login.
    logger.warn("[GSC callback] invalid or missing OAuth state");
    return redirect("/auth/login");
  }
  const { shop, host } = verified;

  if (oauthError || !code) {
    logger.warn("[GSC callback] OAuth denied/aborted", { context: "GSC", error: oauthError || "no_code" });
    return redirect(appReturn(shop, host, "denied"));
  }

  try {
    const { db } = await import("../db.server");
    const tokens = await exchangeCodeForTokens(code);
    const sites = await listSites(tokens.accessToken);
    const property = pickProperty(sites, shop);
    if (!property) {
      return redirect(appReturn(shop, host, "no_sites"));
    }
    const email = emailFromIdToken(tokens.idToken);

    if (tokens.refreshToken) {
      await saveGscConnection(db, shop, { propertyUrl: property, refreshToken: tokens.refreshToken, email });
    } else if (await getGscConnection(db, shop)) {
      // Google omits the refresh_token when the user already granted consent and
      // no new one was minted — keep the stored token, just refresh property/email.
      await updateGscProperty(db, shop, property, email);
    } else {
      // No refresh token and no prior connection → cannot persist; ask to retry.
      return redirect(appReturn(shop, host, "no_refresh_token"));
    }

    return redirect(appReturn(shop, host, "connected"));
  } catch (e) {
    logger.error("[GSC callback] connection failed", {
      context: "GSC",
      error: e instanceof Error ? e.message : String(e),
    });
    return redirect(appReturn(shop, host, "error"));
  }
};

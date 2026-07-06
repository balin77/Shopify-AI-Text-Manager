/**
 * API Route: generic ThemeContent-backed content details, parameterised by
 * domain. Serves every ThemeContent rubric — the six Theme sub-tabs
 * (domain="theme", scoped by the repeatable `rt` resource-type param) as well
 * as System / Online-Store-Extras / Selling-Plans / Cookie-Banner.
 *
 * Path: /api/theme-content/:domain/*   (* = groupId, may contain slashes)
 *
 * Thin delegate over the shared ThemeContent API helpers.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import {
  loadThemeGroupResponse,
  handleThemeContentActionResponse,
  isThemeContentDomain,
} from "~/services/theme-content-api.server";
import { resolveSelectedThemeId } from "~/services/theme-selection.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const domain = params.domain;
  const groupId = params["*"];

  if (!isThemeContentDomain(domain)) {
    return json({ success: false, error: "Unknown content domain" }, { status: 400 });
  }
  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const search = url.searchParams.get("search") || "";
  // `rt` scopes a Theme sub-tab to its Shopify resource type(s) (repeatable).
  const resourceTypes = url.searchParams.getAll("rt");

  try {
    const { db } = await import("../db.server");
    const selectedThemeId = (await resolveSelectedThemeId(session.shop, admin)) ?? undefined;
    return await loadThemeGroupResponse({ db, shop: session.shop, domain, groupId, page, limit, search, resourceTypes, selectedThemeId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[API-THEME-CONTENT] Error loading group", { context: "ThemeContent", domain, groupId, error: msg });
    return json({ success: false, error: "Failed to load content group." }, { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const domain = params.domain;
  const groupId = params["*"];

  if (!isThemeContentDomain(domain)) {
    return json({ success: false, error: "Unknown content domain" }, { status: 400 });
  }
  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const resourceTypes = formData.getAll("rt").map(String);
    const { db } = await import("../db.server");
    const selectedThemeId = (await resolveSelectedThemeId(session.shop, admin)) ?? undefined;
    return await handleThemeContentActionResponse({ db, admin, session, formData, domain, groupId, resourceTypes, selectedThemeId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[API-THEME-CONTENT-ACTION] Error", { context: "ThemeContent", domain, error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json({ success: false, error: "Content operation failed" }, { status: 500 });
  }
};

/**
 * Keyword read/write endpoint for the content editor's SEO sidebar
 * (see app/components/SeoSidebar.tsx). Thin wrapper around the CRUD helpers
 * in app/services/seo/keywords.service.ts — the same ones app.seo.keywords.tsx
 * uses — so the sidebar's keywords panel and the Keywords tab never disagree
 * about what's stored for an item.
 *
 * Since the keywords expansion (PLAN_KEYWORDS_EXPANSION.md Phase 1) an item
 * tracks up to MAX_KEYWORDS_PER_ITEM keywords (1 primary + secondaries) per
 * locale. The sidebar edits whichever locale the editor is currently on, so
 * every request carries a `locale` ("" = the shop's primary locale, the
 * SeoKeyword convention). Every mutation answers with the fresh keyword list
 * for THAT locale so the client can render without a follow-up load.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  assignKeyword,
  getItemKeywords,
  promoteAssignment,
  removeAssignment,
  findPrimaryElsewhere,
  MAX_KEYWORD_LENGTH,
  type KeywordResourceType,
  type KeywordRole,
} from "../services/seo/keywords.service";
import { getFormString } from "../utils/form-data.utils";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import type { DataResponse } from "~/types/data-response";

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

export interface SidebarKeyword {
  id: string; // assignment id
  keyword: string;
  role: KeywordRole;
}

async function loadSidebarKeywords(
  shop: string,
  resourceId: string,
  locale: string,
): Promise<SidebarKeyword[]> {
  const rows = await getItemKeywords(db, shop, resourceId, locale);
  return rows.map((r) => ({ id: r.id, keyword: r.keyword, role: r.role }));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId") || "";
  // Reads are NOT validated against the shop's published locales on purpose:
  // getCachedShopLocales resolves with [] when the lookup fails, and rejecting
  // on that would empty the merchant's keyword list exactly when Shopify is
  // having a bad minute. The query is shop-scoped either way, so an unknown
  // locale simply returns no rows. Writes below do validate (fail closed).
  const locale = url.searchParams.get("locale") || "";
  if (!resourceId) {
    return json({ keywords: [] as SidebarKeyword[] });
  }

  return json({ keywords: await loadSidebarKeywords(shop, resourceId, locale) });
};

type ActionResult =
  | { ok: true; keywords: SidebarKeyword[] }
  | { ok: false; error: "invalid" | "tooMany" | "primaryExists" }
  // Cross-item cannibalization pre-check (plan §7.1) — the sidebar shows a
  // warning with an "add anyway" retry (acceptCannibalization=true).
  | { ok: false; error: "cannibalization"; existingItemTitle: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const op = getFormString(form, "op");
  const resourceId = getFormString(form, "resourceId");
  if (!resourceId) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  // The locale the sidebar is on ("" = primary). Only CREATION validates it
  // against the shop's published locales (below); remove/makePrimary must keep
  // working after a locale is unpublished — otherwise the merchant would be
  // locked out of deleting the very rows that locale left behind.
  const localeInput = getFormString(form, "locale");

  if (op === "add") {
    const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
    const keyword = getFormString(form, "keyword").trim();
    const role = getFormString(form, "role") as KeywordRole;
    if (
      !RESOURCE_TYPES.includes(resourceType) ||
      !keyword ||
      keyword.length > MAX_KEYWORD_LENGTH ||
      (role !== "primary" && role !== "secondary")
    ) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Same fail-closed rule as the sibling write path in app.seo.keywords.tsx,
    // so a keyword can never be created under a locale the storefront doesn't
    // serve. "" (primary) is always accepted without a lookup.
    let locale = "";
    if (localeInput) {
      const shopLocales = await getCachedShopLocales(admin, shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }
    // Cross-item cannibalization guard (plan §7.1), bypassed after the
    // merchant confirmed via "add anyway".
    const acceptCannibalization = getFormString(form, "acceptCannibalization") === "true";
    if (role === "primary" && !acceptCannibalization) {
      const elsewhere = await findPrimaryElsewhere(db, shop, {
        keyword,
        locale,
        resourceType,
        excludeResourceId: resourceId,
      });
      if (elsewhere) {
        const model =
          resourceType === "Product"
            ? db.product
            : resourceType === "Collection"
              ? db.collection
              : resourceType === "Article"
                ? db.article
                : db.page;
        const item = await (model as any).findFirst({
          where: { shop, id: elsewhere.resourceId },
          select: { title: true },
        });
        return json<ActionResult>(
          { ok: false, error: "cannibalization", existingItemTitle: item?.title || elsewhere.resourceId },
          { status: 409 },
        );
      }
    }
    const result = await assignKeyword(db, shop, {
      resourceType,
      resourceId,
      keyword,
      locale,
      role,
      // The sidebar only sends role=primary when the item has no primary yet;
      // hitting an existing one anyway (concurrent tab) is surfaced, not
      // silently demoted.
      demoteExisting: false,
    });
    if (!result.ok) {
      return json<ActionResult>({ ok: false, error: result.reason }, { status: 409 });
    }
    return json<ActionResult>({ ok: true, keywords: await loadSidebarKeywords(shop, resourceId, locale) });
  }

  if (op === "remove" || op === "makePrimary") {
    const id = getFormString(form, "id");
    if (!id) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    if (op === "remove") await removeAssignment(db, shop, id);
    else await promoteAssignment(db, shop, id);
    // Both helpers resolve the row's own locale internally; localeInput only
    // selects which list to hand back for re-render.
    return json<ActionResult>({
      ok: true,
      keywords: await loadSidebarKeywords(shop, resourceId, localeInput),
    });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

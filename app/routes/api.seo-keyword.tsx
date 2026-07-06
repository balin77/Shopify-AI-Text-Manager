/**
 * Target-keyword read/write endpoint for the content editor's SEO sidebar
 * (see app/components/SeoSidebar.tsx). Thin wrapper around the CRUD helpers
 * in app/services/seo/keywords.service.ts — the same ones app.seo.keywords.tsx
 * uses — so the sidebar's "Target keyword" panel and the Keywords tab never
 * disagree about what's stored for an item.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { setKeyword, MAX_KEYWORD_LENGTH, type KeywordResourceType } from "../services/seo/keywords.service";
import { getFormString } from "../utils/form-data.utils";

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId") || "";
  if (!resourceId) {
    return json({ keyword: null });
  }

  const row = await db.seoKeyword.findUnique({
    where: { shop_resourceId_locale: { shop, resourceId, locale: "" } },
    select: { keyword: true },
  });
  return json({ keyword: row?.keyword ?? null });
};

type ActionResult = { ok: true; keyword: string | null } | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const resourceId = getFormString(form, "resourceId");
  const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
  const keyword = getFormString(form, "keyword").trim();

  if (!resourceId || !RESOURCE_TYPES.includes(resourceType) || keyword.length > MAX_KEYWORD_LENGTH) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  if (!keyword) {
    // Empty save removes tracking for this item/locale entirely.
    await db.seoKeyword.deleteMany({ where: { shop, resourceId, locale: "" } });
    return json<ActionResult>({ ok: true, keyword: null });
  }

  await setKeyword(db, shop, { resourceType, resourceId, keyword });
  return json<ActionResult>({ ok: true, keyword });
};

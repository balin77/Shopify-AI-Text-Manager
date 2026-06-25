/**
 * Cookie-Banner rubric (Plan §7.5) — part of "Online Store", entitled on every
 * tier (same gate as onlineStoreExtras).
 *
 * Loader and page UI are identical to the other ThemeContent-backed rubrics
 * (Templates, System, OnlineStoreExtras, Selling-Plans), just with
 * domain="customer_privacy". The route action is custom: the foreign-locale
 * `updateContent` save has to hit Shopify's `unstable` endpoint because the
 * pinned stable API (2025-10) rejects COOKIE_BANNER GIDs in translationsRegister
 * with "invalid id" — only the resource-agnostic part of that mutation was a
 * safe bet; for this specific resource type it isn't. Every other action type
 * (loadTranslations / generateAIText / translate* / etc.) is pure local DB or
 * pure AI work, so we delegate them to the standard route-action factory.
 *
 * Why "customer_privacy" instead of "cookie_banner"? Brave Shields and the
 * EasyPrivacy filter list block any URL containing the substring
 * "cookie_banner" — the API call to /api/theme-content/cookie_banner/... was
 * silently dropped with net::ERR_BLOCKED_BY_CLIENT. Renaming the data path to
 * Shopify's own term ("Customer Privacy API") clears the filter without
 * changing user-facing labels or code-level identifiers.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { COOKIE_BANNER_CONFIG } from "../config/content-fields.config";
import { ThemeContentDomainPage } from "../components/ThemeContentDomainPage";
import { makeThemeDomainLoader, makeThemeContentRouteAction } from "../utils/theme-content-domain.server";
import {
  writeCookieBannerTranslations,
  removeCookieBannerTranslations,
  type CookieBannerSession,
} from "../utils/cookie-banner-availability.server";
import { getFormString } from "../utils/form-data.utils";
import { logger } from "~/utils/logger.server";

export const loader = makeThemeDomainLoader("customer_privacy", "COOKIE_BANNER");

const baseAction = makeThemeContentRouteAction("customer_privacy");

export const action = async (args: ActionFunctionArgs) => {
  // Peek at the action type without consuming the body — baseAction still needs
  // to read it on delegation.
  const peeked = await args.request.clone().formData();
  const actionType = getFormString(peeked, "action");
  if (actionType !== "updateContent") return baseAction(args);
  return handleCookieBannerUpdate(args);
};

async function handleCookieBannerUpdate({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const cbSession: CookieBannerSession = { shop: session.shop, accessToken: session.accessToken };

  const formData = await request.formData();
  const itemId = getFormString(formData, "itemId");
  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  const groupId = itemId?.replace("group_", "");

  if (!groupId) {
    return json({ success: false, error: "groupId is required" }, { status: 400 });
  }

  // Cookie-banner source text lives in Shopify's Customer Privacy settings, not
  // in any resource we can write to via translationsRegister or themeFilesUpsert.
  // Block primary-locale saves here so an accidental editor-state mishap can't
  // silently swallow merchant edits.
  if (locale === primaryLocale) {
    return json(
      {
        success: false,
        error: "Cookie banner source text is managed in Shopify admin → Customer Privacy and cannot be edited here.",
      },
      { status: 400 }
    );
  }

  const { db } = await import("../db.server");
  const themeGroups = await db.themeContent.findMany({
    where: { shop: session.shop, groupId, domain: "customer_privacy" },
  });
  if (themeGroups.length === 0) {
    return json({ success: false, error: "Group not found" }, { status: 404 });
  }

  // Pull stored digests + the key→resourceId map out of themeContent. Cookie
  // banner is single-resource today but keep the multi-resource shape so the
  // logic matches handleUpdateContent and won't surprise us if Shopify ever
  // splits the banner into multiple resources.
  type StoredItem = { key: string; value?: string | null; digest?: string | null };
  const digestByKey = new Map<string, string>();
  const keyToResourceId = new Map<string, string>();
  const allKeys = new Set<string>();
  for (const group of themeGroups) {
    const items = group.translatableContent as unknown as StoredItem[];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item?.key) continue;
      allKeys.add(item.key);
      if (item.digest) digestByKey.set(item.key, item.digest);
      keyToResourceId.set(item.key, group.resourceId);
    }
  }

  // Read the submitted field values — same per-key pattern as
  // handleUpdateContent (the editor flattens updatedFields into the formData).
  const updatedFields: Record<string, string> = {};
  for (const key of allKeys) {
    const value = formData.get(key);
    if (typeof value === "string") updatedFields[key] = value;
  }
  if (Object.keys(updatedFields).length === 0) {
    return json({ success: true, actionType: "updateContent" });
  }

  // Partition into register-vs-remove per resource.
  const registerByRes = new Map<
    string,
    Array<{ key: string; value: string; locale: string; translatableContentDigest: string }>
  >();
  const removeByRes = new Map<string, string[]>();
  const skippedNoDigest: string[] = [];

  for (const [key, value] of Object.entries(updatedFields)) {
    const resId = keyToResourceId.get(key);
    if (!resId) continue;
    if (value === "") {
      const arr = removeByRes.get(resId) ?? [];
      arr.push(key);
      removeByRes.set(resId, arr);
      continue;
    }
    const digest = digestByKey.get(key);
    if (!digest) {
      skippedNoDigest.push(key);
      continue;
    }
    const arr = registerByRes.get(resId) ?? [];
    arr.push({ key, value, locale, translatableContentDigest: digest });
    registerByRes.set(resId, arr);
  }

  if (skippedNoDigest.length > 0) {
    logger.warn("[CookieBanner] Save — keys without stored digest were skipped", {
      context: "CookieBanner",
      shop: session.shop,
      keys: skippedNoDigest,
    });
  }

  const shopifyErrors: string[] = [];
  let totalOps = 0;
  let totalFailed = 0;

  for (const [resId, translations] of registerByRes) {
    totalOps += translations.length;
    const res = await writeCookieBannerTranslations(cbSession, resId, translations);
    if (!res.ok) {
      totalFailed += translations.length;
      shopifyErrors.push(res.error ?? "register failed");
    }
  }
  for (const [resId, keys] of removeByRes) {
    totalOps += keys.length;
    const res = await removeCookieBannerTranslations(cbSession, resId, keys, [locale]);
    if (!res.ok) {
      totalFailed += keys.length;
      shopifyErrors.push(res.error ?? "remove failed");
    }
  }

  if (totalOps > 0 && totalFailed >= totalOps) {
    return json(
      { success: false, error: `Shopify rejected all changes: ${shopifyErrors.join("; ")}` },
      { status: 500 }
    );
  }

  // Mirror handleUpdateContent's local-DB step so the editor sees its own save.
  for (const [key, value] of Object.entries(updatedFields)) {
    const resId = keyToResourceId.get(key);
    if (!resId) continue;
    if (value === "") {
      await db.themeTranslation.deleteMany({
        where: { shop: session.shop, groupId, key, locale, domain: "customer_privacy" },
      });
    } else {
      await db.themeTranslation.upsert({
        where: {
          shop_resourceId_groupId_key_locale: {
            shop: session.shop,
            resourceId: resId,
            groupId,
            key,
            locale,
          },
        },
        create: {
          shop: session.shop,
          groupId,
          resourceId: resId,
          domain: "customer_privacy",
          locale,
          key,
          value,
        },
        update: { value, updatedAt: new Date() },
      });
    }
  }

  return json({ success: true });
}

export default function CookieBannerPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeContentDomainPage
      data={data}
      config={COOKIE_BANNER_CONFIG}
      apiBasePath="/api/theme-content/customer_privacy"
      planContentType="onlineStoreExtras"
    />
  );
}

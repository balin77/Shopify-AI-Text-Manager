/**
 * Keyword tracking section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * Store one target keyword per item and see a local on-page analysis (presence
 * in title/H1/meta/SEO-title/body + density + position). Read-only scoring is
 * computed server-side from the DB content cache via analyzeOnPage. GSC ranking
 * data (Phase 6) plugs into the same rows later.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { BlockStack, Banner, Text, Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SubNavBar, type SubNavBarItem } from "../components/nav/SubNavBar";
import { HelpTooltip } from "../components/HelpTooltip";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { LibraryTab } from "../components/seo/keywords/LibraryTab";
import { AssignmentsTab } from "../components/seo/keywords/AssignmentsTab";
import {
  analyzeOnPage,
  listAssignments,
  assignKeyword,
  assignMany,
  promoteAssignment,
  removeAssignment,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupPriority,
  findPrimaryElsewhere,
  findCannibalizationConflicts,
  getGroupKeywords,
  countAllKeywords,
  listAllKeywords,
  countUngrouped,
  listUngrouped,
  addKeywordsToGroup,
  removeKeywordFromGroup,
  setKeywordPriority,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS_PER_ITEM,
  buildTranslatedContentInput,
  TRANSLATED_CONTENT_KEYS,
  type KeywordResourceType,
  type KeywordRole,
  type TranslationRow,
  type GroupKeywordRow,
  type AssignManyTarget,
  type AssignManySkip,
} from "../services/seo/keywords.service";
import { parseKeywordsCsv } from "../services/seo/keywords-csv";
// Loader-only import (server module) — tree-shaken from the client bundle.
import { getSuggestionsAvailability } from "../services/seo/keyword-suggestions.service";
import type { DistributionSuggestResult } from "./api-ai-handlers/keyword-distribution.handler";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { getFormString } from "../utils/form-data.utils";

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

interface ItemContent {
  title: string;
  seoTitle: string;
  metaDescription: string;
  bodyHtml: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  // Shop locales (60s-cached) drive both the add-form's locale picker and the
  // per-row translated-content analysis below. Primary locale is stored as ""
  // in SeoKeyword (existing convention) — its real Shopify code is only used
  // for display (the Locale column badge).
  const shopLocales = await getCachedShopLocales(admin, shop);
  const primaryLocale = shopLocales.find((l: any) => l.primary);
  const secondaryLocales = shopLocales.filter((l: any) => !l.primary && l.published);

  // Rows are ASSIGNMENTS since the keywords expansion (one keyword can be
  // assigned to several items; an item carries 1 primary + N secondaries).
  const rows = await listAssignments(db, shop);

  // Resolve item content for the tracked keywords, batched per type.
  const idsByType: Record<string, string[]> = {};
  for (const row of rows) {
    (idsByType[row.resourceType] ||= []).push(row.resourceId);
  }
  const content = new Map<string, ItemContent>();
  const put = (
    id: string,
    c: { title: string; seoTitle?: string | null; seoDescription?: string | null; body?: string | null },
  ) =>
    content.set(id, {
      title: c.title,
      seoTitle: c.seoTitle ?? "",
      metaDescription: c.seoDescription ?? "",
      bodyHtml: c.body ?? "",
    });

  await Promise.all([
    idsByType.Product?.length
      ? db.product
          .findMany({
            where: { shop, id: { in: idsByType.Product } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Collection?.length
      ? db.collection
          .findMany({
            where: { shop, id: { in: idsByType.Collection } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Article?.length
      ? db.article
          .findMany({
            where: { shop, id: { in: idsByType.Article } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
    idsByType.Page?.length
      ? db.page
          .findMany({
            where: { shop, id: { in: idsByType.Page } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
  ]);

  // Locale rows (locale !== "") are analyzed against their TRANSLATED content
  // (ContentTranslation), not the base table — a merchant tracking a keyword
  // for the French edition of a product needs to know if the FRENCH title/meta
  // actually contain it, not the German original. One batched findMany over
  // every (resourceId, locale) pair the tracked rows touch, then indexed below.
  const localeRows = rows.filter((row) => row.locale !== "");
  const translationIndex = new Map<string, TranslationRow[]>();
  if (localeRows.length > 0) {
    const resourceIds = Array.from(new Set(localeRows.map((row) => row.resourceId)));
    const locales = Array.from(new Set(localeRows.map((row) => row.locale)));
    const translations = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceId: { in: resourceIds },
        locale: { in: locales },
        key: { in: TRANSLATED_CONTENT_KEYS },
      },
      select: { resourceId: true, locale: true, key: true, value: true },
    });
    for (const t of translations) {
      const bucketKey = `${t.resourceId}::${t.locale}`;
      let bucket = translationIndex.get(bucketKey);
      if (!bucket) {
        bucket = [];
        translationIndex.set(bucketKey, bucket);
      }
      bucket.push(t);
    }
  }

  const keywords = rows.map((row) => {
    const c = content.get(row.resourceId);
    const analysisInput =
      row.locale === ""
        ? {
            title: c?.title ?? "",
            seoTitle: c?.seoTitle ?? "",
            metaDescription: c?.metaDescription ?? "",
            bodyHtml: c?.bodyHtml ?? "",
          }
        : buildTranslatedContentInput(translationIndex.get(`${row.resourceId}::${row.locale}`) ?? []);
    const analysis = analyzeOnPage({
      keyword: row.keyword,
      ...analysisInput,
      // Product/Collection H1s come from the title (themes render it as the
      // page H1); Article/Page may also carry an explicit <h1> in the body.
      resourceType: row.resourceType as KeywordResourceType,
    });
    return {
      id: row.id,
      keywordId: row.keywordId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      keyword: row.keyword,
      locale: row.locale,
      role: row.role,
      priority: row.priority,
      // Display code for the Locale column badge: primary rows are stored as
      // "" so they show the shop's actual primary locale code, not a blank badge.
      localeDisplay: row.locale || primaryLocale?.locale || "",
      itemTitle: c?.title ?? "",
      itemMissing: !c,
      intent: row.intent, // threaded for the intent badge + filter (§7.2)
      // Only the primary carries the 0-100 on-page score — it is
      // presence-weighted and would dilute or double-count across several
      // keywords. Secondaries keep presence/density (factual per keyword).
      score: row.role === "primary" ? analysis.score : null,
      densityPct: analysis.densityPct,
      densityBand: analysis.densityBand,
      presence: analysis.presence,
      gscPosition: row.gscPosition,
    };
  });

  // Stable listing: item → role (primary first) → keyword, so an item's
  // keyword block reads as one visual unit instead of shuffling on updates.
  keywords.sort(
    (a, b) =>
      (a.itemTitle || a.resourceId).localeCompare(b.itemTitle || b.resourceId) ||
      a.role.localeCompare(b.role) ||
      a.keyword.localeCompare(b.keyword),
  );

  // Cannibalization conflicts (§7.1): same keyword primary on ≥2 items of the
  // same type. Pure over the loaded assignment list; item titles resolved
  // from the content map already built above.
  const conflicts = findCannibalizationConflicts(rows).map((c) => ({
    keyword: c.keyword,
    locale: c.locale,
    resourceType: c.resourceType,
    itemTitles: c.resourceIds.map((id) => content.get(id)?.title || id),
  }));

  // Intent classification backlog (§7.2) — drives the classify button label.
  const unclassifiedCount = await db.seoKeyword.count({ where: { shop, intent: null } });

  // Locale options for the add-form's Select: primary first (value "" — the
  // SeoKeyword convention), then published secondaries by their Shopify code.
  const localeOptions = [
    { locale: "", name: primaryLocale?.name ?? primaryLocale?.locale ?? "", primary: true },
    ...secondaryLocales.map((l: any) => ({ locale: String(l.locale), name: String(l.name), primary: false })),
  ];

  // ── Groups + AI distribution (PLAN_KEYWORDS_EXPANSION.md §5) ──

  // Plan flag for the distribution button (the handler gates server-side
  // again; this only decides whether the button renders as available).
  const settingsRow = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const isPro = meetsPlan((settingsRow?.subscriptionPlan || "free") as Plan, "pro");

  const url = new URL(request.url);
  const loc = url.searchParams.get("loc") ?? "";
  const selectedGroupId = url.searchParams.get("group") || "";

  // Pseudo-group sentinels (§2.1): "Alle" and "Ohne Gruppe" are not real rows —
  // they are read-only views over the active locale's keywords. They are NOT
  // groups, so the group-locale lookup below is skipped for them (they use loc).
  const isPseudoGroup = selectedGroupId === "__all__" || selectedGroupId === "__ungrouped__";

  // A ?group= deeplink implies the active language (§8.6): the group carries
  // its own locale, and a bookmarked group must land in THAT language even if
  // ?loc= says otherwise. Resolve the group's locale up front so the listGroups
  // call below lists the right language's groups.
  let groupLocale: string | null = null;
  if (selectedGroupId && !isPseudoGroup) {
    const g = await db.seoKeywordGroup.findFirst({
      where: { id: selectedGroupId, shop },
      select: { locale: true },
    });
    groupLocale = g ? g.locale : null;
  }
  const activeLocale = groupLocale ?? loc;

  const groups = await listGroups(db, shop, activeLocale);

  // Sidebar counts for the "Alle" / "Ohne Gruppe" pseudo-groups (§2.1), scoped
  // to the active locale — badges without loading the rows.
  const [allCount, ungroupedCount] = await Promise.all([
    countAllKeywords(db, shop, activeLocale),
    countUngrouped(db, shop, activeLocale),
  ]);

  let groupDetail:
    | {
        id: string;
        name: string | null;
        description: string | null;
        locale: string;
        keywords: GroupKeywordRow[];
        pseudo: "all" | "ungrouped" | null;
      }
    | null = null;
  if (selectedGroupId === "__all__") {
    groupDetail = {
      id: "__all__",
      name: null,
      description: null,
      locale: activeLocale,
      keywords: await listAllKeywords(db, shop, activeLocale),
      pseudo: "all",
    };
  } else if (selectedGroupId === "__ungrouped__") {
    groupDetail = {
      id: "__ungrouped__",
      name: null,
      description: null,
      locale: activeLocale,
      keywords: await listUngrouped(db, shop, activeLocale),
      pseudo: "ungrouped",
    };
  } else if (selectedGroupId) {
    const g = groups.find((grp) => grp.id === selectedGroupId);
    if (g) {
      groupDetail = {
        id: g.id,
        name: g.name,
        description: g.description,
        locale: g.locale,
        keywords: await getGroupKeywords(db, shop, g.id),
        pseudo: null,
      };
    }
  }

  // Distribution state: a running task (either stage) blocks new runs and
  // drives the progress banner; otherwise the latest completed suggest task
  // for the selected group (not yet applied) feeds the preview table.
  const runningDistribution = await db.task.findFirst({
    where: { shop, type: "distributeKeywords", status: "running" },
    select: { id: true, fieldType: true, progress: true },
  });
  let distributionPreview: DistributionSuggestResult | null = null;
  let suggestTaskId: string | null = null;
  if (groupDetail && !runningDistribution) {
    const latest = await db.task.findFirst({
      where: { shop, type: "distributeKeywords", fieldType: "suggest", status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { id: true, result: true },
    });
    if (latest?.result) {
      try {
        const parsed = JSON.parse(latest.result) as DistributionSuggestResult;
        if (parsed.groupId === groupDetail.id && !parsed.appliedAt && parsed.suggestions.length > 0) {
          distributionPreview = parsed;
          suggestTaskId = latest.id;
        }
      } catch {
        // Malformed result blob — no preview.
      }
    }
  }

  // Product facets for the distribution modal's optional target filter
  // (plan §5.4 — Product only; the handler filters server-side). Note: the
  // cached Product model has NO vendor column, so the plan's vendor facet is
  // not implementable from the cache — productType only.
  const productTypeRows = await db.product.findMany({
    where: { shop, productType: { not: "" } },
    select: { productType: true },
    distinct: ["productType"],
    orderBy: { productType: "asc" },
    take: 100,
  });
  const productTypes = productTypeRows
    .map((r) => r.productType)
    .filter((p): p is string => !!p);

  return json({
    keywords,
    localeOptions,
    // Active locale for the Locale-Navbar highlight: a ?group= deeplink forces
    // the group's own language, otherwise ?loc= (primary "" by default).
    activeLocale,
    // Research panel: hl codes to offer (primary first, then secondaries).
    primaryLocaleCode: String(primaryLocale?.locale || "en"),
    // Integrated §6.1 spike: cached suggestqueries reachability verdict.
    // Never blocks — a stale verdict triggers a BACKGROUND probe whose
    // result lands in the server logs and in the next load.
    researchAvailability: getSuggestionsAvailability(),
    conflicts,
    unclassifiedCount,
    productTypes,
    isPro,
    groups,
    allCount,
    ungroupedCount,
    groupDetail,
    runningDistribution,
    distributionPreview,
    suggestTaskId,
  });
};

type CsvErrorRow = { row: number; keyword: string; error: string };

export type ActionResult =
  | { ok: true; kind: "saved" | "deleted" | "promoted" | "prioritySet" | "groupCreated" | "groupDeleted" | "groupUpdated" }
  | { ok: true; kind: "csvImported"; added: number; alreadyInGroup: number; csvErrors: CsvErrorRow[] }
  // Bulk assignment (plan §4.1): `applied` writes plus a per-pair skip report.
  // `dryRun` echoes back so the client can tell a preview from a real apply.
  | { ok: true; kind: "assigned"; applied: number; skipped: AssignManySkip[]; dryRun?: boolean }
  | { ok: false; error: "invalid" | "tooMany" | "duplicateName" | "csvEmpty" | "csvTooMany"; existingKeyword?: never }
  // A different keyword already holds the primary role for this (item, locale)
  // — the UI confirms the swap and re-submits with demoteExisting=true.
  | { ok: false; error: "primaryExists"; existingKeyword: string }
  // Cross-item cannibalization pre-check (plan §7.1): this keyword is already
  // primary on ANOTHER item of the same type — the UI confirms and re-submits
  // with acceptCannibalization=true.
  | { ok: false; error: "cannibalization"; existingItemTitle: string };

/** Item-title lookup for the cannibalization confirm message. */
async function lookupItemTitle(
  db: any,
  shop: string,
  resourceType: KeywordResourceType,
  id: string,
): Promise<string> {
  const model =
    resourceType === "Product"
      ? db.product
      : resourceType === "Collection"
        ? db.collection
        : resourceType === "Article"
          ? db.article
          : db.page;
  const row = await model.findFirst({ where: { shop, id }, select: { title: true } });
  return row?.title || id;
}

/** CSV import cap per request (plan §5.3) — anything bigger must be split. */
const MAX_CSV_ROWS = 2000;

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "setKeyword") {
    const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
    const resourceId = getFormString(form, "resourceId");
    const keyword = getFormString(form, "keyword");
    const localeInput = getFormString(form, "locale");
    const roleInput = getFormString(form, "role");
    const role: KeywordRole = roleInput === "secondary" ? "secondary" : "primary";
    const demoteExisting = getFormString(form, "demoteExisting") === "true";
    if (
      !RESOURCE_TYPES.includes(resourceType) ||
      !resourceId ||
      !keyword.trim() ||
      keyword.trim().length > MAX_KEYWORD_LENGTH
    ) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Validate the posted locale server-side against the shop's actual
    // published locales — "" (primary) is always accepted without a lookup.
    let locale = "";
    if (localeInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }
    // Cross-item cannibalization guard (plan §7.1): warn BEFORE creating a
    // primary that already exists as primary on another item of the same
    // type. Bypassed after the merchant confirmed (acceptCannibalization).
    const acceptCannibalization = getFormString(form, "acceptCannibalization") === "true";
    if (role === "primary" && !acceptCannibalization) {
      const elsewhere = await findPrimaryElsewhere(db, session.shop, {
        keyword,
        locale,
        resourceType,
        excludeResourceId: resourceId,
      });
      if (elsewhere) {
        const existingItemTitle = await lookupItemTitle(db, session.shop, resourceType, elsewhere.resourceId);
        return json<ActionResult>({ ok: false, error: "cannibalization", existingItemTitle }, { status: 409 });
      }
    }

    const result = await assignKeyword(db, session.shop, {
      resourceType,
      resourceId,
      keyword,
      locale,
      role,
      demoteExisting,
    });
    if (!result.ok) {
      if (result.reason === "primaryExists") {
        return json<ActionResult>(
          { ok: false, error: "primaryExists", existingKeyword: result.existingKeyword },
          { status: 409 },
        );
      }
      return json<ActionResult>({ ok: false, error: "tooMany" }, { status: 409 });
    }
    return json<ActionResult>({ ok: true, kind: "saved" });
  }

  // ── Bulk assignment (plan §4.1): several keywords × several items ──
  if (actionType === "assignMany") {
    const roleInput = getFormString(form, "role");
    const role: KeywordRole = roleInput === "secondary" ? "secondary" : "primary";
    const demoteExisting = getFormString(form, "demoteExisting") === "true";
    const dryRun = getFormString(form, "dryRun") === "true";

    let keywordIds: unknown;
    let targets: unknown;
    try {
      keywordIds = JSON.parse(getFormString(form, "keywordIds"));
      targets = JSON.parse(getFormString(form, "targets"));
    } catch {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    if (
      !Array.isArray(keywordIds) ||
      !Array.isArray(targets) ||
      keywordIds.length === 0 ||
      targets.length === 0 ||
      keywordIds.length > 500 ||
      targets.length > 500 ||
      !keywordIds.every((id) => typeof id === "string") ||
      !targets.every(
        (t): t is AssignManyTarget =>
          !!t &&
          typeof t === "object" &&
          typeof (t as { resourceId?: unknown }).resourceId === "string" &&
          RESOURCE_TYPES.includes((t as { resourceType?: KeywordResourceType }).resourceType as KeywordResourceType),
      )
    ) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const { applied, skipped } = await assignMany(db, session.shop, {
      keywordIds: keywordIds as string[],
      targets: targets as AssignManyTarget[],
      role,
      demoteExisting,
      dryRun,
    });
    return json<ActionResult>({ ok: true, kind: "assigned", applied, skipped, dryRun });
  }

  if (actionType === "deleteKeyword") {
    const id = getFormString(form, "id");
    if (id) await removeAssignment(db, session.shop, id);
    return json<ActionResult>({ ok: true, kind: "deleted" });
  }

  if (actionType === "makePrimary") {
    const id = getFormString(form, "id");
    if (id) await promoteAssignment(db, session.shop, id);
    return json<ActionResult>({ ok: true, kind: "promoted" });
  }

  // ── Priority (plan §5.2) ──
  if (actionType === "setPriority") {
    const keywordId = getFormString(form, "keywordId");
    const priority = Number(getFormString(form, "priority"));
    if (!keywordId || ![1, 2, 3].includes(priority)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setKeywordPriority(db, session.shop, keywordId, priority);
    return json<ActionResult>({ ok: true, kind: "prioritySet" });
  }

  // ── Groups (plan §5.1) ──
  if (actionType === "createGroup") {
    const name = getFormString(form, "name").trim();
    if (!name || name.length > 100) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Validate the posted locale against the shop's published locales, same as
    // setKeyword/importCsv — "" (primary) is always accepted. Stops a crafted
    // ?loc=/form value from creating a group under an unpublished locale that
    // then has no Locale-Navbar tab (effectively invisible).
    const localeInput = getFormString(form, "locale");
    let locale = "";
    if (localeInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }
    const result = await createGroup(db, session.shop, name, locale, getFormString(form, "description"));
    if (!result.ok) return json<ActionResult>({ ok: false, error: "duplicateName" }, { status: 409 });
    return json<ActionResult>({ ok: true, kind: "groupCreated" });
  }

  if (actionType === "renameGroup") {
    const groupId = getFormString(form, "groupId");
    const name = getFormString(form, "name").trim();
    if (!groupId || !name || name.length > 100) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const result = await renameGroup(db, session.shop, groupId, name);
    if (!result.ok) {
      // notFound (deleted in another tab / foreign id) is a generic error,
      // NOT a misleading duplicate-name message (review L1).
      if (result.reason === "notFound") {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      return json<ActionResult>({ ok: false, error: "duplicateName" }, { status: 409 });
    }
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  if (actionType === "setGroupPriority") {
    const groupId = getFormString(form, "groupId");
    const priority = Number(getFormString(form, "priority"));
    if (!groupId || ![1, 2, 3].includes(priority)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setGroupPriority(db, session.shop, groupId, priority);
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  if (actionType === "deleteGroup") {
    const groupId = getFormString(form, "groupId");
    if (groupId) await deleteGroup(db, session.shop, groupId);
    return json<ActionResult>({ ok: true, kind: "groupDeleted" });
  }

  if (actionType === "removeFromGroup") {
    const groupId = getFormString(form, "groupId");
    const keywordId = getFormString(form, "keywordId");
    if (groupId && keywordId) await removeKeywordFromGroup(db, session.shop, groupId, keywordId);
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  // ── CSV import (plan §5.3): keyword[,priority][,intent][,locale] ──
  if (actionType === "importCsv") {
    const groupId = getFormString(form, "groupId");
    const csv = getFormString(form, "csv");
    if (!groupId || !csv.trim()) {
      return json<ActionResult>({ ok: false, error: "csvEmpty" }, { status: 400 });
    }
    const group = await db.seoKeywordGroup.findFirst({
      where: { id: groupId, shop: session.shop },
      select: { id: true },
    });
    if (!group) return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });

    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const validLocales = new Set<string>(
      shopLocales
        .filter((l: any) => !l.primary && l.published)
        .map((l: any) => String(l.locale).toLowerCase()),
    );
    const parsed = parseKeywordsCsv(csv, validLocales);
    if (parsed.rows.length === 0 && parsed.errors.length === 0) {
      return json<ActionResult>({ ok: false, error: "csvEmpty" }, { status: 400 });
    }
    if (parsed.rows.length > MAX_CSV_ROWS) {
      return json<ActionResult>({ ok: false, error: "csvTooMany" }, { status: 400 });
    }
    // Bulk-paste default priority (§2.1): the KeywordPaste box carries a
    // Select whose value fills in rows that did NOT set an explicit priority
    // column. An explicit per-row priority always wins; parseKeywordsCsv is
    // untouched.
    const defaultPriorityRaw = Number(getFormString(form, "defaultPriority"));
    const defaultPriority = [1, 2, 3].includes(defaultPriorityRaw) ? defaultPriorityRaw : undefined;
    const { added, alreadyInGroup } = await addKeywordsToGroup(
      db,
      session.shop,
      groupId,
      parsed.rows.map((r) => ({
        keyword: r.keyword,
        locale: r.locale,
        priority: r.priority ?? defaultPriority,
        intent: r.intent,
      })),
    );
    return json<ActionResult>({
      ok: true,
      kind: "csvImported",
      added,
      alreadyInGroup,
      csvErrors: parsed.errors.slice(0, 20), // cap the error list the UI shows
    });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

/** Editor list route per resource type — target of the row's "open in editor" deep-link. */
const KEYWORD_TYPE_PATH: Record<KeywordResourceType, string> = {
  Product: "/app/products",
  Collection: "/app/collections",
  Article: "/app/blog",
  Page: "/app/pages",
};

export default function SeoKeywords() {
  const data = useLoaderData<typeof loader>();
  const { keywords, localeOptions } = data;
  const { t, locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const confirm = useConfirm();
  const k = t.seo.keywordsPage;

  const saveFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();

  // Which row's action is in flight — the rowFetcher is shared across rows,
  // so this is what lets us spinner the right button and disable the rest.
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  // Last setKeyword payload, kept for the primary-swap confirm flow: when the
  // server answers `primaryExists`, we confirm with the merchant and re-submit
  // the SAME payload with demoteExisting=true.
  const lastSubmitRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    const data = saveFetcher.data;
    if (data.ok && data.kind === "saved") {
      // The inline "+ Keyword" controls own their own draft state and clear
      // themselves on this success; the Shell only drops the confirm-flow ref.
      lastSubmitRef.current = null;
      return;
    }
    if (!data.ok && data.error === "primaryExists" && lastSubmitRef.current) {
      const payload = lastSubmitRef.current;
      lastSubmitRef.current = null; // one confirm per submission
      const existing = data.existingKeyword;
      void (async () => {
        const ok = await confirm({
          title: k.primarySwapTitle || "Replace primary keyword?",
          message: (
            k.primarySwapBody ||
            `"${existing}" is currently the primary keyword for this item. Demote it to secondary and make "${payload.keyword}" the new primary?`
          )
            .replace("{existing}", existing)
            .replace("{next}", payload.keyword),
          confirmLabel: k.primarySwapConfirm || "Replace",
        });
        if (ok) {
          lastSubmitRef.current = { ...payload, demoteExisting: "true" };
          saveFetcher.submit({ ...payload, demoteExisting: "true" }, { method: "post" });
        }
      })();
      return;
    }
    // Cross-item cannibalization warning (plan §7.1): the keyword is already
    // primary on another item of the same type — confirm before creating a
    // competing primary.
    if (!data.ok && data.error === "cannibalization" && "existingItemTitle" in data && lastSubmitRef.current) {
      const payload = lastSubmitRef.current;
      lastSubmitRef.current = null;
      const existingTitle = data.existingItemTitle;
      void (async () => {
        const ok = await confirm({
          title: k.cannibalizationConfirmTitle || "Keyword already primary elsewhere",
          message: (
            k.cannibalizationConfirmBody ||
            `"{keyword}" is already the primary keyword of "{item}". Two items competing for the same keyword cannibalize each other in Google. Track it here as primary anyway?`
          )
            .replace("{keyword}", payload.keyword)
            .replace("{item}", existingTitle),
          confirmLabel: k.cannibalizationConfirm || "Track anyway",
        });
        if (ok) {
          // Keep the payload stashed — the SAME submit may next hit the
          // same-item primaryExists confirm above.
          lastSubmitRef.current = { ...payload, acceptCannibalization: "true" };
          saveFetcher.submit({ ...payload, acceptCannibalization: "true" }, { method: "post" });
        }
      })();
    }
    // confirm/saveFetcher are stable; k strings don't change mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  useEffect(() => {
    if (rowFetcher.state === "idle") setPendingRowId(null);
  }, [rowFetcher.state]);

  // Per-item inline add (§2.3): the AssignmentsTab's "+ Keyword" control drives
  // this. Locale is fixed to the active language (the top dimension) — the
  // per-form Select/Autocomplete of the old add-form is gone. Still routes
  // through saveFetcher so the primaryExists-swap and cannibalization confirm
  // effects above keep working unchanged.
  const handleAddKeyword = (args: {
    resourceType: KeywordResourceType;
    resourceId: string;
    keyword: string;
    role: KeywordRole;
  }) => {
    const payload: Record<string, string> = {
      actionType: "setKeyword",
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      keyword: args.keyword,
      locale: data.activeLocale,
      role: args.role,
    };
    lastSubmitRef.current = payload;
    saveFetcher.submit(payload, { method: "post" });
  };

  const handleDeleteKeyword = async (row: { id: string; keyword: string }) => {
    const ok = await confirm({
      title: k.deleteConfirmTitle || "Stop tracking this keyword?",
      message:
        k.deleteConfirmBody ||
        `This will remove "${row.keyword}" from tracked keywords. This can't be undone.`,
      confirmLabel: k.delete,
      destructive: true,
    });
    if (!ok) return;
    setPendingRowId(row.id);
    rowFetcher.submit({ actionType: "deleteKeyword", id: row.id }, { method: "post" });
  };

  const handleMakePrimary = (row: { id: string }) => {
    setPendingRowId(row.id);
    rowFetcher.submit({ actionType: "makePrimary", id: row.id }, { method: "post" });
  };

  // ── Groups + distribution state (plan §5) ──
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const groupFetcher = useFetcher<ActionResult>();
  const priorityFetcher = useFetcher<ActionResult>();
  const distFetcher = useFetcher<{ success: boolean; taskId?: string; error?: string; code?: string }>();
  // Bulk assignMany (dry-run + real apply) for the unified assign panel (§4.1).
  const assignFetcher = useFetcher<ActionResult>();

  const [newGroupName, setNewGroupName] = useState("");
  // Unified assign panel (Phase 4b): which keyword set is being assigned, and
  // whether the modal is open. Opened from the three group flows.
  const [assignPanelOpen, setAssignPanelOpen] = useState(false);
  const [assignPanelKeywords, setAssignPanelKeywords] = useState<{ keywordId: string; keyword: string }[]>([]);
  const openAssignPanel = (keywords: { keywordId: string; keyword: string }[]) => {
    setAssignPanelKeywords(keywords);
    setAssignPanelOpen(true);
  };
  const closeAssignPanel = () => setAssignPanelOpen(false);
  // Group rename + bulk priority (plan §5.1).
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [bulkPriority, setBulkPriority] = useState("2");
  // Per-suggestion decision for the preview table; keyed by keyword.
  const [decisions, setDecisions] = useState<Record<string, "accept" | "secondaryOnly" | "reject">>({});
  const [demoteExisting, setDemoteExisting] = useState(false);

  const selectGroup = (groupId: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (groupId) {
          next.set("group", groupId);
          // Group detail lives in the Library tab — a deep group selection
          // must land there even if the Assignments tab is currently active.
          next.set("tab", "library");
        } else {
          next.delete("group");
        }
        return next;
      },
      { preventScrollReset: true },
    );
  };

  // Reset the local form state when the group changes; seed the preview
  // decisions (default: accept at confidence ≥ 0.6, plan §5.4 step 4).
  const previewKey = data.suggestTaskId ?? "";
  useEffect(() => {
    if (!data.distributionPreview) {
      setDecisions({});
      return;
    }
    const seeded: Record<string, "accept" | "secondaryOnly" | "reject"> = {};
    for (const s of data.distributionPreview.suggestions) {
      seeded[s.keyword] = s.primaryItemId && s.confidence >= 0.6 ? "accept" : "reject";
    }
    setDecisions(seeded);
    setDemoteExisting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  // While a distribution task runs, poll the loader so the banner progresses
  // and the preview appears without a manual reload.
  const runningDistId = data.runningDistribution?.id ?? null;
  useEffect(() => {
    if (!runningDistId) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningDistId]);

  // A successful suggest/apply start also needs polling to kick in — the
  // loader only knows about the task after the next revalidate. Starting an AI
  // distribution also closes the assign panel (its onClose already fires, but
  // this covers the apply-stage path that has no panel).
  useEffect(() => {
    if (distFetcher.state === "idle" && distFetcher.data?.success) {
      setAssignPanelOpen(false);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distFetcher.state, distFetcher.data]);

  // A real (non-dryRun) bulk assign closes the panel and refreshes counts;
  // the panel itself shows the applied/skipped banner before the user closes.
  useEffect(() => {
    if (assignFetcher.state !== "idle" || !assignFetcher.data) return;
    const d = assignFetcher.data;
    if (d.ok && d.kind === "assigned" && !d.dryRun) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignFetcher.state, assignFetcher.data]);

  // AI distribution over an explicit item selection (§3): the assign panel
  // hands us the chosen resourceIds + target type. targetType still selects the
  // cache table for the batch; resourceIds narrow it to exactly those items.
  const startDistribution = (opts: {
    resourceIds: string[];
    targetType: KeywordResourceType;
    maxSecondaries: string;
  }) => {
    if (!data.groupDetail) return;
    distFetcher.submit(
      {
        action: "distributeKeywords",
        contentType: "products",
        stage: "suggest",
        groupId: data.groupDetail.id,
        targetType: opts.targetType,
        maxSecondaries: opts.maxSecondaries,
        resourceIds: JSON.stringify(opts.resourceIds),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  const applyDistribution = () => {
    const preview = data.distributionPreview;
    if (!preview || !data.groupDetail) return;
    const localeByKeyword = new Map(data.groupDetail.keywords.map((k) => [k.keyword, k.locale]));
    const rows = preview.suggestions
      // A null-primary row with secondaries is still applyable — the apply
      // stage handles primaryItemId: null and only writes the secondaries.
      .filter(
        (s) =>
          decisions[s.keyword] &&
          decisions[s.keyword] !== "reject" &&
          (s.primaryItemId || s.secondaryItemIds.length > 0),
      )
      .map((s) => ({
        keyword: s.keyword,
        locale: localeByKeyword.get(s.keyword) ?? "",
        primaryItemId: s.primaryItemId,
        secondaryItemIds: s.secondaryItemIds,
        decision: decisions[s.keyword],
      }));
    if (rows.length === 0) return;
    distFetcher.submit(
      {
        action: "distributeKeywords",
        contentType: "products",
        stage: "apply",
        targetType: preview.targetType,
        suggestTaskId: data.suggestTaskId ?? "",
        demoteExisting: demoteExisting ? "true" : "false",
        rows: JSON.stringify(rows),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  const priorityOptions = [
    { label: k.priority?.high || "1 — high", value: "1" },
    { label: k.priority?.medium || "2 — medium", value: "2" },
    { label: k.priority?.low || "3 — low", value: "3" },
  ];

  // ── Keyword research panel (plan §6) ──
  const suggestFetcher = useFetcher<{
    ok: boolean;
    groups?: { direct: string[]; questions: string[]; alphabet: string[] };
    error?: "invalid" | "rateLimited" | "blocked";
  }>();
  const [seedInput, setSeedInput] = useState("");
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [importGroupId, setImportGroupId] = useState("");

  // Research language follows the global active locale (§2.1): no own Select —
  // primary ("") falls back to the shop's primary Shopify code for the hl param.
  const researchHl = data.activeLocale || data.primaryLocaleCode;

  const runResearch = (expandAlphabet: boolean) => {
    if (!seedInput.trim()) return;
    setSelectedSuggestions(new Set());
    suggestFetcher.submit(
      { seed: seedInput, hl: researchHl, expandAlphabet: expandAlphabet ? "true" : "false" },
      { method: "post", action: "/api/keyword-suggestions" },
    );
  };

  const toggleSuggestion = (s: string) => {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const importSelectedSuggestions = () => {
    if (!importGroupId || selectedSuggestions.size === 0) return;
    // Reuse the CSV import path. The keyword locale is OWNED by the target
    // group now (§3.1), so the locale column is ignored server-side — but we
    // still stamp the research locale for backward-compatible files.
    const isSecondary = localeOptions.some((l) => !l.primary && l.locale.toLowerCase() === researchHl.toLowerCase());
    const csv =
      "keyword,locale\n" +
      Array.from(selectedSuggestions)
        .map((s) => `"${s.replace(/"/g, '""')}",${isSecondary ? researchHl.toLowerCase() : ""}`)
        .join("\n");
    groupFetcher.submit({ actionType: "importCsv", groupId: importGroupId, csv }, { method: "post" });
    setSelectedSuggestions(new Set());
  };

  // ── Intent classification + filter (plan §7.2) ──
  const intentFetcher = useFetcher<{ success: boolean; classified?: number; remaining?: number; error?: string }>();

  useEffect(() => {
    if (intentFetcher.state === "idle" && intentFetcher.data?.success) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentFetcher.state, intentFetcher.data]);

  const intentLabel = (intent: string | null | undefined): string | null =>
    intent ? (k.intents as Record<string, string> | undefined)?.[intent] ?? intent : null;

  const openInEditor = (row: { resourceType: string; resourceId: string }) => {
    const path = KEYWORD_TYPE_PATH[row.resourceType as KeywordResourceType];
    if (!path) return;
    handleNavigate(path, { searchParams: new URLSearchParams({ select: row.resourceId }) });
  };

  // Group-detail confirm flows lifted out of the (now presentational) LibraryTab
  // so every stateful/confirm handler stays in the Shell (Phase 1 invariant).
  const handleDeleteGroup = async () => {
    const ok = await confirm({
      title: k.groupDeleteConfirmTitle || "Delete this group?",
      message:
        k.groupDeleteConfirmBody ||
        "Keywords stay tracked; only the group and its memberships are removed.",
      confirmLabel: k.delete,
      destructive: true,
    });
    if (!ok || !data.groupDetail) return;
    selectGroup(null);
    groupFetcher.submit({ actionType: "deleteGroup", groupId: data.groupDetail.id }, { method: "post" });
  };

  const handleApplyBulkPriority = async () => {
    if (!data.groupDetail) return;
    const ok = await confirm({
      title: k.bulkPriorityConfirmTitle || "Set priority for all keywords?",
      message: (
        k.bulkPriorityConfirmBody || "This sets the priority of all {count} keywords in this group."
      ).replace("{count}", String(data.groupDetail.keywords.length)),
      confirmLabel: k.bulkPriorityApply || "Apply to all",
    });
    if (!ok) return;
    groupFetcher.submit(
      { actionType: "setGroupPriority", groupId: data.groupDetail.id, priority: bulkPriority },
      { method: "post" },
    );
  };

  // ── Navbars (Phase 1): Locale-Navbar (top) + tab SubNavBar ──
  const tab = searchParams.get("tab") ?? "library";

  // Locale-Navbar: primary ("" locale) gets a stable sentinel id; the URL param
  // value for primary is "" (i.e. no ?loc=).
  const PRIMARY_LOCALE_ID = "__primary__";
  // Labels are localized exactly like the content (Inhalte) pages'
  // UnifiedLanguageBar: the language name via Intl.DisplayNames in the app
  // locale, plus a "(Hauptsprache)" suffix on the primary. The primary's own
  // code is "" here, so fall back to primaryLocaleCode for its display name.
  const primaryLanguageSuffix = t.content?.primaryLanguageSuffix || "Primary";
  const localeNavItems: SubNavBarItem[] = localeOptions.map((l) => ({
    id: l.primary ? PRIMARY_LOCALE_ID : l.locale,
    label: l.primary
      ? `${getLocalizedLanguageName(data.primaryLocaleCode, appLocale, l.name)} (${primaryLanguageSuffix})`
      : getLocalizedLanguageName(l.locale, appLocale, l.name),
  }));
  const localeActiveId = data.activeLocale === "" ? PRIMARY_LOCALE_ID : data.activeLocale;

  const onLocaleSelect = (item: SubNavBarItem) => {
    const value = item.id === PRIMARY_LOCALE_ID ? "" : item.id;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("loc", value);
        else next.delete("loc");
        // Groups are locale-specific — a group selection must not survive a
        // language switch.
        next.delete("group");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const tabNavItems: SubNavBarItem[] = [
    { id: "library", label: k.tabLibrary },
    { id: "assignments", label: k.tabAssignments },
  ];
  const onTabSelect = (item: SubNavBarItem) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", item.id);
        return next;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <SeoSectionLayout sectionId="keywords">
      <BlockStack gap="400">
        <Banner tone="info" title={k.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{k.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{k.helpBody2}</Text>
          </BlockStack>
        </Banner>

        {/* Locale-Navbar (top): language is the outermost dimension (§2).
            Rendered as Polaris buttons to match the locale bar on the content
            (Inhalte) pages — active locale = primary variant. */}
        <div
          role="navigation"
          aria-label={k.localeNavLabel}
          style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
        >
          {[...localeNavItems]
            .sort((a, b) => {
              if (a.id === PRIMARY_LOCALE_ID) return -1;
              if (b.id === PRIMARY_LOCALE_ID) return 1;
              return a.label.localeCompare(b.label);
            })
            .map((item) => (
              <Button
                key={item.id}
                size="slim"
                variant={item.id === localeActiveId ? "primary" : undefined}
                onClick={() => onLocaleSelect(item)}
              >
                {item.label}
              </Button>
            ))}
        </div>
        {/* Tab SubNavBar: Bibliothek / Zuordnungen. Help icon pinned far right. */}
        <SubNavBar
          ariaLabel={k.tabNavLabel}
          items={tabNavItems}
          activeId={tab}
          onSelect={onTabSelect}
          trailing={<HelpTooltip helpKey="keywordsLibraryTabs" position="below" />}
        />

        {tab === "assignments" ? (
          <AssignmentsTab
            k={k}
            activeLocale={data.activeLocale}
            conflicts={data.conflicts}
            keywords={keywords}
            isPro={data.isPro}
            unclassifiedCount={data.unclassifiedCount}
            intentLabel={intentLabel}
            saveFetcher={saveFetcher}
            rowFetcher={rowFetcher}
            intentFetcher={intentFetcher}
            pendingRowId={pendingRowId}
            handleAddKeyword={handleAddKeyword}
            handleMakePrimary={handleMakePrimary}
            handleDeleteKeyword={handleDeleteKeyword}
            openInEditor={openInEditor}
          />
        ) : (
          <LibraryTab
            k={k}
            groups={data.groups}
            allCount={data.allCount}
            ungroupedCount={data.ungroupedCount}
            groupDetail={data.groupDetail}
            isPro={data.isPro}
            runningDistribution={data.runningDistribution}
            distributionPreview={data.distributionPreview}
            researchAvailability={data.researchAvailability}
            productTypes={data.productTypes}
            localeOptions={localeOptions}
            priorityOptions={priorityOptions}
            intentLabel={intentLabel}
            selectGroup={selectGroup}
            activeLocale={data.activeLocale}
            newGroupName={newGroupName}
            setNewGroupName={setNewGroupName}
            groupFetcher={groupFetcher}
            seedInput={seedInput}
            setSeedInput={setSeedInput}
            suggestFetcher={suggestFetcher}
            runResearch={runResearch}
            selectedSuggestions={selectedSuggestions}
            toggleSuggestion={toggleSuggestion}
            importGroupId={importGroupId}
            setImportGroupId={setImportGroupId}
            importSelectedSuggestions={importSelectedSuggestions}
            isRenaming={isRenaming}
            setIsRenaming={setIsRenaming}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            handleDeleteGroup={handleDeleteGroup}
            handleApplyBulkPriority={handleApplyBulkPriority}
            bulkPriority={bulkPriority}
            setBulkPriority={setBulkPriority}
            priorityFetcher={priorityFetcher}
            distFetcher={distFetcher}
            decisions={decisions}
            setDecisions={setDecisions}
            demoteExisting={demoteExisting}
            setDemoteExisting={setDemoteExisting}
            applyDistribution={applyDistribution}
            assignPanelOpen={assignPanelOpen}
            assignPanelKeywords={assignPanelKeywords}
            openAssignPanel={openAssignPanel}
            closeAssignPanel={closeAssignPanel}
            assignFetcher={assignFetcher}
            startDistribution={startDistribution}
          />
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

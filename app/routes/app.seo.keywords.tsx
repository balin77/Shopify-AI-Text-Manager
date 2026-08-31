/**
 * Keyword tracking section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * Store one target keyword per item and see a local on-page analysis (presence
 * in title/H1/meta/SEO-title/body + density + position). Read-only scoring is
 * computed server-side from the DB content cache via analyzeOnPage. GSC ranking
 * data (Phase 6) plugs into the same rows later.
 */

import type { PrismaClient } from "@prisma/client";
import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator, useNavigation } from "react-router";
import { useEffect, useRef, useState } from "react";
import { BlockStack, InlineStack, Text, Button, Spinner, Card } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { compareStrings } from "../utils/format";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { SubNavBar, type SubNavBarItem } from "../components/nav/SubNavBar";
import { HelpTooltip } from "../components/HelpTooltip";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { LibraryTab } from "../components/seo/keywords/LibraryTab";
import { AssignmentsTab, ASSIGNMENT_TYPE_ORDER } from "../components/seo/keywords/AssignmentsTab";
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
  findPrimaryElsewhere,
  findCannibalizationConflicts,
  getGroupKeywords,
  countAllKeywords,
  listAllKeywords,
  countUngrouped,
  listUngrouped,
  addKeywordsToGroup,
  getKeywordQuota,
  removeKeywordFromGroup,
  deleteKeyword,
  createKeyword,
  renameKeyword,
  moveKeyword,
  setKeywordPriority,
  setKeywordPriorities,
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
import type { DataResponse } from "~/types/data-response";

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

interface ItemContent {
  title: string;
  seoTitle: string;
  metaDescription: string;
  bodyHtml: string;
}

/**
 * The "Zuordnungen" half of the page's data: every tracked assignment, its
 * item content resolved from the cache, the on-page analysis per row, the
 * cannibalization conflicts.
 *
 * Split out of the loader so it only runs for the tab that renders it — it
 * reads four content tables plus the translation table and analyzes every row,
 * and paying that on every Library-tab click (and on every mutation's
 * revalidation) is what made the page feel like it reloaded wholesale.
 */
async function loadAssignmentsData(db: PrismaClient, shop: string, primaryLocaleCode: string) {
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
        // Global rows only — a market override would collide with the global
        // row on the same (resourceId, key, locale) and the last one read would
        // silently win the analysis.
        marketId: "",
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
      localeDisplay: row.locale || primaryLocaleCode,
      itemTitle: c?.title ?? "",
      itemMissing: !c,
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

  return { keywords, conflicts };
}

/** Shape of the Zuordnungen half — also the type of the empty stand-in the
 *  loader returns while the Bibliothek tab is active. */
type AssignmentsData = Awaited<ReturnType<typeof loadAssignmentsData>>;

const EMPTY_ASSIGNMENTS: AssignmentsData = { keywords: [], conflicts: [] };

/**
 * The "Bibliothek" half: groups, the selected group's keywords, the sidebar
 * counts and the AI-distribution task state. Counterpart to
 * loadAssignmentsData — only the active tab's half is loaded per request.
 */
async function loadLibraryData(
  db: PrismaClient,
  shop: string,
  activeLocale: string,
  selectedGroupId: string,
) {
  const groups = await listGroups(db, shop, activeLocale);

  // Every group of the shop, across ALL languages — the move dialog's target
  // picker needs the OTHER languages' groups, which `groups` (scoped to the
  // active locale) deliberately doesn't list.
  const allGroups = (
    await db.seoKeywordGroup.findMany({
      where: { shop },
      select: { id: true, name: true, locale: true },
      orderBy: { name: "asc" },
    })
  ).map((g) => ({ id: g.id, name: g.name, locale: g.locale }));

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
  // (not yet applied) feeds the review section at the top of the tab.
  //
  // Deliberately NOT scoped to the selected group any more: a merchant who
  // starts a distribution, clicks somewhere else and comes back had no way of
  // finding the pending suggestions again — they only reappeared once the
  // exact source group happened to be selected. Unreviewed suggestions are a
  // pending decision and belong at the top of the page regardless of the
  // sidebar selection.
  const runningDistribution = await db.task.findFirst({
    where: { shop, type: "distributeKeywords", status: "running" },
    select: { id: true, fieldType: true, progress: true },
  });
  let distributionPreview: DistributionSuggestResult | null = null;
  let suggestTaskId: string | null = null;
  // Every keyword of a group shares the group's language (§3.1), so ONE locale
  // covers the whole preview — the apply stage needs it to address the right
  // keyword rows and can no longer read it off the selected group.
  let distributionPreviewLocale = "";
  if (!runningDistribution) {
    const latest = await db.task.findFirst({
      where: { shop, type: "distributeKeywords", fieldType: "suggest", status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { id: true, result: true },
    });
    if (latest?.result) {
      try {
        const parsed = JSON.parse(latest.result) as DistributionSuggestResult;
        if (!parsed.appliedAt && parsed.suggestions.length > 0) {
          // A preview whose group has since been deleted is stale: its
          // keywords are gone with the memberships and there is no language to
          // apply them under. Drop it rather than showing undeadable rows.
          const sourceGroup = await db.seoKeywordGroup.findFirst({
            where: { id: parsed.groupId, shop },
            select: { locale: true },
          });
          if (sourceGroup) {
            distributionPreview = parsed;
            suggestTaskId = latest.id;
            distributionPreviewLocale = sourceGroup.locale;
          }
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

  return {
    groups,
    allGroups,
    allCount,
    ungroupedCount,
    groupDetail,
    runningDistribution,
    distributionPreview,
    distributionPreviewLocale,
    suggestTaskId,
    productTypes,
  };
}

/** Shape of the Bibliothek half — also the type of the empty stand-in the
 *  loader returns while the Zuordnungen tab is active. */
type LibraryData = Awaited<ReturnType<typeof loadLibraryData>>;

const EMPTY_LIBRARY: LibraryData = {
  groups: [],
  allGroups: [],
  allCount: 0,
  ungroupedCount: 0,
  groupDetail: null,
  runningDistribution: null,
  distributionPreview: null,
  distributionPreviewLocale: "",
  suggestTaskId: null,
  productTypes: [],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const url = new URL(request.url);
  const loc = url.searchParams.get("loc") ?? "";
  const selectedGroupId = url.searchParams.get("group") || "";
  // Which half of the page's data this request actually needs. The two tabs
  // render disjoint data sets and BOTH are expensive, so loading both on every
  // request meant every group click, language switch and mutation paid for
  // work nothing on screen was going to show. Keep the default in sync with
  // the component's `tab` default ("library").
  const tab = url.searchParams.get("tab") === "assignments" ? "assignments" : "library";

  // Pseudo-group sentinels (§2.1): "Alle" and "Ohne Gruppe" are not real rows —
  // they are read-only views over the active locale's keywords. They are NOT
  // groups, so the group-locale lookup below is skipped for them (they use loc).
  const isPseudoGroup = selectedGroupId === "__all__" || selectedGroupId === "__ungrouped__";

  // The three preliminaries every request needs, in one round trip:
  //  - shop locales (60s-cached) drive the Locale-Navbar and the per-row
  //    translated-content analysis. The primary locale is stored as "" in
  //    SeoKeyword (existing convention); its real Shopify code is display-only.
  //  - the plan flag for the distribution/classify buttons (the handlers gate
  //    server-side again; this only decides whether they render as available).
  //  - a ?group= deeplink implies the active language (§8.6): the group carries
  //    its own locale, and a bookmarked group must land in THAT language even
  //    if ?loc= says otherwise, so the group's locale is resolved before the
  //    half below lists that language's groups.
  const [shopLocales, settingsRow, groupRow] = await Promise.all([
    getCachedShopLocales(admin, shop),
    db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } }),
    selectedGroupId && !isPseudoGroup
      ? db.seoKeywordGroup.findFirst({
          where: { id: selectedGroupId, shop },
          select: { locale: true },
        })
      : Promise.resolve(null),
  ]);

  const primaryLocale = shopLocales.find((l: any) => l.primary);
  const secondaryLocales = shopLocales.filter((l: any) => !l.primary && l.published);

  // Locale options for the language pickers: primary first (value "" — the
  // SeoKeyword convention), then published secondaries by their Shopify code.
  const localeOptions = [
    { locale: "", name: primaryLocale?.name ?? primaryLocale?.locale ?? "", primary: true },
    ...secondaryLocales.map((l: any) => ({ locale: String(l.locale), name: String(l.name), primary: false })),
  ];

  const activeLocale = groupRow ? groupRow.locale : loc;
  const isPro = meetsPlan((settingsRow?.subscriptionPlan || "free") as Plan, "pro");

  const [assignments, library] = await Promise.all([
    tab === "assignments"
      ? loadAssignmentsData(db, shop, String(primaryLocale?.locale || ""))
      : Promise.resolve(EMPTY_ASSIGNMENTS),
    tab === "library"
      ? loadLibraryData(db, shop, activeLocale, selectedGroupId)
      : Promise.resolve(EMPTY_LIBRARY),
  ]);

  return json({
    tab,
    ...assignments,
    ...library,
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
    isPro,
    // Plan keyword quota (§Plan-Matrix): drives the usage line, the disabled
    // "add" control and the over-cap banner after a downgrade. Existing rows
    // are never deleted for it — see keywords.service.ts.
    keywordQuota: await getKeywordQuota(db, shop),
  });
};

type CsvErrorRow = { row: number; keyword: string; error: string };

export type ActionResult =
  | { ok: true; kind: "saved" | "deleted" | "promoted" | "prioritySet" | "groupCreated" | "groupDeleted" | "groupUpdated" }
  | {
      ok: true;
      kind: "csvImported";
      added: number;
      alreadyInGroup: number;
      /** Rows dropped because the shop's plan keyword quota ran out. */
      skippedOverQuota: number;
      csvErrors: CsvErrorRow[];
    }
  // Inline table editing: a row added under an auto-generated name (the client
  // opens it in edit mode), and a row renamed in place.
  | { ok: true; kind: "keywordCreated"; keywordId: string; keyword: string }
  | { ok: true; kind: "keywordRenamed"; keywordId: string; keyword: string }
  // The keywords themselves are gone, not just their assignments. Bulk since
  // the library table's actions all act on the checkbox selection.
  | { ok: true; kind: "keywordsDeleted"; deleted: number; removedAssignments: number }
  // Move to another group and/or language (§ "keyword is stuck in the language
  // it was first tracked in"). The counters report what happened to the
  // keywords' item assignments on a language change, summed over the selection.
  | {
      ok: true;
      kind: "keywordsMoved";
      targetLocale: string;
      targetGroupId: string | null;
      moved: number;
      failed: number;
      movedAssignments: number;
      demoted: number;
      droppedAssignments: number;
    }
  // Bulk assignment (plan §4.1): `applied` writes plus a per-pair skip report.
  // `dryRun` echoes back so the client can tell a preview from a real apply.
  | { ok: true; kind: "assigned"; applied: number; skipped: AssignManySkip[]; dryRun?: boolean }
  | {
      ok: false;
      // "planLimit" = the shop's plan keyword quota is exhausted (distinct from
      // "tooMany", the per-item cap).
      error: "invalid" | "tooMany" | "planLimit" | "duplicateName" | "csvEmpty" | "csvTooMany";
      existingKeyword?: never;
    }
  // An inline rename would collide with a keyword this language already has.
  // Never merged silently — see renameKeyword. `keywordId` lets the table
  // re-open the right cell instead of dropping the merchant's text.
  | { ok: false; error: "duplicateKeyword"; keywordId: string }
  // The checkbox selection exceeds what one bulk request may carry. Distinct
  // from "invalid" so the UI can name the limit instead of going quiet.
  | { ok: false; error: "tooManySelected"; max: number }
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

/**
 * Upper bound for one bulk selection. The delete/move/remove actions loop one
 * transaction PER id, so they stay at the assignMany cap; setting a priority is
 * a single `updateMany`, so it may span a whole imported group (MAX_CSV_ROWS)
 * — otherwise "select all, set priority" is unreachable in exactly the group
 * that most needs it.
 */
const MAX_BULK_IDS = 500;
const MAX_PRIORITY_IDS = 2000;

/**
 * Read a JSON array of keyword ids from the form. The library table's actions
 * are all selection-driven now, so every one of them posts through this.
 *
 * "Too many" is reported apart from "malformed": an import allows 2000 rows,
 * so a merchant CAN tick more than the cap in one group, and a bare 400 would
 * make the button look broken instead of saying what the limit is.
 */
type KeywordIdList = { ok: true; ids: string[] } | { ok: false; reason: "invalid" | "tooMany" };

function parseKeywordIds(form: FormData, max = MAX_BULK_IDS): KeywordIdList {
  let raw: unknown;
  try {
    raw = JSON.parse(getFormString(form, "keywordIds"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "invalid" };
  if (!raw.every((id): id is string => typeof id === "string" && id.length > 0)) {
    return { ok: false, reason: "invalid" };
  }
  // A selection can legitimately carry a duplicate after a revalidation race;
  // de-duplicate BEFORE the cap so a duplicate can't push a legal selection over.
  const ids = Array.from(new Set(raw as string[]));
  if (ids.length > max) return { ok: false, reason: "tooMany" };
  return { ok: true, ids };
}

/** Turn a rejected id list into the matching action response. */
function keywordIdsError(reason: "invalid" | "tooMany", max = MAX_BULK_IDS) {
  return reason === "tooMany"
    ? json<ActionResult>({ ok: false, error: "tooManySelected", max }, { status: 400 })
    : json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
}

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
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

  // Priority over the checkbox SELECTION — the group-wide variant is gone, so
  // this is the one bulk priority path and it reads the same id list as every
  // other selection action.
  if (actionType === "setPriorityForKeywords") {
    const parsed = parseKeywordIds(form, MAX_PRIORITY_IDS);
    if (!parsed.ok) return keywordIdsError(parsed.reason, MAX_PRIORITY_IDS);
    const priority = Number(getFormString(form, "priority"));
    if (![1, 2, 3].includes(priority)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setKeywordPriorities(db, session.shop, parsed.ids, priority);
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

  if (actionType === "deleteGroup") {
    const groupId = getFormString(form, "groupId");
    if (groupId) await deleteGroup(db, session.shop, groupId);
    return json<ActionResult>({ ok: true, kind: "groupDeleted" });
  }

  // ── Inline table editing: add one row, rename one row ──
  if (actionType === "createKeyword") {
    const groupIdRaw = getFormString(form, "groupId");
    const localeInput = getFormString(form, "locale");
    // The pseudo views own no membership — a keyword added there is created
    // outside any group, under the language the view is scoped to.
    const isPseudo = groupIdRaw === "__all__" || groupIdRaw === "__ungrouped__";
    const groupId = groupIdRaw && !isPseudo ? groupIdRaw : null;

    // Only a group-less create carries a locale of its own; with a group the
    // group owns it. Same published-locale rule as everywhere else.
    let locale = "";
    if (!groupId && localeInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }

    const result = await createKeyword(db, session.shop, { groupId, locale });
    if (!result.ok) {
      // The plan quota gets its own error so the table can say "upgrade or
      // delete one" instead of a generic failure.
      return json<ActionResult>(
        { ok: false, error: result.reason === "planLimit" ? "planLimit" : "invalid" },
        { status: result.reason === "planLimit" ? 409 : 400 },
      );
    }
    return json<ActionResult>({
      ok: true,
      kind: "keywordCreated",
      keywordId: result.keywordId,
      keyword: result.keyword,
    });
  }

  if (actionType === "renameKeyword") {
    const keywordId = getFormString(form, "keywordId");
    const keyword = getFormString(form, "keyword");
    if (!keywordId) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const result = await renameKeyword(db, session.shop, keywordId, keyword);
    if (!result.ok) {
      if (result.reason === "duplicate") {
        return json<ActionResult>({ ok: false, error: "duplicateKeyword", keywordId }, { status: 409 });
      }
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    return json<ActionResult>({
      ok: true,
      kind: "keywordRenamed",
      keywordId: result.keywordId,
      keyword: result.keyword,
    });
  }

  // Delete the selected keywords outright (assignments + memberships cascade).
  // Distinct from `deleteKeyword` above, which drops ONE assignment.
  if (actionType === "deleteKeywords") {
    const parsed = parseKeywordIds(form);
    if (!parsed.ok) return keywordIdsError(parsed.reason);
    const keywordIds = parsed.ids;
    let deleted = 0;
    let removedAssignments = 0;
    // Sequential on purpose: deleteKeyword runs its own transaction and the
    // selection is bounded by MAX_BULK_IDS, so a serial loop keeps the write
    // pressure predictable instead of opening 500 concurrent transactions.
    for (const keywordId of keywordIds) {
      const result = await deleteKeyword(db, session.shop, keywordId);
      if (result.ok) {
        deleted += 1;
        removedAssignments += result.removedAssignments;
      }
    }
    return json<ActionResult>({ ok: true, kind: "keywordsDeleted", deleted, removedAssignments });
  }

  // ── Move the selected keywords to another group and/or language ──
  if (actionType === "moveKeywords") {
    const parsed = parseKeywordIds(form);
    if (!parsed.ok) return keywordIdsError(parsed.reason);
    const keywordIds = parsed.ids;
    const fromGroupId = getFormString(form, "fromGroupId");
    const targetGroupIdRaw = getFormString(form, "targetGroupId");
    const targetLocaleInput = getFormString(form, "targetLocale");
    // Same locale rule as setKeyword/createGroup: "" (primary) is free, every
    // other value must be a published secondary of THIS shop.
    let targetLocale = "";
    if (targetLocaleInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === targetLocaleInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      targetLocale = targetLocaleInput;
    }
    // The pseudo groups ("Alle"/"Ohne Gruppe") are views, not memberships —
    // never pass their sentinel id to the service as a source group.
    const isPseudo = (id: string) => id === "__all__" || id === "__ungrouped__";
    const targetGroupId = targetGroupIdRaw && !isPseudo(targetGroupIdRaw) ? targetGroupIdRaw : null;
    let moved = 0;
    let failed = 0;
    let movedAssignments = 0;
    let demoted = 0;
    let droppedAssignments = 0;
    for (const keywordId of keywordIds) {
      const result = await moveKeyword(db, session.shop, {
        keywordId,
        fromGroupId: fromGroupId && !isPseudo(fromGroupId) ? fromGroupId : null,
        targetLocale,
        targetGroupId,
      });
      // One unmovable keyword (stale id, group/locale mismatch) must not abort
      // the rest of the selection — it is counted and reported instead.
      if (!result.ok) {
        failed += 1;
        continue;
      }
      moved += 1;
      movedAssignments += result.movedAssignments;
      demoted += result.demoted;
      droppedAssignments += result.droppedAssignments;
    }
    return json<ActionResult>({
      ok: true,
      kind: "keywordsMoved",
      targetLocale,
      targetGroupId,
      moved,
      failed,
      movedAssignments,
      demoted,
      droppedAssignments,
    });
  }

  if (actionType === "removeKeywordsFromGroup") {
    const groupId = getFormString(form, "groupId");
    const parsed = parseKeywordIds(form);
    if (!parsed.ok) return keywordIdsError(parsed.reason);
    if (!groupId) return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    for (const keywordId of parsed.ids) {
      await removeKeywordFromGroup(db, session.shop, groupId, keywordId);
    }
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  // ── CSV import (plan §5.3): keyword[,priority][,locale] ──
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
    // Bulk-paste default priority (§2.1): the import modal carries a
    // Select whose value fills in rows that did NOT set an explicit priority
    // column. An explicit per-row priority always wins; parseKeywordsCsv is
    // untouched.
    const defaultPriorityRaw = Number(getFormString(form, "defaultPriority"));
    const defaultPriority = [1, 2, 3].includes(defaultPriorityRaw) ? defaultPriorityRaw : undefined;
    const { added, alreadyInGroup, skippedOverQuota } = await addKeywordsToGroup(
      db,
      session.shop,
      groupId,
      parsed.rows.map((r) => ({
        keyword: r.keyword,
        locale: r.locale,
        priority: r.priority ?? defaultPriority,
      })),
    );
    return json<ActionResult>({
      ok: true,
      kind: "csvImported",
      added,
      alreadyInGroup,
      skippedOverQuota,
      csvErrors: parsed.errors.slice(0, 20), // cap the error list the UI shows
    });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

/**
 * A library-table row as the selection-driven actions need it. The library
 * table's actions (zuordnen / verschieben / entfernen / löschen) live in the
 * bar above the table and act on the checkbox selection, so every one of them
 * is handed a list of these instead of a single row.
 */
export interface SelectedKeyword {
  keywordId: string;
  keyword: string;
  locale: string;
  assignmentCount: number;
}

export type KeywordSelection = SelectedKeyword[];

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
  const navigation = useNavigation();
  const groupFetcher = useFetcher<ActionResult>();
  const priorityFetcher = useFetcher<ActionResult>();
  const distFetcher = useFetcher<{ success: boolean; taskId?: string; error?: string; code?: string }>();
  // Bulk assignMany (dry-run + real apply) for the unified assign panel (§4.1).
  const assignFetcher = useFetcher<ActionResult>();

  const [newGroupName, setNewGroupName] = useState("");
  // ── Inline keyword editing (add a row, rename a row) ──
  // Which row's name is open for editing, and the rejection the server sent
  // for it. Both live here because a freshly CREATED row must open in edit
  // mode, and only this component sees the create action's answer.
  // Two fetchers on purpose: clicking "+ Keyword" while a cell is open first
  // triggers that cell's blur-commit. On ONE fetcher the create submission
  // would abort the in-flight rename and the merchant's edit would vanish
  // without a trace.
  const keywordEditFetcher = useFetcher<ActionResult>();
  const keywordCreateFetcher = useFetcher<ActionResult>();
  const [editingKeywordId, setEditingKeywordId] = useState<string | null>(null);
  const [editKeywordError, setEditKeywordError] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [assignmentType, setAssignmentType] = useState<KeywordResourceType>("Product");

  const startEditKeyword = (keywordId: string) => {
    setEditKeywordError(null);
    setEditingKeywordId(keywordId);
  };
  const cancelEditKeyword = () => {
    setEditKeywordError(null);
    setEditingKeywordId(null);
  };
  const commitEditKeyword = (keywordId: string, keyword: string) => {
    setEditKeywordError(null);
    keywordEditFetcher.submit({ actionType: "renameKeyword", keywordId, keyword }, { method: "post" });
  };
  const handleCreateKeyword = () => {
    if (!data.groupDetail) return;
    keywordCreateFetcher.submit(
      {
        actionType: "createKeyword",
        // A pseudo view has no group to join — the action maps the sentinel to
        // "no group" and uses the locale instead.
        groupId: data.groupDetail.id,
        locale: data.activeLocale,
      },
      { method: "post" },
    );
  };

  // A new row opens for editing under its generated name.
  useEffect(() => {
    if (keywordCreateFetcher.state !== "idle" || !keywordCreateFetcher.data) return;
    const d = keywordCreateFetcher.data;
    if (d.ok && d.kind === "keywordCreated") {
      setEditKeywordError(null);
      setEditingKeywordId(d.keywordId);
    } else if (!d.ok && d.error === "planLimit") {
      // The quota can run out between the loader's snapshot and the click (a
      // second tab, an import). Without this the button just did nothing.
      setEditKeywordError(k.keywordPlanLimitShort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordCreateFetcher.state, keywordCreateFetcher.data]);

  // A successful rename closes the cell; a name the language already carries
  // keeps it open WITH the reason, so the merchant can correct it in place
  // rather than losing what they typed.
  useEffect(() => {
    if (keywordEditFetcher.state !== "idle" || !keywordEditFetcher.data) return;
    const d = keywordEditFetcher.data;
    if (d.ok && d.kind === "keywordRenamed") {
      setEditKeywordError(null);
      setEditingKeywordId(null);
      return;
    }
    if (!d.ok && d.error === "duplicateKeyword") {
      setEditingKeywordId(d.keywordId);
      setEditKeywordError(k.duplicateKeyword);
      return;
    }
    if (!d.ok) setEditKeywordError(k.errorGeneric);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordEditFetcher.state, keywordEditFetcher.data]);
  // Unified assign panel (Phase 4b): which keyword set is being assigned, and
  // whether the modal is open. Opened from the three group flows.
  const [assignPanelOpen, setAssignPanelOpen] = useState(false);
  const [assignPanelKeywords, setAssignPanelKeywords] = useState<{ keywordId: string; keyword: string }[]>([]);
  const openAssignPanel = (keywords: { keywordId: string; keyword: string }[]) => {
    setAssignPanelKeywords(keywords);
    setAssignPanelOpen(true);
  };
  const closeAssignPanel = () => setAssignPanelOpen(false);
  // Move the SELECTED keywords to another group and/or language. Lives in the
  // Shell like every other stateful flow; LibraryTab only renders the dialog.
  const moveFetcher = useFetcher<ActionResult>();
  const [moveModal, setMoveModal] = useState<KeywordSelection | null>(null);
  const [moveTargetLocale, setMoveTargetLocale] = useState("");
  const [moveTargetGroupId, setMoveTargetGroupId] = useState("");
  const openMoveModal = (rows: KeywordSelection) => {
    if (rows.length === 0) return;
    setMoveModal(rows);
    // Every row in a group view shares the group's language, so the first
    // row's locale is the selection's locale.
    setMoveTargetLocale(rows[0].locale);
    // Pre-select the group the keywords are being viewed in (a pseudo group is
    // a view, not a membership — it pre-selects "no group").
    setMoveTargetGroupId(data.groupDetail && !data.groupDetail.pseudo ? data.groupDetail.id : "");
  };
  const closeMoveModal = () => setMoveModal(null);

  // Delete the selected keywords for good. The confirm names the collateral
  // damage — assignments and their ranking history cascade with them.
  const handleDeleteKeywords = async (rows: KeywordSelection) => {
    if (rows.length === 0) return;
    const assignments = rows.reduce((sum, r) => sum + r.assignmentCount, 0);
    const single = rows.length === 1;
    const ok = await confirm({
      title: (single ? k.keywordDeleteConfirmTitle : k.keywordsDeleteConfirmTitle).replace(
        "{count}",
        String(rows.length),
      ),
      message: (single
        ? assignments > 0
          ? k.keywordDeleteConfirmBodyAssigned
          : k.keywordDeleteConfirmBody
        : assignments > 0
          ? k.keywordsDeleteConfirmBodyAssigned
          : k.keywordsDeleteConfirmBody
      )
        .replace("{keyword}", rows[0].keyword)
        .replace("{count}", String(single ? assignments : rows.length))
        .replace("{assignments}", String(assignments)),
      confirmLabel: k.delete,
      destructive: true,
    });
    if (!ok) return;
    groupFetcher.submit(
      { actionType: "deleteKeywords", keywordIds: JSON.stringify(rows.map((r) => r.keywordId)) },
      { method: "post" },
    );
  };

  // Drop the selected keywords out of THIS group. They survive as long as they
  // are assigned to an item or sit in another group — an orphan is deleted by
  // removeKeywordFromGroup, which is what the confirm warns about.
  const handleRemoveKeywordsFromGroup = async (rows: KeywordSelection) => {
    if (rows.length === 0 || !data.groupDetail || data.groupDetail.pseudo) return;
    const ok = await confirm({
      title: k.keywordsRemoveConfirmTitle.replace("{count}", String(rows.length)),
      message: k.keywordsRemoveConfirmBody.replace("{count}", String(rows.length)),
      confirmLabel: k.groupRemoveKeyword,
    });
    if (!ok) return;
    groupFetcher.submit(
      {
        actionType: "removeKeywordsFromGroup",
        groupId: data.groupDetail.id,
        keywordIds: JSON.stringify(rows.map((r) => r.keywordId)),
      },
      { method: "post" },
    );
  };

  const submitMove = () => {
    if (!moveModal) return;
    moveFetcher.submit(
      {
        actionType: "moveKeywords",
        keywordIds: JSON.stringify(moveModal.map((r) => r.keywordId)),
        fromGroupId: data.groupDetail?.id ?? "",
        targetLocale: moveTargetLocale,
        targetGroupId: moveTargetGroupId,
      },
      { method: "post" },
    );
  };

  // Group rename + bulk priority (plan §5.1).
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
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

  // Seed the review decisions ONCE per suggestion batch (default: accept at
  // confidence ≥ 0.6, plan §5.4 step 4).
  //
  // Keyed on the task id in a ref rather than on a render-derived key: the
  // loader only builds the library half, so on the Zuordnungen tab there is no
  // preview at all. Re-seeding on that transition — or on the way back — would
  // silently throw away every ✓/✕ the merchant had already clicked.
  const seededSuggestTaskRef = useRef<string | null>(null);
  useEffect(() => {
    const preview = data.distributionPreview;
    const taskId = data.suggestTaskId;
    if (!preview || !taskId) return;
    if (seededSuggestTaskRef.current === taskId) return;
    seededSuggestTaskRef.current = taskId;
    // Pre-accept the confident ones (plan §5.4 step 4) and leave the rest
    // UNDECIDED rather than pre-rejected: the panel's three buckets treat a
    // missing entry as "zu prüfen", so the uncertain suggestions land where
    // they get looked at instead of silently starting out as rejected.
    const seeded: Record<string, "accept" | "secondaryOnly" | "reject"> = {};
    for (const s of preview.suggestions) {
      if (s.primaryItemId && s.confidence >= 0.6) seeded[s.keyword] = "accept";
    }
    setDecisions(seeded);
    setDemoteExisting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.suggestTaskId, data.distributionPreview]);

  // While a distribution task runs, poll the loader so the banner progresses
  // and the preview appears without a manual reload.
  const runningDistId = data.runningDistribution?.id ?? null;
  useEffect(() => {
    if (!runningDistId) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningDistId]);

  // Starting an AI distribution closes the assign panel (its onClose already
  // fires, but this covers the apply-stage path that has no panel). No
  // revalidate here: the fetcher POST that started the task already
  // revalidated this route's loader, so the running task is picked up by that
  // load and the interval above takes over from there. Firing another one
  // would just load the same data twice per click.
  useEffect(() => {
    if (distFetcher.state === "idle" && distFetcher.data?.success) {
      setAssignPanelOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distFetcher.state, distFetcher.data]);

  // A successful move follows the keywords: the Locale-Navbar switches to the
  // target language and the target group is selected, so the merchant sees
  // where they landed instead of watching them vanish from the current view.
  // The search-param change already re-runs the loader for the new view — no
  // extra revalidate on top of it.
  useEffect(() => {
    if (moveFetcher.state !== "idle" || !moveFetcher.data) return;
    const d = moveFetcher.data;
    if (!d.ok || d.kind !== "keywordsMoved") return;
    // Nothing actually moved (every id stale or its group/locale mismatched):
    // keep the dialog open with the failure instead of closing it and
    // navigating to a target group where nothing arrived.
    if (d.moved === 0) return;
    setMoveModal(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (d.targetLocale) next.set("loc", d.targetLocale);
        else next.delete("loc");
        if (d.targetGroupId) next.set("group", d.targetGroupId);
        else next.delete("group");
        return next;
      },
      { preventScrollReset: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveFetcher.state, moveFetcher.data]);

  // AI distribution over an explicit item selection (§3): the assign panel
  // hands us the chosen resourceIds + target type. targetType still selects the
  // cache table for the batch; resourceIds narrow it to exactly those items.
  const startDistribution = (opts: {
    resourceIds: string[];
    keywordIds: string[];
    targetType: KeywordResourceType;
    maxSecondaries: string;
  }) => {
    // A pseudo view's id is a sentinel, not a group row — the panel offers
    // manual mode only there, and this is the second half of that guard.
    if (!data.groupDetail || data.groupDetail.pseudo) return;
    distFetcher.submit(
      {
        action: "distributeKeywords",
        contentType: "products",
        stage: "suggest",
        groupId: data.groupDetail.id,
        targetType: opts.targetType,
        maxSecondaries: opts.maxSecondaries,
        resourceIds: JSON.stringify(opts.resourceIds),
        // The panel is opened from a checkbox selection, so the run is scoped
        // to those keywords; the handler intersects them with the group's own.
        keywordIds: JSON.stringify(opts.keywordIds),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  const applyDistribution = () => {
    const preview = data.distributionPreview;
    // No longer gated on the SELECTED group: the review section is now at the
    // top of the tab and applies whatever the last run suggested, whatever the
    // sidebar shows. Every keyword of a group shares the group's language
    // (§3.1), so the loader hands over that one locale.
    if (!preview) return;
    const locale = data.distributionPreviewLocale;
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
        locale,
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

  /**
   * Priority for the checkbox SELECTION — the replacement for the old
   * "apply to ALL keywords in this group" block that sat under the table with
   * its own Select and its own confirm. No confirm: priority is a cheap,
   * visible, reversible attribute, and the merchant picked the exact rows.
   */
  const handleSetPriorityForSelection = (keywordIds: string[], priority: string) => {
    if (keywordIds.length === 0) return;
    groupFetcher.submit(
      { actionType: "setPriorityForKeywords", keywordIds: JSON.stringify(keywordIds), priority },
      { method: "post" },
    );
  };

  // ── Navbars (Phase 1): Locale-Navbar (top) + tab SubNavBar ──
  // Read from the loader, not from the search params: the loader only fetches
  // the active tab's data, so the rendered tab must be the one the data was
  // loaded for. (A navigation resolves before the new params are visible here,
  // so the two never disagree — this just makes that guarantee explicit.)
  const tab = data.tab;

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

  // Any load that will replace what is on screen: a ?tab=/?group=/?loc= switch
  // (navigation) or the revalidation after a write. Drives the local busy hint
  // that replaced the layout's full-section skeleton.
  const isReloading = navigation.state !== "idle" || revalidator.state === "loading";

  const tabNavItems: SubNavBarItem[] = [
    { id: "library", label: k.tabLibrary },
    { id: "assignments", label: k.tabAssignments },
  ];

  // The Zuordnungen list's resource-type dimension. Owned here rather than by
  // the tab so its bar can sit in the SAME card as the tab bar — and kept as
  // React state rather than a search param, because the filter is applied
  // client-side over rows that are already loaded; a param would re-run the
  // (expensive) assignments loader on every type click for no new data.
  const typeNavItems: SubNavBarItem[] = ASSIGNMENT_TYPE_ORDER.map((rt) => ({
    id: rt,
    label: k.types[rt],
  }));
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
        <SeoHelpBanner title={k.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{k.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{k.helpBody2}</Text>
            {/* Why there is no search-volume column. Without this the gap reads
                as a missing feature rather than a decision, which is exactly
                how a merchant comparing app listings would read it. */}
            <Text as="p" variant="bodyMd">{k.helpBodyVolume}</Text>
          </BlockStack>
        </SeoHelpBanner>

        {/* Locale-Navbar (top): language is the outermost dimension (§2).
            Rendered as Polaris buttons to match the locale bar on the content
            (Inhalte) pages — active locale = primary variant. Hidden on a
            single-language shop, where it would be one permanently-active
            button (same rule as the content editor's language bar). */}
        {localeNavItems.length > 1 && (
        <div
          role="navigation"
          aria-label={k.localeNavLabel}
          style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
        >
          {[...localeNavItems]
            .sort((a, b) => {
              if (a.id === PRIMARY_LOCALE_ID) return -1;
              if (b.id === PRIMARY_LOCALE_ID) return 1;
              return compareStrings(a.label, b.label, appLocale);
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
        )}
        {/* Tab SubNavBar: Bibliothek / Zuordnungen. Help icon pinned far right. */}
        {/* The section no longer unmounts into a skeleton on a ?tab=/?group=/
            ?loc= switch (app.seo.tsx), which is what made every click feel
            like a page reload — but the loads behind those switches are real
            and the assignments half is deliberately expensive. So the feedback
            is local: a spinner in the tab bar and a dimmed, non-interactive
            body, with the previous content still on screen underneath. */}
        {/* Both navigation levels in ONE card: the tab bar's own bottom border
            is the rule separating it from the type bar below, and the type bar
            is level3 (flat sub-tabs, active state marked by an underline only)
            so it reads as subordinate to the tabs rather than as a second,
            equal-weight card. `padding="0"` lets both bars span the full card
            width; the level3 bar gets the level2 bar's own inline padding back
            so their labels line up. */}
        <Card padding="0">
          <SubNavBar
            ariaLabel={k.tabNavLabel}
            items={tabNavItems}
            activeId={tab}
            onSelect={onTabSelect}
            trailing={
              <InlineStack gap="200" blockAlign="center">
                {isReloading && <Spinner size="small" accessibilityLabel={k.loading} />}
                <HelpTooltip helpKey="keywordsLibraryTabs" position="below" />
              </InlineStack>
            }
          />
          {tab === "assignments" && (
            <div style={{ paddingInline: "1rem" }}>
              <SubNavBar
                ariaLabel={k.listTitle}
                items={typeNavItems}
                activeId={assignmentType}
                onSelect={(item) => setAssignmentType(item.id as KeywordResourceType)}
                variant="level3"
              />
            </div>
          )}
        </Card>

        <div
          style={{
            opacity: isReloading ? 0.55 : 1,
            pointerEvents: isReloading ? "none" : undefined,
            transition: "opacity 120ms ease",
          }}
          aria-busy={isReloading}
        >
        {tab === "assignments" ? (
          <AssignmentsTab
            k={k}
            activeLocale={data.activeLocale}
            activeType={assignmentType}
            conflicts={data.conflicts}
            keywords={keywords}
            saveFetcher={saveFetcher}
            rowFetcher={rowFetcher}
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
            allGroups={data.allGroups}
            allCount={data.allCount}
            ungroupedCount={data.ungroupedCount}
            groupDetail={data.groupDetail}
            isPro={data.isPro}
            keywordQuota={data.keywordQuota}
            runningDistribution={data.runningDistribution}
            distributionPreview={data.distributionPreview}
            researchAvailability={data.researchAvailability}
            productTypes={data.productTypes}
            localeOptions={localeOptions}
            priorityOptions={priorityOptions}
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
            handleSetPriorityForSelection={handleSetPriorityForSelection}
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
            moveModal={moveModal}
            openMoveModal={openMoveModal}
            closeMoveModal={closeMoveModal}
            moveTargetLocale={moveTargetLocale}
            setMoveTargetLocale={setMoveTargetLocale}
            moveTargetGroupId={moveTargetGroupId}
            setMoveTargetGroupId={setMoveTargetGroupId}
            submitMove={submitMove}
            moveFetcher={moveFetcher}
            handleDeleteKeywords={handleDeleteKeywords}
            handleRemoveKeywordsFromGroup={handleRemoveKeywordsFromGroup}
            editingKeywordId={editingKeywordId}
            startEditKeyword={startEditKeyword}
            cancelEditKeyword={cancelEditKeyword}
            commitEditKeyword={commitEditKeyword}
            editKeywordError={editKeywordError}
            handleCreateKeyword={handleCreateKeyword}
            keywordEditFetcher={keywordEditFetcher}
            importModalOpen={importModalOpen}
            openImportModal={() => setImportModalOpen(true)}
            closeImportModal={() => setImportModalOpen(false)}
          />
        )}
        </div>
      </BlockStack>
    </SeoSectionLayout>
  );
}
